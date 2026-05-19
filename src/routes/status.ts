import type { FastifyInstance } from "fastify";
import { statfs } from "node:fs/promises";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { testNzbhydraConnection } from "../indexers/nzbhydra/client.js";
import { nzbDownloadQueue, pipelineQueues } from "../queues/downloadQueue.js";
import { testRequestProvider } from "../requests/sync/service.js";
import { getSettings } from "../settings/settingsStore.js";
import { getBandwidthStatus } from "../bandwidth/bandwidthScheduler.js";
import { getFuseMountStatus } from "../vfs/fuseMountService.js";
import { healthRoutes } from "./health.js";

async function serviceStatus(check: () => Promise<{ ok: boolean }>, configured: boolean) {
  if (!configured) return "not_configured";
  try {
    const result = await check();
    return result.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

async function storageUsage() {
  try {
    const stats = await statfs(env.VFS_ROOT);
    return {
      usedBytes: Number(stats.blocks - stats.bfree) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      freeBytes: Number(stats.bavail) * Number(stats.bsize)
    };
  } catch {
    return null;
  }
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  await healthRoutes(app);

  app.get("/api/status", async () => {
    const [counts, settings, requestProviders] = await Promise.all([
      nzbDownloadQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused"),
      getSettings(),
      prisma.requestProvider.findMany({ where: { enabled: true }, select: { id: true } })
    ]);
    const waiting = counts.waiting ?? 0;
    const active = counts.active ?? 0;
    const delayed = counts.delayed ?? 0;
    const [nzbhydra, seerr] = await Promise.all([
      serviceStatus(() => testNzbhydraConnection(settings), Boolean(settings.nzbhydraUrl && settings.nzbhydraApiKey)),
      serviceStatus(async () => {
        const results = await Promise.all(requestProviders.map((provider) => testRequestProvider(provider.id)));
        return { ok: results.length > 0 && results.every((result) => result.ok) };
      }, requestProviders.length > 0)
    ]);
    const [bandwidth, fuse, storage] = await Promise.all([getBandwidthStatus(), Promise.resolve(getFuseMountStatus()), storageUsage()]);

    return {
      appName: "Drakkar",
      version: "0.1.0",
      backend: "ok",
      postgresql: "ok",
      redis: "ok",
      nzbhydra,
      seerr,
      activeDownloads: active,
      queueSize: waiting + delayed,
      storageUsage: storage,
      queues: counts,
      bandwidth,
      fuse
    };
  });

  app.get("/api/diagnostics", async () => {
    const [providers, queuedDownloads] = await Promise.all([
      prisma.usenetServer.count({ where: { enabled: true } }),
      prisma.download.groupBy({ by: ["status"], _count: { status: true } })
    ]);
    const queues = await Promise.all(
      pipelineQueues.map(async (queue) => ({
        name: queue.name,
        counts: await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused")
      }))
    );

    return {
      usenetProvidersEnabled: providers,
      downloadsByStatus: Object.fromEntries(queuedDownloads.map((row) => [row.status, row._count.status])),
      queues
    };
  });
}
