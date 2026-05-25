import type { FastifyBaseLogger } from "fastify";
import { cleanupDownloadHistory } from "../../downloads/downloadService.js";
import { refreshNzbhydraUpdateFeeds } from "../../indexers/nzbhydra/client.js";
import { refreshMediaLibrary } from "../../media-library/libraryService.js";
import { reconcileAvailableDownloadsWithoutImports, recoverInterruptedDownloads } from "../../usenet/workers.js";
import { pruneLogData } from "../../logs/logPruneService.js";
import { getSettings } from "../../settings/settingsStore.js";
import { IMPORT_RECONCILE_TASK_ID, INTERRUPTED_RECOVERY_TASK_ID, LIBRARY_CLEANUP_TASK_ID, LOG_PRUNE_INTERVAL_MS, LOG_PRUNE_TASK_ID, NAMING_MIGRATION_TASK_ID, NZBHYDRA_RSS_SYNC_INTERVAL_MS, NZBHYDRA_RSS_SYNC_TASK_ID, REQUEST_RECOVERY_TASK_ID, REQUEST_SYNC_INTERVAL_MS, REQUEST_SYNC_TASK_ID, registerCoreTasks } from "../../tasks/coreTasks.js";
import { getTask, runTrackedTask, setTaskNextRun } from "../../tasks/taskRegistry.js";
import {
  backfillPlaceholderRequestMetadata,
  ensureMonitoredRequests,
  recoverFailedRequestDownloads,
  recoverSelectedReleaseDownloads,
  syncRequests
} from "./service.js";

let timer: NodeJS.Timeout | undefined;
let initialTimer: NodeJS.Timeout | undefined;
let rssTimer: NodeJS.Timeout | undefined;
let rssInitialTimer: NodeJS.Timeout | undefined;
let logPruneTimer: NodeJS.Timeout | undefined;
let logPruneInitialTimer: NodeJS.Timeout | undefined;
let running = false;
let rssRunning = false;
let logPruneRunning = false;

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
    setTaskNextRun(LOG_PRUNE_TASK_ID, new Date(Date.now() + LOG_PRUNE_INTERVAL_MS));
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
    setTaskNextRun(NZBHYDRA_RSS_SYNC_TASK_ID, new Date(Date.now() + NZBHYDRA_RSS_SYNC_INTERVAL_MS));
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
      const selectedReleaseRecovery = await recoverSelectedReleaseDownloads({ limit: 2 });
      if (selectedReleaseRecovery.recovered > 0) {
        logger.info({ recovered: selectedReleaseRecovery.recovered }, "selected releases without downloads were re-queued");
      }
      const failedRecovery = await recoverFailedRequestDownloads({ limit: 2 });
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
  } finally {
    setTaskNextRun(INTERRUPTED_RECOVERY_TASK_ID, new Date(Date.now() + REQUEST_SYNC_INTERVAL_MS));
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
      const sync = await syncRequests(providerId, { full: true });
      const metadataBackfill = await backfillPlaceholderRequestMetadata();
      const library = await refreshMediaLibrary();
      logger.info({
        imported: sync.imported,
        updated: sync.updated,
        skipped: sync.skipped,
        budgetExceeded: sync.budgetExceeded,
        metadataUpdated: metadataBackfill.updated,
        libraryRefreshed: library.refreshed
      }, "full request resync and library refresh completed");
      return sync;
    });
    void runDeferredRequestRecovery(logger);
    return { started: true };
  } catch (error) {
    logger.warn({ err: error }, "full request resync and library refresh failed");
    return { started: true, error };
  } finally {
    running = false;
    setTaskNextRun(REQUEST_SYNC_TASK_ID, new Date(Date.now() + REQUEST_SYNC_INTERVAL_MS));
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
    setTaskNextRun(REQUEST_SYNC_TASK_ID, new Date(Date.now() + REQUEST_SYNC_INTERVAL_MS));
  }
}

export function startRequestSyncSchedule(logger: FastifyBaseLogger) {
  registerCoreTasks();
  if (!timer && !initialTimer) {
    setTaskNextRun(REQUEST_SYNC_TASK_ID, new Date(Date.now() + 30_000));
    initialTimer = setTimeout(() => {
      initialTimer = undefined;
      void runRequestSyncCycle(logger);
    }, 30_000);
    timer = setInterval(() => {
      void runRequestSyncCycle(logger);
    }, REQUEST_SYNC_INTERVAL_MS);
  }
  if (!rssTimer && !rssInitialTimer) {
    setTaskNextRun(NZBHYDRA_RSS_SYNC_TASK_ID, new Date(Date.now() + 15_000));
    rssInitialTimer = setTimeout(() => {
      rssInitialTimer = undefined;
      void runNzbhydraRssSyncCycle(logger);
    }, 15_000);
    rssTimer = setInterval(() => {
      void runNzbhydraRssSyncCycle(logger);
    }, NZBHYDRA_RSS_SYNC_INTERVAL_MS);
  }
  if (!logPruneTimer && !logPruneInitialTimer) {
    setTaskNextRun(LOG_PRUNE_TASK_ID, new Date(Date.now() + 60_000));
    logPruneInitialTimer = setTimeout(() => {
      logPruneInitialTimer = undefined;
      void runLogPruneCycle(logger);
    }, 60_000);
    logPruneTimer = setInterval(() => {
      void runLogPruneCycle(logger);
    }, LOG_PRUNE_INTERVAL_MS);
  }
}

export function stopRequestSyncSchedule() {
  if (initialTimer) clearTimeout(initialTimer);
  if (timer) clearInterval(timer);
  if (rssInitialTimer) clearTimeout(rssInitialTimer);
  if (rssTimer) clearInterval(rssTimer);
  if (logPruneInitialTimer) clearTimeout(logPruneInitialTimer);
  if (logPruneTimer) clearInterval(logPruneTimer);
  initialTimer = undefined;
  timer = undefined;
  rssInitialTimer = undefined;
  rssTimer = undefined;
  logPruneInitialTimer = undefined;
  logPruneTimer = undefined;
}
