import { statfs } from "node:fs/promises";
import { env } from "../services/config/env.js";
import { getNzbhydraSearchMetrics, testNzbhydraConnection } from "../services/indexers/nzbhydra/client.js";
import { getPolicyUsageReport } from "../services/policyService.js";
import { nzbDownloadQueue, pipelineQueues } from "../workers/queues/downloadQueue.js";
import {
  countEnabledUsenetProviders,
  groupActiveDownloadStatuses,
  groupDownloadsByStatus,
  listEnabledRequestProviderIds,
  listEnabledUsenetProviderDebugRows
} from "../repositories/statusRepository.js";
import { testRequestProvider } from "../services/requests/sync/service.js";
import { getSettings } from "../services/settings/settingsStore.js";
import { getMountedPoolDebugState } from "../services/mountedStream.service.js";
import { getBandwidthStatus } from "../services/bandwidth/bandwidthScheduler.js";
import { getDownloadPoolDebugState } from "../services/usenet/downloadEngine.js";
import { DRAKKAR_VERSION } from "../models/version.js";
import { getFuseMountStatus } from "../services/fuseMountService.js";

const SERVICE_STATUS_CACHE_TTL_MS = 30_000;

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

function countByStatus(rows: Array<{ status: string; _count: { status: number } }>) {
  return Object.fromEntries(rows.map((row) => [row.status, row._count.status]));
}

const cachedServiceStatuses = new Map<string, { expiresAt: number; value: string }>();

async function cachedServiceStatus(key: string, check: () => Promise<{ ok: boolean }>, configured: boolean) {
  const cached = cachedServiceStatuses.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await serviceStatus(check, configured);
  cachedServiceStatuses.set(key, {
    value,
    expiresAt: now + SERVICE_STATUS_CACHE_TTL_MS
  });
  return value;
}

export async function getSystemStatus() {
  const [counts, downloadStatusRows, settings, requestProviders] = await Promise.all([
    nzbDownloadQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused"),
    groupActiveDownloadStatuses(),
    getSettings(),
    listEnabledRequestProviderIds()
  ]);
  const downloadCounts = countByStatus(downloadStatusRows);
  const activeDownloads = (downloadCounts.downloading ?? 0) + (downloadCounts.verifying ?? 0) + (downloadCounts.fetching_nzb ?? 0) + (downloadCounts.prepared ?? 0);
  const queueSize = (downloadCounts.queued ?? 0) + (downloadCounts.waiting_for_provider ?? 0) + (downloadCounts.waiting_for_nzb ?? 0);
  const [nzbhydra, seerr] = await Promise.all([
    cachedServiceStatus("nzbhydra", () => testNzbhydraConnection(settings), Boolean(settings.nzbhydraUrl && settings.nzbhydraApiKey)),
    cachedServiceStatus("request-providers", async () => {
      const results = await Promise.all(requestProviders.map((provider) => testRequestProvider(provider.id)));
      return { ok: results.length > 0 && results.every((result) => result.ok) };
    }, requestProviders.length > 0)
  ]);
  const [bandwidth, vfsMount, storage, nzbhydraSearch] = await Promise.all([
    getBandwidthStatus(),
    Promise.resolve(getFuseMountStatus()),
    storageUsage(),
    getNzbhydraSearchMetrics()
  ]);

  return {
    appName: "Drakkar",
    version: DRAKKAR_VERSION,
    backend: "ok",
    postgresql: "ok",
    valkey: "ok",
    nzbhydra,
    seerr,
    activeDownloads,
    queueSize,
    storageUsage: storage,
    queues: counts,
    nzbhydraSearch,
    bandwidth,
    vfsMount
  };
}

export async function getDiagnosticsStatus() {
  const [providers, queuedDownloads] = await Promise.all([
    countEnabledUsenetProviders(),
    groupDownloadsByStatus()
  ]);
  const queues = await Promise.all(
    pipelineQueues.map(async (queue) => ({
      name: queue.name,
      counts: await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused")
    }))
  );
  const [policyUsage, nzbhydraSearch] = await Promise.all([
    Promise.resolve(getPolicyUsageReport()),
    getNzbhydraSearchMetrics()
  ]);

  return {
    usenetProvidersEnabled: providers,
    downloadsByStatus: Object.fromEntries(queuedDownloads.map((row) => [row.status, row._count.status])),
    queues,
    nzbhydraSearch,
    policyUsage
  };
}

export async function getUsenetDebugStatus() {
  const [providers, bandwidth] = await Promise.all([
    listEnabledUsenetProviderDebugRows(),
    getBandwidthStatus()
  ]);

  return {
    providers,
    bandwidth,
    activeDownloadPools: getDownloadPoolDebugState(),
    mountedStreamPool: getMountedPoolDebugState()
  };
}
