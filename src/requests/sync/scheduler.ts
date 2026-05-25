import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../../db/prisma.js";
import { cleanupDownloadHistory } from "../../downloads/downloadService.js";
import { refreshNzbhydraUpdateFeeds } from "../../indexers/nzbhydra/client.js";
import { refreshMediaLibrary } from "../../media-library/libraryService.js";
import { reconcileAvailableDownloadsWithoutImports, recoverInterruptedDownloads } from "../../usenet/workers.js";
import { pruneLogData } from "../../logs/logPruneService.js";
import { getSettings } from "../../settings/settingsStore.js";
import { IMPORT_RECONCILE_TASK_ID, INTERRUPTED_RECOVERY_TASK_ID, LIBRARY_CLEANUP_TASK_ID, LOG_PRUNE_INTERVAL_MS, LOG_PRUNE_TASK_ID, NAMING_MIGRATION_TASK_ID, NZBHYDRA_RSS_SYNC_INTERVAL_MS, NZBHYDRA_RSS_SYNC_TASK_ID, REQUEST_RECOVERY_INTERVAL_MS, REQUEST_RECOVERY_TASK_ID, REQUEST_SYNC_INTERVAL_MS, REQUEST_SYNC_TASK_ID, SUBTITLE_BACKFILL_INTERVAL_MS, SUBTITLE_BACKFILL_TASK_ID, registerCoreTasks, resolveTaskIntervalMs } from "../../tasks/coreTasks.js";
import { getTask, runTrackedTask, setTaskNextRun } from "../../tasks/taskRegistry.js";
import { runSubtitleBackfill } from "../../subtitles/subtitleService.js";
import {
  backfillPlaceholderRequestMetadata,
  ensureMonitoredRequests,
  recoverFailedRequestDownloads,
  recoverSelectedReleaseDownloads,
  syncRequests
} from "./service.js";

const scheduleHandles = new Map<string, NodeJS.Timeout>();
let running = false;
let rssRunning = false;
let logPruneRunning = false;
const FULL_REQUEST_SYNC_BATCH_SIZE = 100;
const REQUEST_RECOVERY_BATCH_LIMIT = 25;

async function configuredTaskInterval(taskId: string, fallback: number | null) {
  const settings = await getSettings().catch(() => null);
  registerCoreTasks(settings ?? undefined);
  return resolveTaskIntervalMs(taskId, settings) ?? fallback;
}

async function setDynamicTaskNextRun(taskId: string, fallback: number | null) {
  const intervalMs = await configuredTaskInterval(taskId, fallback);
  setTaskNextRun(taskId, intervalMs ? new Date(Date.now() + intervalMs) : null);
  return intervalMs;
}

function clearScheduledTask(taskId: string) {
  const handle = scheduleHandles.get(taskId);
  if (handle) clearTimeout(handle);
  scheduleHandles.delete(taskId);
}

function scheduleDynamicTask(input: {
  taskId: string;
  initialDelayMs: number;
  fallbackIntervalMs: number | null;
  runner: () => Promise<void>;
}) {
  clearScheduledTask(input.taskId);
  const enqueue = (delayMs: number) => {
    const handle = setTimeout(async () => {
      try {
        await input.runner();
      } finally {
        const nextInterval = await setDynamicTaskNextRun(input.taskId, input.fallbackIntervalMs);
        if (nextInterval) enqueue(nextInterval);
      }
    }, delayMs);
    scheduleHandles.set(input.taskId, handle);
  };
  setTaskNextRun(input.taskId, new Date(Date.now() + input.initialDelayMs));
  enqueue(input.initialDelayMs);
}

function isLibraryMaintenanceRunning(id: string) {
  const task = getTask(id);
  return task?.status === "running";
}

export async function runLogPruneCycle(logger: FastifyBaseLogger) {
  if (logPruneRunning) return;
  logPruneRunning = true;
  try {
    await runTrackedTask(LOG_PRUNE_TASK_ID, async () => {
      const result = await pruneLogData();
      logger.info(result, "log data pruned");
      return result;
    });
  } catch (error) {
    logger.warn({ err: error }, "log prune failed");
  } finally {
    logPruneRunning = false;
  }
}

export async function runSubtitleBackfillCycle(logger: FastifyBaseLogger) {
  try {
    await runSubtitleBackfill(logger);
  } catch (error) {
    logger.warn({ err: error }, "subtitle backfill failed");
  }
}

export async function runNzbhydraRssSyncCycle(logger: FastifyBaseLogger) {
  if (rssRunning) return;
  rssRunning = true;
  try {
    await runTrackedTask(NZBHYDRA_RSS_SYNC_TASK_ID, async () => {
      const result = await refreshNzbhydraUpdateFeeds(await getSettings());
      logger.info(result, "nzbhydra rss/update sync completed");
      return result;
    });
  } catch (error) {
    logger.warn({ err: error }, "nzbhydra rss/update sync failed");
  } finally {
    rssRunning = false;
  }
}

