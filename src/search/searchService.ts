import { prisma } from "../db/prisma.js";
import { getSettings } from "../settings/settingsStore.js";
import { searchNzbhydra, type SearchParams } from "../indexers/nzbhydra/client.js";
import type { Release } from "../releases/types.js";
import { looksLikeArchiveRelease } from "../releases/archiveHeuristics.js";

function normalizeReleaseTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[\[\](){}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function knownBadReleaseKeys() {
  const failed = await prisma.failedRelease.findMany({
    where: {
      OR: [
        { reason: { contains: "430 No Such Article", mode: "insensitive" } },
        { reason: { contains: "all providers failed", mode: "insensitive" } },
        { reason: { contains: "missing article", mode: "insensitive" } },
        { reason: { contains: "no such article", mode: "insensitive" } },
        { reason: { contains: "Archive/RAR NZB", mode: "insensitive" } },
        { reason: { contains: "requires archive extraction", mode: "insensitive" } },
        { reason: { contains: "contains no direct streamable video", mode: "insensitive" } },
        { reason: { contains: "no direct streamable video", mode: "insensitive" } },
        { reason: { contains: "duplicate NZB already exists", mode: "insensitive" } }
      ]
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { guid: true, title: true }
  });
  return {
    guids: new Set(failed.flatMap((item) => item.guid ? [item.guid] : [])),
    titles: new Set(failed.map((item) => normalizeReleaseTitle(item.title)))
  };
}

function uniqAndFilterReleases(releases: Release[], badKeys: Awaited<ReturnType<typeof knownBadReleaseKeys>>) {
  const seenGuids = new Set<string>();
  const seenTitles = new Set<string>();
  const filtered: Release[] = [];

  for (const release of releases) {
    if (looksLikeArchiveRelease(release)) continue;
    const guid = release.guid ? String(release.guid) : "";
    const titleKey = normalizeReleaseTitle(release.title);
    if ((guid && badKeys.guids.has(guid)) || badKeys.titles.has(titleKey)) continue;
    if (guid && seenGuids.has(guid)) continue;
    if (seenTitles.has(titleKey)) continue;
    if (guid) seenGuids.add(guid);
    seenTitles.add(titleKey);
    filtered.push(release);
  }

  return filtered;
}

export async function runSearch(params: SearchParams & { recordHistory?: boolean }) {
  const settings = await getSettings();
  const { recordHistory = true, ...searchParams } = params;
  try {
    const badKeys = await knownBadReleaseKeys();
    const releases = await searchNzbhydra(settings, searchParams);
    let filtered = uniqAndFilterReleases(releases, badKeys);
    const usedStrictIds = Boolean(searchParams.imdbId || searchParams.tmdbId || searchParams.tvdbId);
    let message: string | undefined;
    if (filtered.length === 0 && usedStrictIds && searchParams.query) {
      const fallbackParams = { ...searchParams, imdbId: undefined, tmdbId: undefined, tvdbId: undefined };
      const fallback = await searchNzbhydra(settings, fallbackParams);
      filtered = uniqAndFilterReleases(fallback, badKeys);
      message = "fallback without strict IDs";
    }
    if (recordHistory) {
      await prisma.searchHistory.create({
        data: { type: searchParams.kind, query: searchParams, resultCount: filtered.length, status: "ok", message }
      });
    }
    return filtered;
  } catch (error) {
    if (recordHistory) {
      await prisma.searchHistory.create({
        data: {
          type: searchParams.kind,
          query: searchParams,
          resultCount: 0,
          status: "error",
          message: error instanceof Error ? error.message : "unknown error"
        }
      });
    }
    throw error;
  }
}

export function getSearchHistory() {
  return prisma.searchHistory.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
}
