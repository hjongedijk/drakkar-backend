import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";

type LogRow = {
  id: string;
  time: Date;
  level: "info" | "warn" | "error";
  service: string;
  message: string;
};

function humanizeBlockReason(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function searchMessage(search: {
  type: string;
  resultCount: number;
  status: string;
  message: string | null;
  query: unknown;
}) {
  const query = search.query && typeof search.query === "object" ? search.query as Record<string, unknown> : null;
  const title = typeof query?.query === "string" ? query.query : typeof query?.title === "string" ? query.title : undefined;
  const season = typeof query?.season === "number" ? query.season : undefined;
  const episode = typeof query?.episode === "number" ? query.episode : undefined;
  const target = [
    title,
    season != null ? `S${String(season).padStart(2, "0")}` : null,
    episode != null ? `E${String(episode).padStart(2, "0")}` : null
  ].filter(Boolean).join(" ");
  if (search.message === "merged fallback without strict IDs") {
    return `${search.type} search${target ? ` for ${target}` : ""} merged fallback search and returned ${search.resultCount} result(s)`;
  }
  if (search.message) {
    return `${search.type} search${target ? ` for ${target}` : ""}: ${search.message}`;
  }
  return `${search.type} search${target ? ` for ${target}` : ""} returned ${search.resultCount} result(s)`;
}

async function buildLogRows() {
  const [downloads, repairs, searches, blocklist] = await Promise.all([
    prisma.download.findMany({ orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.repairJob.findMany({ orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.searchHistory.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.blocklistItem.findMany({ orderBy: { createdAt: "desc" }, take: 100 })
  ]);

  const visibleSearches = searches.filter((search) => {
    if (search.status === "error") return true;
    if (search.resultCount > 0) return true;
    if (search.message) return /fallback|merged|error|failed/i.test(search.message);
    return false;
  });

  const rows: LogRow[] = [
    ...downloads.map((download) => ({
      id: download.id,
      time: download.updatedAt,
      level: download.error || download.status === "failed" ? "error" as const : "info" as const,
      service: "downloads",
      message: download.error ? `${download.title}: ${download.error}` : `${download.title} ${download.status}`
    })),
    ...repairs.map((job) => ({
      id: job.id,
      time: job.updatedAt,
      level: job.status === "failed" ? "error" as const : job.status === "completed" ? "info" as const : "warn" as const,
      service: "repair",
      message: job.message ?? `${job.type} ${job.status}`
    })),
    ...visibleSearches.map((search) => ({
      id: search.id,
      time: search.createdAt,
      level: search.status === "error" ? "error" as const : "info" as const,
      service: "search",
      message: searchMessage(search)
    })),
    ...blocklist.map((item) => ({
      id: item.id,
      time: item.createdAt,
      level: "warn" as const,
      service: "blocklist",
      message: `${item.title}: ${humanizeBlockReason(item.reason)}`
    }))
  ];

  return rows.sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 250);
}

export async function logRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/logs", async () => buildLogRows());

  app.get("/api/logs/download", async (_request, reply) => {
    const rows = await buildLogRows();
    const payload = rows.map((row) => ({
      ...row,
      time: row.time.toISOString()
    }));
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="drakkar-logs-${new Date().toISOString().slice(0, 10)}.json"`);
    return reply.send(JSON.stringify(payload, null, 2));
  });
}
