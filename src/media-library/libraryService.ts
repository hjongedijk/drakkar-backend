import { dirname } from "node:path";
import { unlink } from "node:fs/promises";
import type { MediaLibraryItem } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { addNzbFromPath, findReusableDownload } from "../downloads/downloadService.js";
import { downloadNzb } from "../indexers/nzbhydra/client.js";
import { fetchMediaMetadata } from "../metadata/metadataService.js";
import { createBlocklistItem, isReleaseBlocklisted } from "../policies/policyService.js";
import { toPublicReleases } from "../releases/public.js";
import type { Release } from "../releases/types.js";
import { runSearch } from "../search/searchService.js";
import { getSettings } from "../settings/settingsStore.js";
import { mediaIdentityKey } from "./identity.js";
import { resolveImportMedia } from "../symlinks/symlinkService.js";

let refreshPromise: Promise<{ refreshed: number; items: Awaited<ReturnType<typeof listLibraryItems>> }> | null = null;
let refreshQueued = false;

function sortTitle(title: string) {
  return title.replace(/^(the|a|an)\s+/i, "").toLowerCase();
}

async function mapWithConcurrency<TInput, TOutput>(
  input: TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>
) {
  const output = new Array<TOutput>(input.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, input.length || 1)) }, async () => {
    while (nextIndex < input.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      output[currentIndex] = await mapper(input[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return output;
}

function statusFromRequest(status: string, hasFilesystemEntry = false) {
  if (status === "grabbed") return "grabbed";
  if (status === "available") return hasFilesystemEntry ? "available" : "grabbed";
  if (status === "no_release_found") return "missing";
  if (status.includes("failed") || status.includes("rejected") || status.includes("blocklisted")) return "failed";
  if (status === "approved") return "searching";
  return "requested";
}

function healthFromStatus(status: string) {
  if (status === "available") return "healthy";
  if (status.includes("duplicate")) return "duplicate";
  if (status.includes("no_video")) return "no_video_content";
  if (status.includes("failed")) return "import_failed";
  return "unknown";
}

function selectedReleaseField(selectedRelease: unknown, key: string) {
  if (!selectedRelease || typeof selectedRelease !== "object") return undefined;
  const value = (selectedRelease as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function selectedReleaseBoolean(selectedRelease: unknown, key: string) {
  if (!selectedRelease || typeof selectedRelease !== "object") return false;
  return Boolean((selectedRelease as Record<string, unknown>)[key]);
}

function importStrategy(status?: string | null) {
  return status === "ok" ? "symlink" : status ?? undefined;
}

function shouldHideLibraryItem(item: MediaLibraryItem) {
  const releaseStyleTitle = /\bS\d{1,2}E\d{1,4}(?:E\d{1,4}|[- .]E?\d{1,4})?\b/i.test(item.title)
    && /\b(2160p|1080p|720p|web-?dl|webrip|bluray|h\.?264|x264|x265|hevc|ddp|dts)\b/i.test(item.title);
  const suspiciousTitle = /&quot;|^\s*\d+\]\s*|^[a-z0-9]{20,}$/i.test(item.title) || releaseStyleTitle;
  const hasMetadata = Boolean(item.requestId || item.tmdbId || item.tvdbId || item.imdbId || item.posterUrl || item.backdropUrl);
  return item.sourceKey.startsWith("import:") && suspiciousTitle && !hasMetadata;
}

export async function listLibraryItems() {
  const items = await prisma.mediaLibraryItem.findMany({
    where: {
      OR: [{ sourceKey: { startsWith: "import:" } }, { sourceKey: { startsWith: "request:" } }]
    },
    orderBy: [{ libraryStatus: "asc" }, { sortTitle: "asc" }, { createdAt: "desc" }]
  });
  return items.filter((item) => !shouldHideLibraryItem(item));
}

export function getLibraryItem(id: string) {
  return prisma.mediaLibraryItem.findUniqueOrThrow({ where: { id } });
}

export async function searchLibraryItemReplacements(id: string) {
  const item = await getLibraryItem(id);
  const releases = await runSearch(searchParamsForLibraryItem(item));
  return { item, releases: toPublicReleases(releases) };
}

export async function deleteLibraryItem(id: string, options: { blocklist?: boolean; reason?: string } = {}) {
  const item = await getLibraryItem(id);
  if (!item.sourceKey.startsWith("import:")) throw new Error("library item is not an imported item");
  const importId = item.sourceKey.replace("import:", "");
  const imported = await prisma.importItem.findUnique({
    where: { id: importId },
    include: { symlinks: true, download: true }
  });
  if (!imported) {
    await prisma.mediaLibraryItem.delete({ where: { id } }).catch(() => undefined);
    return { deleted: true, item };
  }

  if (options.blocklist && imported.download?.title) {
    await createBlocklistItem({
      title: imported.download.title,
      guid: imported.download.nzbDocumentId ?? undefined,
      reason: "manual",
      source: options.reason ?? "library-delete"
    }).catch(() => undefined);
  }

  for (const link of imported.symlinks) {
    await unlink(link.linkPath).catch(() => undefined);
  }
  await prisma.importItem.delete({ where: { id: importId } });
  await prisma.mediaLibraryItem.deleteMany({ where: { OR: [{ id }, { sourceKey: item.sourceKey }] } });

  if (imported.downloadId) {
    const remainingImports = await prisma.importItem.count({ where: { downloadId: imported.downloadId } });
    if (remainingImports === 0) {
      await prisma.download.update({ where: { id: imported.downloadId }, data: { status: "replaced", error: null } }).catch(() => undefined);
    }
  }
  if (imported.requestId) {
    await prisma.mediaRequest.update({
      where: { id: imported.requestId },
      data: { status: "approved", downloadId: null }
    }).catch(() => undefined);
  }

  void refreshMediaLibrary().catch(() => undefined);
  return { deleted: true, item };
}

export async function autoReplaceLibraryItem(id: string) {
  const { releases } = await searchLibraryItemReplacements(id);
  const candidates = [];
  for (const release of releases) {
    if (!(await isReleaseBlocklisted(release))) candidates.push(release);
  }
  if (candidates.length === 0) throw new Error("no replacement releases found");
  return replaceLibraryItemWithRelease(id, candidates[0]);
}

export async function replaceLibraryItemWithRelease(id: string, release: unknown) {
  const item = await getLibraryItem(id);
  await deleteLibraryItem(id, { blocklist: true, reason: "library-replace" });
  const settings = await getSettings();
  const typedRelease = release as Release;
  if (await isReleaseBlocklisted(typedRelease)) throw new Error("selected release is blocklisted");
  const reusable = await findReusableDownload({
    guid: typedRelease.guid ? String(typedRelease.guid) : undefined,
    title: typedRelease.title
  });
  const download = reusable
    ?? await (async () => {
      const nzb = await downloadNzb(settings, typedRelease);
      return addNzbFromPath(nzb.primaryPath, typedRelease.title, { guid: typedRelease.guid ? String(typedRelease.guid) : undefined });
    })();
  if (item.requestId) {
    await prisma.mediaRequest.update({
      where: { id: item.requestId },
      data: {
        status: download.status === "failed" ? "release_failed" : "grabbed",
        selectedRelease: JSON.parse(JSON.stringify(typedRelease)),
        downloadId: download.status === "failed" ? null : download.id
      }
    }).catch(() => undefined);
  }
  await refreshMediaLibrary();
  return { replaced: true, item, release: typedRelease, download };
}

function searchParamsForLibraryItem(item: MediaLibraryItem) {
  const base = {
    query: item.title,
    imdbId: item.imdbId ?? undefined,
    tmdbId: item.tmdbId ?? undefined,
    tvdbId: item.tvdbId ?? undefined
  };
  if (item.mediaType === "tv" && item.season && item.episode) return { ...base, kind: "episode" as const, season: item.season, episode: item.episode };
  if (item.mediaType === "tv" && item.season) return { ...base, kind: "season" as const, season: item.season };
  return { ...base, kind: item.mediaType === "tv" ? "tv" as const : "movie" as const };
}

export function markLibraryItemStreamedByPath(path: string) {
  return prisma.mediaLibraryItem.updateMany({
    where: {
      filePath: path,
      libraryStatus: "available"
    },
    data: {
      lastStreamedAt: new Date(),
      streamCount: { increment: 1 }
    }
  });
}

async function runLibraryRefreshCycle() {
  const touched = new Set<string>();
  const settings = await getSettings();
  const providers = await prisma.requestProvider.findMany();
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  const imports = await prisma.importItem.findMany({ include: { symlinks: { orderBy: { updatedAt: "desc" } } } });
  const importRequestIds = new Set(imports.map((item) => item.requestId).filter((value): value is string => Boolean(value)));
  const importDownloadIds = new Set(imports.map((item) => item.downloadId).filter((value): value is string => Boolean(value)));

  const requests = await prisma.mediaRequest.findMany({ include: { provider: true } });
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const sourceKeys = [
    ...requests.map((request) => `request:${request.id}`),
    ...imports.map((item) => `import:${item.id}`)
  ];
  const existingLibraryItems = sourceKeys.length > 0
    ? await prisma.mediaLibraryItem.findMany({ where: { sourceKey: { in: sourceKeys } } })
    : [];
  const existingBySourceKey = new Map(existingLibraryItems.map((item) => [item.sourceKey, item]));
  const requestItems = await mapWithConcurrency(requests, 12, async (request) => {
    const sourceKey = `request:${request.id}`;
    touched.add(sourceKey);
    const hasFilesystemEntry = importRequestIds.has(request.id) || (request.downloadId ? importDownloadIds.has(request.downloadId) : false);
    return prisma.mediaLibraryItem.upsert({
      where: { sourceKey },
      update: {
        mediaType: request.mediaType,
        title: request.title,
        sortTitle: sortTitle(request.title),
        year: request.year,
        tmdbId: request.tmdbId,
        tvdbId: request.tvdbId,
        imdbId: request.imdbId,
        requestedBy: request.requestedBy,
        requestProvider: request.provider?.name ?? (request.providerId ? providerNames.get(request.providerId) : undefined),
        requestId: request.id,
        qualityProfileId: request.selectedProfileId,
        downloadId: request.downloadId,
        libraryStatus: statusFromRequest(request.status, hasFilesystemEntry),
        healthStatus: healthFromStatus(request.status),
        quality: request.requestedQuality ?? selectedReleaseField(request.selectedRelease, "resolution"),
        source: selectedReleaseField(request.selectedRelease, "source"),
        codec: selectedReleaseField(request.selectedRelease, "codec"),
        audio: selectedReleaseField(request.selectedRelease, "audio"),
        hdr: selectedReleaseBoolean(request.selectedRelease, "hdr"),
        dv: selectedReleaseBoolean(request.selectedRelease, "dv"),
        releaseGroup: selectedReleaseField(request.selectedRelease, "releaseGroup")
      },
      create: {
        sourceKey,
        mediaType: request.mediaType,
        title: request.title,
        sortTitle: sortTitle(request.title),
        year: request.year,
        tmdbId: request.tmdbId,
        tvdbId: request.tvdbId,
        imdbId: request.imdbId,
        requestedBy: request.requestedBy,
        requestProvider: request.provider?.name ?? undefined,
        requestId: request.id,
        qualityProfileId: request.selectedProfileId,
        downloadId: request.downloadId,
        libraryStatus: statusFromRequest(request.status, hasFilesystemEntry),
        healthStatus: healthFromStatus(request.status),
        quality: request.requestedQuality ?? selectedReleaseField(request.selectedRelease, "resolution"),
        source: selectedReleaseField(request.selectedRelease, "source"),
        codec: selectedReleaseField(request.selectedRelease, "codec"),
        audio: selectedReleaseField(request.selectedRelease, "audio"),
        hdr: selectedReleaseBoolean(request.selectedRelease, "hdr"),
        dv: selectedReleaseBoolean(request.selectedRelease, "dv"),
        releaseGroup: selectedReleaseField(request.selectedRelease, "releaseGroup")
      }
    });
  });

  const importItems = await mapWithConcurrency(imports, 12, async (item) => {
    const resolved = await resolveImportMedia(item).catch(() => null);
    const request = item.requestId ? requestsById.get(item.requestId) ?? null : null;
    const link = item.symlinks[0];
    const strategy = importStrategy(link?.status);
    const sourceKey = `import:${item.id}`;
    touched.add(sourceKey);
    const existing = existingBySourceKey.get(sourceKey);
    const title = request?.title ?? resolved?.title ?? existing?.title ?? item.title;
    const year = request?.year ?? resolved?.year ?? existing?.year ?? item.year;
    return prisma.mediaLibraryItem.upsert({
      where: { sourceKey },
      update: {
        mediaType: resolved?.mediaType ?? item.mediaType,
        title,
        sortTitle: sortTitle(title),
        year,
        tmdbId: request?.tmdbId ?? existing?.tmdbId ?? undefined,
        tvdbId: request?.tvdbId ?? existing?.tvdbId ?? undefined,
        imdbId: request?.imdbId ?? existing?.imdbId ?? undefined,
        season: resolved?.season ?? item.season,
        episode: resolved?.episode ?? item.episode,
        requestId: item.requestId,
        downloadId: item.downloadId,
        requestedBy: request?.requestedBy,
        requestProvider: request?.provider?.name,
        qualityProfileId: request?.selectedProfileId,
        importStrategy: strategy,
        libraryStatus: "available",
        streamStatus: item.completedPath.startsWith("/mounted/") ? "streamable" : "local",
        healthStatus: link?.status === "broken" ? "symlink_broken" : "healthy",
        folderPath: link?.linkPath ? dirname(link.linkPath) : dirname(item.completedPath),
        filePath: item.completedPath,
        symlinkPath: strategy === "symlink" ? link?.linkPath : undefined,
        strmPath: strategy === "strm" ? link?.linkPath : undefined
      },
      create: {
        sourceKey,
        mediaType: resolved?.mediaType ?? item.mediaType,
        title,
        sortTitle: sortTitle(title),
        year,
        tmdbId: request?.tmdbId ?? existing?.tmdbId ?? undefined,
        tvdbId: request?.tvdbId ?? existing?.tvdbId ?? undefined,
        imdbId: request?.imdbId ?? existing?.imdbId ?? undefined,
        season: resolved?.season ?? item.season,
        episode: resolved?.episode ?? item.episode,
        requestId: item.requestId,
        downloadId: item.downloadId,
        requestedBy: request?.requestedBy,
        requestProvider: request?.provider?.name,
        qualityProfileId: request?.selectedProfileId,
        importStrategy: strategy,
        libraryStatus: "available",
        streamStatus: item.completedPath.startsWith("/mounted/") ? "streamable" : "local",
        healthStatus: link?.status === "broken" ? "symlink_broken" : "healthy",
        folderPath: link?.linkPath ? dirname(link.linkPath) : dirname(item.completedPath),
        filePath: item.completedPath,
        symlinkPath: strategy === "symlink" ? link?.linkPath : undefined,
        strmPath: strategy === "strm" ? link?.linkPath : undefined
      }
    });
  });

  const metadataCandidates = [...requestItems, ...importItems];
  await mapWithConcurrency(metadataCandidates, 6, async (item) => enrichLibraryItem(item, settings).catch(() => item));

  await prisma.mediaLibraryItem.deleteMany({
    where: {
      OR: [
        { sourceKey: { startsWith: "download:" } },
        { sourceKey: { startsWith: "mount:" } },
        {
          sourceKey: { startsWith: "request:" },
          NOT: { sourceKey: { in: [...touched].filter((key) => key.startsWith("request:")) } }
        },
        {
          sourceKey: { startsWith: "import:" },
          NOT: { sourceKey: { in: [...touched].filter((key) => key.startsWith("import:")) } }
        }
      ]
    }
  });

  await dedupeLibraryItems();

  return { refreshed: touched.size, items: await listLibraryItems() };
}

export async function refreshMediaLibrary() {
  if (refreshPromise) {
    refreshQueued = true;
    return refreshPromise;
  }

  refreshPromise = (async () => {
    let result = await runLibraryRefreshCycle();
    while (refreshQueued) {
      refreshQueued = false;
      result = await runLibraryRefreshCycle();
    }
    return result;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

function libraryItemPriority(item: MediaLibraryItem) {
  const statusWeight: Record<string, number> = {
    available: 600,
    grabbed: 500,
    searching: 400,
    requested: 300,
    approved: 250,
    missing: 200,
    failed: 100
  };
  const sourceWeight = item.sourceKey.startsWith("import:") ? 40 : 0;
  const fileWeight = item.filePath ? 20 : 0;
  const requestWeight = item.requestId ? 10 : 0;
  return (statusWeight[item.libraryStatus] ?? 0) + sourceWeight + fileWeight + requestWeight;
}

async function dedupeLibraryItems() {
  const items = await prisma.mediaLibraryItem.findMany({
    where: {
      OR: [{ sourceKey: { startsWith: "import:" } }, { sourceKey: { startsWith: "request:" } }]
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
  });
  const seen = new Map<string, MediaLibraryItem>();
  const duplicateIds: string[] = [];
  for (const item of items) {
    const key = mediaIdentityKey({
      mediaType: item.mediaType,
      title: item.title,
      year: item.year,
      tmdbId: item.tmdbId,
      tvdbId: item.tvdbId,
      imdbId: item.imdbId,
      season: item.season,
      episode: item.episode
    });
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      continue;
    }
    if (libraryItemPriority(item) > libraryItemPriority(existing)) {
      duplicateIds.push(existing.id);
      seen.set(key, item);
      continue;
    }
    duplicateIds.push(item.id);
  }
  if (duplicateIds.length === 0) return;
  await prisma.mediaLibraryItem.deleteMany({ where: { id: { in: duplicateIds } } });
}

async function enrichLibraryItem(item: MediaLibraryItem, settings: Awaited<ReturnType<typeof getSettings>>) {
  if (!settings.tmdbApiKey && !settings.tvdbApiKey) return item;
  if (!shouldRefreshMetadata(item, settings.metadataCacheTtlHours)) return item;

  const metadata = await fetchMediaMetadata(settings, {
    mediaType: item.mediaType,
    title: item.title,
    year: item.year,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    imdbId: item.imdbId,
    season: item.season,
    episode: item.episode
  });
  if (!metadata) return item;

  const data = {
      tmdbId: metadata.tmdbId ?? item.tmdbId,
      tvdbId: metadata.tvdbId ?? item.tvdbId,
      imdbId: metadata.imdbId ?? item.imdbId,
      title: metadata.title ?? item.title,
      sortTitle: sortTitle(metadata.title ?? item.title),
      year: metadata.year ?? item.year,
      posterUrl: metadata.posterUrl ?? item.posterUrl,
      backdropUrl: metadata.backdropUrl ?? item.backdropUrl,
      overview: metadata.overview ?? item.overview,
      metadataProvider: metadata.metadataProvider ?? item.metadataProvider,
      metadataUpdatedAt: new Date(),
      episodeTitle: metadata.episodeTitle ?? item.episodeTitle,
      episodeOverview: metadata.episodeOverview ?? item.episodeOverview,
      episodeAirDate: metadata.episodeAirDate ?? item.episodeAirDate
    };

  const updated = await prisma.mediaLibraryItem.updateMany({
    where: { id: item.id },
    data
  });
  if (updated.count === 0) return item;
  return (await prisma.mediaLibraryItem.findUnique({ where: { id: item.id } })) ?? item;
}

function shouldRefreshMetadata(item: MediaLibraryItem, ttlHours: number) {
  if (!item.year) return true;
  if ((item.title.toLowerCase().includes("unknown") || item.title.trim().length < 2) && !item.tmdbId && !item.imdbId && !item.tvdbId) return true;
  if (item.mediaType === "tv" && item.season != null && item.episode != null && !item.episodeTitle) return true;
  if (!item.posterUrl && !item.overview && (item.mediaType === "movie" || item.mediaType === "tv")) return true;
  if (!item.metadataUpdatedAt) return true;
  return Date.now() - item.metadataUpdatedAt.getTime() > ttlHours * 60 * 60 * 1000;
}

export async function libraryStats() {
  const items = await listLibraryItems();
  const byStatus = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.libraryStatus] = (acc[item.libraryStatus] ?? 0) + 1;
    return acc;
  }, {});
  const byHealth = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.healthStatus] = (acc[item.healthStatus] ?? 0) + 1;
    return acc;
  }, {});
  return { total: items.length, byStatus, byHealth };
}
