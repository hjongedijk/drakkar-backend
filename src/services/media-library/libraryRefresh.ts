import { dirname } from "node:path";
import { prisma, type MediaLibraryItem } from "../../repositories/db/prisma.js";
import { mediaIdentityKey } from "./identity.js";
import { hydrateLegacyMediaFields, hydrateLegacyRequestFields, normalizeTmdbImagePath } from "./normalizedMedia.js";
import { resolveImportMedia } from "../symlinkService.js";
import { fetchMediaMetadata } from "../metadataService.js";
import { getSettings } from "../settings/settingsStore.js";
import {
  LIBRARY_LIST_SELECT,
  REQUEST_LIBRARY_RELATION_SELECT,
  mapWithConcurrency,
  healthFromStatus,
  importStrategy,
  libraryItemPriority,
  selectedReleaseBoolean,
  selectedReleaseField,
  sortTitle,
  statusFromRequestAndDownload
} from "./libraryShared.js";
import { listLibraryItems } from "./libraryQueries.js";

let refreshPromise: Promise<{ refreshed: number; items: Awaited<ReturnType<typeof listLibraryItems>> }> | null = null;
let refreshQueued = false;

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

function shouldRefreshMetadata(item: Pick<MediaLibraryItem, "title" | "year" | "tmdbId" | "imdbId" | "tvdbId" | "mediaType" | "updatedAt"> & {
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
  posterUrl?: string | null;
  overview?: string | null;
}, ttlHours: number) {
  if (!item.year) return true;
  if ((item.title.toLowerCase().includes("unknown") || item.title.trim().length < 2) && !item.tmdbId && !item.imdbId && !item.tvdbId) return true;
  if (item.mediaType === "tv" && item.season != null && item.episode != null && !item.episodeTitle) return true;
  if (!item.posterUrl && !item.overview && (item.mediaType === "movie" || item.mediaType === "tv")) return true;
  return Date.now() - item.updatedAt.getTime() > ttlHours * 60 * 60 * 1000;
}

async function enrichLibraryItem(item: MediaLibraryItem, settings: Awaited<ReturnType<typeof getSettings>>) {
  const current = await prisma.mediaLibraryItem.findUnique({
    where: { id: item.id },
    select: LIBRARY_LIST_SELECT
  }).then((value) => value ? hydrateLegacyMediaFields(value) : null);
  const base = current ?? item;

  if (!settings.tmdbApiKey && !settings.tvdbApiKey) return base;
  if (!shouldRefreshMetadata(base, settings.metadataCacheTtlHours)) return base;

  const metadata = await fetchMediaMetadata(settings, {
    mediaType: base.mediaType,
    title: base.title,
    year: base.year,
    tmdbId: base.tmdbId,
    tvdbId: base.tvdbId,
    imdbId: base.imdbId,
    season: base.season,
    episode: base.episode
  });
  if (!metadata) return base;

  await prisma.$transaction(async (tx) => {
    if (base.movieId) {
      await tx.movie.update({
        where: { id: base.movieId },
        data: {
          tmdbId: metadata.tmdbId ?? base.tmdbId ?? undefined,
          tvdbId: metadata.tvdbId ?? base.tvdbId ?? undefined,
          imdbId: metadata.imdbId ?? base.imdbId ?? undefined,
          title: metadata.title ?? base.title,
          year: metadata.year ?? base.year,
          posterPath: normalizeTmdbImagePath(metadata.posterUrl) ?? undefined,
          backdropPath: normalizeTmdbImagePath(metadata.backdropUrl) ?? undefined,
          overview: metadata.overview ?? undefined
        }
      }).catch(() => undefined);
      return;
    }
    if (base.tvShowId) {
      await tx.tvShow.update({
        where: { id: base.tvShowId },
        data: {
          tmdbId: metadata.tmdbId ?? base.tmdbId ?? undefined,
          tvdbId: metadata.tvdbId ?? base.tvdbId ?? undefined,
          imdbId: metadata.imdbId ?? base.imdbId ?? undefined,
          title: metadata.title ?? base.title,
          year: metadata.year ?? base.year,
          posterPath: normalizeTmdbImagePath(metadata.posterUrl) ?? undefined,
          backdropPath: normalizeTmdbImagePath(metadata.backdropUrl) ?? undefined,
          overview: metadata.overview ?? undefined
        }
      }).catch(() => undefined);
    }
    if (base.seasonId) {
      await tx.tvSeason.update({
        where: { id: base.seasonId },
        data: {
          title: current?.seasonTarget?.title ?? undefined,
          overview: metadata.overview ?? current?.seasonTarget?.overview ?? undefined,
          airDate: current?.seasonTarget?.airDate ?? undefined,
          posterPath: normalizeTmdbImagePath(metadata.posterUrl) ?? current?.seasonTarget?.posterPath ?? undefined
        }
      }).catch(() => undefined);
    }
    if (base.episodeId) {
      await tx.tvEpisode.update({
        where: { id: base.episodeId },
        data: {
          tmdbId: metadata.tmdbId ?? base.tmdbId ?? undefined,
          tvdbId: metadata.tvdbId ?? base.tvdbId ?? undefined,
          imdbId: metadata.imdbId ?? base.imdbId ?? undefined,
          title: metadata.episodeTitle ?? current?.episodeTarget?.title ?? base.title,
          overview: metadata.episodeOverview ?? current?.episodeTarget?.overview ?? undefined,
          airDate: metadata.episodeAirDate ?? current?.episodeTarget?.airDate ?? undefined,
          stillPath: normalizeTmdbImagePath(metadata.backdropUrl) ?? current?.episodeTarget?.stillPath ?? undefined
        }
      }).catch(() => undefined);
    }
  }).catch(() => undefined);

  return (await prisma.mediaLibraryItem.findUnique({
    where: { id: item.id },
    select: LIBRARY_LIST_SELECT
  }).then((value) => value ? hydrateLegacyMediaFields(value) : null)) ?? base;
}

