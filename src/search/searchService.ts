import { prisma } from "../db/prisma.js";
import { getSettings } from "../settings/settingsStore.js";
import { searchNzbhydra, type SearchParams } from "../indexers/nzbhydra/client.js";

export async function runSearch(params: SearchParams) {
  const settings = await getSettings();
  try {
    const releases = await searchNzbhydra(settings, params);
    await prisma.searchHistory.create({
      data: { type: params.kind, query: params, resultCount: releases.length, status: "ok" }
    });
    return releases;
  } catch (error) {
    await prisma.searchHistory.create({
      data: {
        type: params.kind,
        query: params,
        resultCount: 0,
        status: "error",
        message: error instanceof Error ? error.message : "unknown error"
      }
    });
    throw error;
  }
}

export function getSearchHistory() {
  return prisma.searchHistory.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
}