export async function runDeferredRequestRecovery(logger: FastifyBaseLogger) {
  try {
    const result = await runTrackedTask(REQUEST_RECOVERY_TASK_ID, async () => {
      const monitored = await ensureMonitoredRequests();
      if (monitored.retried > 0 || monitored.skippedBecauseQueueFull > 0) {
        logger.info({
          retried: monitored.retried,
          queueSeedTarget: monitored.queueSeedTarget,
          pendingQueueItems: monitored.pendingQueueItems,
          skippedBecauseQueueFull: monitored.skippedBecauseQueueFull
        }, "monitored request queue seeding completed");
      }
      const selectedReleaseRecovery = await recoverSelectedReleaseDownloads({ limit: REQUEST_RECOVERY_BATCH_LIMIT });
      if (selectedReleaseRecovery.recovered > 0) {
        logger.info({ recovered: selectedReleaseRecovery.recovered }, "selected releases without downloads were re-queued");
      }
      const failedRecovery = await recoverFailedRequestDownloads({ limit: REQUEST_RECOVERY_BATCH_LIMIT });
      if (failedRecovery.recovered > 0) {
        logger.info({ recovered: failedRecovery.recovered }, "failed request downloads were recovered");
      }
      return { monitored, selectedReleaseRecovery, failedRecovery };
    });
    return result ? { started: true, ...result } : { started: false };
  } catch (error) {
    logger.warn({ err: error }, "deferred request download recovery failed");
    return { started: true, error };
  }
}

export async function runImportReconcileCycle(logger: FastifyBaseLogger) {
  if (isLibraryMaintenanceRunning(NAMING_MIGRATION_TASK_ID) || isLibraryMaintenanceRunning(LIBRARY_CLEANUP_TASK_ID)) {
    return { started: false, reason: "conflicting_task_running" as const };
  }
  try {
    const result = await runTrackedTask(IMPORT_RECONCILE_TASK_ID, async () => {
      const reconciliation = await reconcileAvailableDownloadsWithoutImports(logger);
      if (reconciliation.mountedFixed > 0 || reconciliation.materializedImported > 0 || reconciliation.requeued > 0 || reconciliation.failed > 0) {
        logger.info(reconciliation, "stale prepared/available imports reconciled");
      }
      return reconciliation;
    });
    return result ? { started: true, result } : { started: false, reason: "already_running" as const };
  } catch (error) {
    logger.warn({ err: error }, "import reconciliation failed");
    return { started: true, error };
  }
}

export async function runInterruptedRecoveryCycle(logger: FastifyBaseLogger) {
  try {
    return await runTrackedTask(INTERRUPTED_RECOVERY_TASK_ID, () => recoverInterruptedDownloads(logger));
  } catch (error) {
    logger.warn({ err: error }, "missing worker job recovery failed");
    return undefined;
  }
}

export function isRequestSyncRunning() {
  return running;
}

export async function runFullRequestSyncRefresh(logger: FastifyBaseLogger, providerId?: string) {
  if (running) return { started: false, reason: "already_running" as const };
  running = true;
  try {
    await runTrackedTask(REQUEST_SYNC_TASK_ID, async () => {
      const providers = providerId
        ? [{ id: providerId }]
        : await prisma.requestProvider.findMany({
            where: { enabled: true, type: "seerr" },
            select: { id: true }
          });
      const aggregate = {
        imported: 0,
        updated: 0,
        skipped: 0,
        fetched: 0,
        failedProviders: 0,
        autoGrabbed: 0,
        budgetExceeded: false,
        requests: [],
        providerResults: []
      } as Awaited<ReturnType<typeof syncRequests>>;

      for (const provider of providers) {
        let skip = 0;
        while (true) {
          const batch = await syncRequests(provider.id, {
            full: true,
            skip,
            maxRequests: FULL_REQUEST_SYNC_BATCH_SIZE,
            pageSize: FULL_REQUEST_SYNC_BATCH_SIZE,
            refreshLibrary: false
          });
          aggregate.imported += batch.imported;
          aggregate.updated += batch.updated;
          aggregate.skipped += batch.skipped;
          aggregate.fetched += batch.fetched;
          aggregate.failedProviders += batch.failedProviders;
          aggregate.providerResults.push(...batch.providerResults);
          aggregate.requests.push(...batch.requests);

          logger.info({
            providerId: provider.id,
            skip,
            batchFetched: batch.fetched,
            batchImported: batch.imported,
            batchUpdated: batch.updated,
            batchSkipped: batch.skipped
          }, "full request resync batch completed");

          if (batch.fetched < FULL_REQUEST_SYNC_BATCH_SIZE) break;
          skip += FULL_REQUEST_SYNC_BATCH_SIZE;
        }
      }
      const metadataBackfill = await backfillPlaceholderRequestMetadata();
      const library = await refreshMediaLibrary();
      logger.info({
        imported: aggregate.imported,
        updated: aggregate.updated,
        skipped: aggregate.skipped,
        fetched: aggregate.fetched,
        failedProviders: aggregate.failedProviders,
        metadataUpdated: metadataBackfill.updated,
        libraryRefreshed: library.refreshed
      }, "full request resync and library refresh completed");
      return aggregate;
    });
    void runDeferredRequestRecovery(logger);
    return { started: true };
  } catch (error) {
    logger.warn({ err: error }, "full request resync and library refresh failed");
    return { started: true, error };
  }
  finally {
    running = false;
  }
}

