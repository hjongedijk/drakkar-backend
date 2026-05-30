import { unlink } from "node:fs/promises";
import { prisma, type MediaLibraryItem } from "../repositories/db/prisma.js";
import { addNzbFromPath, findReusableDownload } from "../services/downloadService.js";
import { downloadNzb } from "../services/indexers/nzbhydra/client.js";
import { createBlocklistItem, isReleaseBlocklisted } from "../services/policyService.js";
import { toPublicReleases } from "../services/releases/public.js";
import type { Release } from "../services/releases/types.js";
import { scoreRelease } from "../services/quality/scoring.js";
import { runSearch } from "../services/searchService.js";
import { getSettings } from "../services/settings/settingsStore.js";
import { getLibraryItem, libraryStats, listLibraryItems } from "./media-library/libraryQueries.js";
import { refreshMediaLibrary, refreshLibraryRequestRows, requestMediaLibraryRefresh } from "./media-library/libraryRefresh.js";

function searchParamsForLibraryItem(item: Pick<MediaLibraryItem, "mediaType" | "title" | "imdbId" | "tmdbId" | "tvdbId" | "season" | "episode">) {
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

export { getLibraryItem, libraryStats, listLibraryItems, refreshMediaLibrary };

async function rankedLibraryReplacementReleases(item: Pick<MediaLibraryItem, "qualityProfileId">, releases: Release[]) {
  if (!item.qualityProfileId) return releases;
  const profile = await prisma.qualityProfile.findUnique({ where: { id: item.qualityProfileId } });
  if (!profile) return releases;
  return [...releases]
    .map((release) => ({ release, decision: scoreRelease(release, profile) }))
    .sort((left, right) => {
      const acceptedOrder = Number(right.decision.accepted) - Number(left.decision.accepted);
      if (acceptedOrder !== 0) return acceptedOrder;
      return right.decision.score - left.decision.score;
    })
    .map((item) => item.release);
}

export async function searchLibraryItemReplacements(id: string) {
  const item = await getLibraryItem(id);
  const releases = await runSearch(searchParamsForLibraryItem(item));
  return { item, releases: toPublicReleases(await rankedLibraryReplacementReleases(item, releases)) };
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

  void requestMediaLibraryRefresh().catch(() => undefined);
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
  if (item.requestId) {
    await refreshLibraryRequestRows([item.requestId]);
  } else {
    await requestMediaLibraryRefresh();
  }
  return { replaced: true, item, release: typedRelease, download };
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
