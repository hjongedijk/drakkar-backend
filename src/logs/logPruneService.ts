import { prisma } from "../db/prisma.js";

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_SEARCH_HISTORY_ROWS = 5000;
const DEFAULT_MAX_REPAIR_ROWS = 2000;

function cutoffDate(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function pruneSearchHistoryByMaxRows(maxRows: number) {
  const rows = await prisma.searchHistory.findMany({
    orderBy: { createdAt: "desc" },
    skip: maxRows,
    select: { id: true }
  });
  if (rows.length === 0) return 0;
  const result = await prisma.searchHistory.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return result.count;
}

async function pruneRepairJobsByMaxRows(maxRows: number) {
  const rows = await prisma.repairJob.findMany({
    orderBy: { createdAt: "desc" },
    skip: maxRows,
    select: { id: true }
  });
  if (rows.length === 0) return 0;
  const result = await prisma.repairJob.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return result.count;
}

export async function pruneLogData(options?: { retentionDays?: number; maxSearchHistoryRows?: number; maxRepairRows?: number }) {
  const retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = cutoffDate(retentionDays);
  const [oldSearches, noisyEpisodeSearches, oldRepairs, oldExpiredBlocklist, excessSearches, excessRepairs] = await Promise.all([
    prisma.searchHistory.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.searchHistory.deleteMany({
      where: {
        OR: [
          { type: "movie", resultCount: 0, status: "ok" },
          { type: "tv", resultCount: 0, status: "ok" },
          { type: "season", resultCount: 0, status: "ok" },
          { type: "episode", resultCount: 0 },
          { type: "episode-grab", resultCount: 0 },
          { message: "fallback without strict IDs", resultCount: 0 }
        ]
      }
    }),
    prisma.repairJob.deleteMany({ where: { createdAt: { lt: cutoff }, status: { in: ["completed", "failed"] } } }),
    prisma.blocklistItem.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    pruneSearchHistoryByMaxRows(options?.maxSearchHistoryRows ?? DEFAULT_MAX_SEARCH_HISTORY_ROWS),
    pruneRepairJobsByMaxRows(options?.maxRepairRows ?? DEFAULT_MAX_REPAIR_ROWS)
  ]);

  return {
    deletedSearchHistory: oldSearches.count + noisyEpisodeSearches.count + excessSearches,
    deletedRepairJobs: oldRepairs.count + excessRepairs,
    deletedExpiredBlocklist: oldExpiredBlocklist.count,
    retentionDays
  };
}