export async function runRequestSyncCycle(logger: FastifyBaseLogger) {
  if (running) return;
  running = true;
  try {
    await runTrackedTask(REQUEST_SYNC_TASK_ID, async () => {
      const sync = await syncRequests();
      logger.info({
        fetched: sync.fetched,
        imported: sync.imported,
        updated: sync.updated,
        skipped: sync.skipped,
        autoGrabbed: sync.autoGrabbed,
        budgetExceeded: sync.budgetExceeded,
        failedProviders: sync.failedProviders,
        providers: sync.providerResults.map((provider) => ({
          name: provider.providerName,
          fetched: provider.fetched,
          imported: provider.imported,
          updated: provider.updated,
          skipped: provider.skipped,
          ok: provider.ok
        }))
      }, "request sync completed");
      const metadataBackfill = await backfillPlaceholderRequestMetadata();
      if (metadataBackfill.updated > 0) {
        logger.info(metadataBackfill, "placeholder request titles backfilled from metadata");
      }
      const cleanup = await cleanupDownloadHistory({ keepFailed: 0, keepCancelled: 0 });
      if (cleanup.deleted > 0 || cleanup.cleanedFailedJobs > 0) logger.info(cleanup, "download history auto-cleaned");
      return sync;
    });
    void runInterruptedRecoveryCycle(logger);
    void runImportReconcileCycle(logger);
    void runDeferredRequestRecovery(logger);
  } catch (error) {
    logger.warn({ err: error }, "request sync/recovery failed");
  } finally {
    running = false;
  }
}

export function startRequestSyncSchedule(logger: FastifyBaseLogger) {
  void getSettings().then((settings) => registerCoreTasks(settings)).catch(() => registerCoreTasks());
  if (!scheduleHandles.has(REQUEST_SYNC_TASK_ID)) {
    scheduleDynamicTask({
      taskId: REQUEST_SYNC_TASK_ID,
      initialDelayMs: 30_000,
      fallbackIntervalMs: REQUEST_SYNC_INTERVAL_MS,
      runner: () => runRequestSyncCycle(logger)
    });
  }
  if (!scheduleHandles.has(REQUEST_RECOVERY_TASK_ID)) {
    scheduleDynamicTask({
      taskId: REQUEST_RECOVERY_TASK_ID,
      initialDelayMs: 45_000,
      fallbackIntervalMs: REQUEST_RECOVERY_INTERVAL_MS,
      runner: () => runDeferredRequestRecovery(logger).then(() => undefined)
    });
  }
  if (!scheduleHandles.has(NZBHYDRA_RSS_SYNC_TASK_ID)) {
    scheduleDynamicTask({
      taskId: NZBHYDRA_RSS_SYNC_TASK_ID,
      initialDelayMs: 15_000,
      fallbackIntervalMs: NZBHYDRA_RSS_SYNC_INTERVAL_MS,
      runner: () => runNzbhydraRssSyncCycle(logger)
    });
  }
  if (!scheduleHandles.has(LOG_PRUNE_TASK_ID)) {
    scheduleDynamicTask({
      taskId: LOG_PRUNE_TASK_ID,
      initialDelayMs: 60_000,
      fallbackIntervalMs: LOG_PRUNE_INTERVAL_MS,
      runner: () => runLogPruneCycle(logger)
    });
  }
  if (!scheduleHandles.has(SUBTITLE_BACKFILL_TASK_ID)) {
    scheduleDynamicTask({
      taskId: SUBTITLE_BACKFILL_TASK_ID,
      initialDelayMs: 75_000,
      fallbackIntervalMs: SUBTITLE_BACKFILL_INTERVAL_MS,
      runner: () => runSubtitleBackfillCycle(logger)
    });
  }
}

export function stopRequestSyncSchedule() {
  for (const handle of scheduleHandles.values()) clearTimeout(handle);
  scheduleHandles.clear();
}
