import { dirname, basename, extname } from "node:path";
import { readdir } from "node:fs/promises";
import { prisma, type MediaLibraryItem } from "../../repositories/db/prisma.js";
import { hydrateLegacyMediaFields } from "./normalizedMedia.js";
import { getCachedSubtitleLanguages, updateSubtitleLanguageCache } from "./subtitleLanguageCache.js";
import { LIBRARY_LIST_SELECT, mapWithConcurrency, shouldHideLibraryItem } from "./libraryShared.js";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function subtitleLanguagesForItem(item: Pick<MediaLibraryItem, "symlinkPath" | "strmPath" | "filePath">) {
  const mediaPath = item.symlinkPath ?? item.strmPath ?? item.filePath;
  if (!mediaPath) return [];
  const cached = getCachedSubtitleLanguages(mediaPath);
  if (cached) return cached;
  const directory = dirname(mediaPath);
  const extension = extname(mediaPath);
  const stem = extension ? basename(mediaPath, extension) : basename(mediaPath);
  const entries = await readdir(directory, { withFileTypes: true });
  const languages = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .flatMap((name) => {
      const match = name.match(new RegExp(`^${escapeRegExp(stem)}\\.([a-z0-9-]+)\\.(srt|ass|ssa|vtt|sub)$`, "i"));
      return match?.[1] ? [match[1].toUpperCase()] : [];
    });
  const normalized = [...new Set(languages)].sort();
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
