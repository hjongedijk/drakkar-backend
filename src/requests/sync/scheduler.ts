import type { FastifyBaseLogger } from "fastify";
import { cleanupDownloadHistory } from "../../downloads/downloadService.js";
import { refreshNzbhydraUpdateFeeds } from "../../indexers/nzbhydra/client.js";
import { reconcileAvailableDownloadsWithoutImports } from "../../usenet/workers.js";
import { pruneLogData } from "../../logs/logPruneService.js";
import { getSettings } from "../../settings/settingsStore.js";
import { LOG_PRUNE_INTERVAL_MS, LOG_PRUNE_TASK_ID, NZBHYDRA_RSS_SYNC_INTERVAL_MS, NZBHYDRA_RSS_SYNC_TASK_ID, REQUEST_SYNC_INTERVAL_MS, REQUEST_SYNC_TASK_ID, registerCoreTasks } from "../../tasks/coreTasks.js";
import { runTrackedTask, setTaskNextRun } from "../../tasks/taskRegistry.js";
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
let runningStartedAt = 0;
let rssRunning = false;
let rssRunningStartedAt = 0;
let logPruneRunning = false;
let logPruneRunningStartedAt = 0;
const STALE_SCHEDULER_GUARD_MS = 15 * 60_000;

function schedulerFlagIsStale(startedAt: number) {
  return startedAt > 0 && Date.now() - startedAt > STALE_SCHEDULER_GUARD_MS;
}

export async function runLogPruneCycle(logger: FastifyBaseLogger) {
  if (logPruneRunning && !schedulerFlagIsStale(logPruneRunningStartedAt)) return;
  if (logPruneRunning && schedulerFlagIsStale(logPruneRunningStartedAt)) {
    logger.warn({ task: LOG_PRUNE_TASK_ID }, "recovered stale in-memory scheduler lock");
  }
  logPruneRunning = true;
  logPruneRunningStartedAt = Date.now();
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
    logPruneRunningStartedAt = 0;
    setTaskNextRun(LOG_PRUNE_TASK_ID, new Date(Date.now() + LOG_PRUNE_INTERVAL_MS));
  }
}

export async function runNzbhydraRssSyncCycle(logger: FastifyBaseLogger) {
  if (rssRunning && !schedulerFlagIsStale(rssRunningStartedAt)) return;
  if (rssRunning && schedulerFlagIsStale(rssRunningStartedAt)) {
    logger.warn({ task: NZBHYDRA_RSS_SYNC_TASK_ID }, "recovered stale in-memory scheduler lock");
  }
  rssRunning = true;
  rssRunningStartedAt = Date.now();
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
    rssRunningStartedAt = 0;
    setTaskNextRun(NZBHYDRA_RSS_SYNC_TASK_ID, new Date(Date.now() + NZBHYDRA_RSS_SYNC_INTERVAL_MS));
  }
}

export async function runRequestSyncCycle(logger: FastifyBaseLogger) {
  if (running && !schedulerFlagIsStale(runningStartedAt)) return;
  if (running && schedulerFlagIsStale(runningStartedAt)) {
    logger.warn({ task: REQUEST_SYNC_TASK_ID }, "recovered stale in-memory scheduler lock");
  }
  running = true;
  runningStartedAt = Date.now();
  try {
    await runTrackedTask(REQUEST_SYNC_TASK_ID, async () => {
      const sync = await syncRequests();
      logger.info({
        fetched: sync.fetched,
        imported: sync.imported,
        updated: sync.updated,
        skipped: sync.skipped,
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
      const importReconcile = await reconcileAvailableDownloadsWithoutImports(logger);
      if (importReconcile.mountedFixed > 0 || importReconcile.materializedImported > 0 || importReconcile.requeued > 0 || importReconcile.failed > 0) {
        logger.info(importReconcile, "stale prepared/available imports reconciled");
      }
      await recoverFailedRequestDownloads();
      const selectedReleaseRecovery = await recoverSelectedReleaseDownloads();
      if (selectedReleaseRecovery.recovered > 0) {
        logger.info({ recovered: selectedReleaseRecovery.recovered }, "selected releases without downloads were re-queued");
      }
      const metadataBackfill = await backfillPlaceholderRequestMetadata();
      if (metadataBackfill.updated > 0) {
        logger.info(metadataBackfill, "placeholder request titles backfilled from metadata");
      }
      const monitored = await ensureMonitoredRequests();
      if (monitored.retried > 0 || monitored.skippedBecauseQueueFull > 0) {
        logger.info({
          retried: monitored.retried,
          queueSeedTarget: monitored.queueSeedTarget,
          pendingQueueItems: monitored.pendingQueueItems,
          skippedBecauseQueueFull: monitored.skippedBecauseQueueFull
        }, "monitored request queue seeding completed");
      }
      const cleanup = await cleanupDownloadHistory({ keepFailed: 0, keepCancelled: 0 });
      if (cleanup.deleted > 0 || cleanup.cleanedFailedJobs > 0) logger.info(cleanup, "download history auto-cleaned");
      return sync;
    });
  } catch (error) {
    logger.warn({ err: error }, "request sync/recovery failed");
  } finally {
    running = false;
    runningStartedAt = 0;
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
