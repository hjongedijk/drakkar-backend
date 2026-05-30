import { prisma, type MediaLibraryItem } from "../../repositories/db/prisma.js";
import { hydrateLegacyMediaFields } from "./normalizedMedia.js";
import { getCachedSubtitleLanguages, updateSubtitleLanguageCache } from "./subtitleLanguageCache.js";
import { LIBRARY_LIST_SELECT, mapWithConcurrency, shouldHideLibraryItem } from "./libraryShared.js";
import { listSubtitleLanguagesForPath } from "../subtitles/subtitleUtils.js";

export async function subtitleLanguagesForItem(item: Pick<MediaLibraryItem, "symlinkPath" | "strmPath" | "filePath">) {
  const mediaPath = item.symlinkPath ?? item.strmPath ?? item.filePath;
  if (!mediaPath) return [];
  const cached = getCachedSubtitleLanguages(mediaPath);
  if (cached) return cached;
  const normalized = await listSubtitleLanguagesForPath(mediaPath);
  updateSubtitleLanguageCache(mediaPath, normalized);
  return normalized;
}

export async function listLibraryItems() {
  const items = await prisma.mediaLibraryItem.findMany({
    where: {
      OR: [{ sourceKey: { startsWith: "import:" } }, { sourceKey: { startsWith: "request:" } }]
    },
    select: LIBRARY_LIST_SELECT,
    orderBy: [{ libraryStatus: "asc" }, { sortTitle: "asc" }, { createdAt: "desc" }]
  });
  const visible = items
    .map((item) => hydrateLegacyMediaFields(item))
    .filter((item) => !shouldHideLibraryItem(item));
  return mapWithConcurrency(visible, 12, async (item) => ({
    ...item,
    subtitleLanguages: await subtitleLanguagesForItem(item).catch(() => [])
  }));
}

export function getLibraryItem(id: string) {
  return prisma.mediaLibraryItem.findUniqueOrThrow({
    where: { id },
    select: LIBRARY_LIST_SELECT
  }).then((item) => hydrateLegacyMediaFields(item));
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