async function runLibraryRefreshCycle(options?: { includeItems?: boolean }) {
  const touched = new Set<string>();
  const settings = await getSettings();
  const providers = await prisma.requestProvider.findMany();
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  const imports = await prisma.importItem.findMany({
    include: {
      symlinks: { orderBy: { updatedAt: "desc" } },
      mediaFiles: {
        select: {
          movieId: true,
          episodeId: true,
          episode: {
            select: {
              seasonId: true,
              tvShowId: true
            }
          }
        }
      }
    }
  });
  const importRequestIds = new Set(imports.map((item) => item.requestId).filter((value): value is string => Boolean(value)));
  const importDownloadIds = new Set(imports.map((item) => item.downloadId).filter((value): value is string => Boolean(value)));

  const requests = (await prisma.mediaRequest.findMany({
    include: {
      provider: true,
      ...REQUEST_LIBRARY_RELATION_SELECT
    }
  })).map((request) => hydrateLegacyRequestFields(request));
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const requestDownloadIds = [...new Set(requests.map((request) => request.downloadId).filter((value): value is string => Boolean(value)))];
  const requestDownloads = requestDownloadIds.length > 0
    ? await prisma.download.findMany({ where: { id: { in: requestDownloadIds } }, select: { id: true, status: true } })
    : [];
  const requestDownloadsById = new Map(requestDownloads.map((download) => [download.id, download]));
  const existingLibraryItems = (await prisma.mediaLibraryItem.findMany({
    where: {
      OR: [{ sourceKey: { startsWith: "import:" } }, { sourceKey: { startsWith: "request:" } }]
    },
    select: LIBRARY_LIST_SELECT
  })).map((item) => hydrateLegacyMediaFields(item));
  const existingByIdentity = new Map(existingLibraryItems.map((item) => [item.identityKey, item]));
  const touchedIds = new Set<string>();

  const requestItems = await mapWithConcurrency(requests, 12, async (request) => {
    const sourceKey = `request:${request.id}`;
    const hasFilesystemEntry = importRequestIds.has(request.id) || (request.downloadId ? importDownloadIds.has(request.downloadId) : false);
    const linkedDownload = request.downloadId ? requestDownloadsById.get(request.downloadId) ?? null : null;
    const nextLibraryStatus = statusFromRequestAndDownload({
      requestStatus: request.status,
      downloadStatus: linkedDownload?.status,
      hasFilesystemEntry
    });
    const identityKey = mediaIdentityKey({
      mediaType: request.mediaType,
      title: request.title,
      year: request.year,
      tmdbId: request.tmdbId,
      tvdbId: request.tvdbId,
      imdbId: request.imdbId
    });
    await prisma.mediaLibraryItem.deleteMany({
      where: {
        sourceKey,
        identityKey: { not: identityKey }
      }
    });
    const row = await prisma.mediaLibraryItem.upsert({
      where: { identityKey },
      update: {
        sourceKey,
        identityKey,
        mediaType: request.mediaType,
        movieId: request.movieId,
        tvShowId: request.tvShowId,
        seasonId: request.seasonId,
        episodeId: request.episodeId,
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
        libraryStatus: nextLibraryStatus,
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
        identityKey,
        mediaType: request.mediaType,
        movieId: request.movieId,
        tvShowId: request.tvShowId,
        seasonId: request.seasonId,
        episodeId: request.episodeId,
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
        libraryStatus: nextLibraryStatus,
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
    touched.add(sourceKey);
    touchedIds.add(row.id);
    return row;
  });

  const importItems = await mapWithConcurrency(imports, 12, async (item) => {
    const resolved = await resolveImportMedia(item).catch(() => null);
    const request = item.requestId ? requestsById.get(item.requestId) ?? null : null;
    const link = item.symlinks[0];
    const strategy = importStrategy(link?.status);
    const sourceKey = `import:${item.id}`;
    const identityKey = mediaIdentityKey({
      mediaType: resolved?.mediaType ?? item.mediaType,
      title: request?.title ?? resolved?.title ?? item.title,
      year: request?.year ?? resolved?.year ?? item.year,
      tmdbId: request?.tmdbId ?? null,
      tvdbId: request?.tvdbId ?? null,
      imdbId: request?.imdbId ?? null,
      season: resolved?.season ?? item.season,
      episode: resolved?.episode ?? item.episode
    });
    await prisma.mediaLibraryItem.deleteMany({
      where: {
        sourceKey,
        identityKey: { not: identityKey }
      }
    });
    const existing = existingByIdentity.get(identityKey);
    const title = request?.title ?? resolved?.title ?? existing?.title ?? item.title;
    const year = request?.year ?? resolved?.year ?? existing?.year ?? item.year;
    const fileTarget = item.mediaFiles[0];
    const movieId = request?.movieId ?? existing?.movieId ?? fileTarget?.movieId ?? undefined;
    const episodeId = request?.episodeId ?? existing?.episodeId ?? fileTarget?.episodeId ?? undefined;
    const seasonId = request?.seasonId ?? existing?.seasonId ?? fileTarget?.episode?.seasonId ?? undefined;
    const tvShowId = request?.tvShowId ?? existing?.tvShowId ?? fileTarget?.episode?.tvShowId ?? undefined;
    const row = await prisma.mediaLibraryItem.upsert({
      where: { identityKey },
      update: {
        sourceKey,
        identityKey,
        mediaType: resolved?.mediaType ?? item.mediaType,
        movieId,
        tvShowId,
        seasonId,
        episodeId,
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
        identityKey,
        mediaType: resolved?.mediaType ?? item.mediaType,
        movieId,
        tvShowId,
        seasonId,
        episodeId,
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
    touched.add(sourceKey);
    touchedIds.add(row.id);
    return row;
  });

  const metadataCandidates = [...requestItems, ...importItems];
  await mapWithConcurrency(metadataCandidates, 6, async (item) => enrichLibraryItem(item, settings).catch(() => item));

  await prisma.mediaLibraryItem.deleteMany({
    where: {
      OR: [
        { sourceKey: { startsWith: "download:" } },
        { sourceKey: { startsWith: "mount:" } },
        {
          OR: [{ sourceKey: { startsWith: "request:" } }, { sourceKey: { startsWith: "import:" } }],
          NOT: { id: { in: [...touchedIds] } }
        }
      ]
    }
  });

  await dedupeLibraryItems();

  return { refreshed: touched.size, items: options?.includeItems ? await listLibraryItems() : [] };
}

export async function refreshMediaLibrary(options?: { includeItems?: boolean }) {
  if (refreshPromise) {
    refreshQueued = true;
    return refreshPromise;
  }

  refreshPromise = (async () => {
    let result = await runLibraryRefreshCycle(options);
    while (refreshQueued) {
      refreshQueued = false;
      result = await runLibraryRefreshCycle(options);
    }
    return result;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}
