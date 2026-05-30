import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../../../repositories/db/prisma.js";
import { cleanupDownloadHistory } from "../../downloadService.js";
import { refreshNzbhydraUpdateFeeds } from "../../indexers/nzbhydra/client.js";
import { refreshMediaLibrary } from "../../libraryService.js";
import { listActiveStreamSessions } from "../../mountedStream.service.js";
import { reconcileAvailableDownloadsWithoutImports, recoverInterruptedDownloads } from "../../../workers/usenetWorkers.js";
import { pruneLogData } from "../../logPruneService.js";
import { getSettings } from "../../settings/settingsStore.js";
import { IMPORT_RECONCILE_TASK_ID, INTERRUPTED_RECOVERY_TASK_ID, LIBRARY_CLEANUP_TASK_ID, LOG_PRUNE_INTERVAL_MS, LOG_PRUNE_TASK_ID, NAMING_MIGRATION_TASK_ID, NZBHYDRA_RSS_SYNC_INTERVAL_MS, NZBHYDRA_RSS_SYNC_TASK_ID, REQUEST_RECOVERY_INTERVAL_MS, REQUEST_RECOVERY_TASK_ID, REQUEST_SYNC_INTERVAL_MS, REQUEST_SYNC_TASK_ID, SUBTITLE_BACKFILL_INTERVAL_MS, SUBTITLE_BACKFILL_TASK_ID, registerCoreTasks, resolveTaskIntervalMs } from "../../../workers/tasks/coreTasks.js";
import { getTask, runTrackedTask, setTaskNextRun } from "../../../workers/tasks/taskRegistry.js";
import { runSubtitleBackfill } from "../../subtitleService.js";
import {
  backfillPlaceholderRequestMetadata,
  reconcileRequestLinkStates,
  ensureMonitoredRequests,
  recoverFailedRequestDownloads,
  recoverSelectedReleaseDownloads,
  syncRequests
} from "./service.js";
import { getRecentWebdavActivitySummary } from "../../webdavActivity.js";

const scheduleHandles = new Map<string, NodeJS.Timeout>();
let running = false;
let rssRunning = false;
let logPruneRunning = false;
const FULL_REQUEST_SYNC_BATCH_SIZE = 100;
const INCREMENTAL_REQUEST_SYNC_BATCH_SIZE = 200;
const REQUEST_RECOVERY_BATCH_LIMIT = 2;
const REQUEST_RECOVERY_HOT_IO_AVG10 = 8;
const REQUEST_SYNC_CURSOR_KEY_PREFIX = "request-sync.cursor:";
const STARTUP_REQUEST_SYNC_COMPLETED_KEY = "request-sync.startup.completed";
const STARTUP_REQUEST_SYNC_DELAY_MS = 3 * 60_000;
const STARTUP_REQUEST_SYNC_RETRY_DELAY_MS = 2 * 60_000;
let startupRequestSyncScheduled = false;
let startupRequestSyncHandle: NodeJS.Timeout | null = null;

async function ioPressureAvg10() {
  try {
    const raw = await import("node:fs/promises").then(({ readFile }) => readFile("/proc/pressure/io", "utf8"));
    const line = raw.split("\n").find((entry) => entry.startsWith("some "));
    const match = line?.match(/\bavg10=(\d+(?:\.\d+)?)\b/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

async function activeStreamCount() {
  try {
    const streams = await listActiveStreamSessions();
    return streams.filter((stream) => stream.status === "active").length;
  } catch {
    return 0;
  }
}

async function playbackGate() {
  const [ioAvg10, streams] = await Promise.all([ioPressureAvg10(), activeStreamCount()]);
  return { ioAvg10, streams, playbackActive: streams > 0 };
}

async function shouldDeferHeavyStartupSync() {
  const [ioAvg10, streams] = await Promise.all([ioPressureAvg10(), activeStreamCount()]);
  const webdav = getRecentWebdavActivitySummary();
  return {
    ioAvg10,
    streams,
    webdav,
    defer: streams > 0 || ioAvg10 >= REQUEST_RECOVERY_HOT_IO_AVG10 || webdav.scanActive
  };
}

async function shouldDeferRequestRecoveryWork() {
  const gate = await shouldDeferHeavyStartupSync();
  return {
    ...gate,
    defer: gate.defer
  };
}

async function getRequestSyncCursor(providerId: string) {
  const row = await prisma.setting.findUnique({ where: { key: `${REQUEST_SYNC_CURSOR_KEY_PREFIX}${providerId}` } });
  const value = row?.value as { skip?: unknown } | undefined;
  const skip = typeof value?.skip === "number" && Number.isFinite(value.skip) && value.skip >= 0 ? Math.floor(value.skip) : 0;
  return skip;
}

async function setRequestSyncCursor(providerId: string, skip: number) {
  await prisma.setting.upsert({
    where: { key: `${REQUEST_SYNC_CURSOR_KEY_PREFIX}${providerId}` },
    update: { value: { skip } },
    create: { key: `${REQUEST_SYNC_CURSOR_KEY_PREFIX}${providerId}`, value: { skip } }
  });
}

async function hasCompletedStartupRequestSync() {
  const row = await prisma.setting.findUnique({ where: { key: STARTUP_REQUEST_SYNC_COMPLETED_KEY } });
  return Boolean(row);
}

async function markStartupRequestSyncCompleted() {
  await prisma.setting.upsert({
    where: { key: STARTUP_REQUEST_SYNC_COMPLETED_KEY },
    update: { value: { completedAt: new Date().toISOString() } },
    create: { key: STARTUP_REQUEST_SYNC_COMPLETED_KEY, value: { completedAt: new Date().toISOString() } }
  });
}

async function configuredTaskInterval(taskId: string, fallback: number | null) {
  const settings = await getSettings().catch(() => null);
  registerCoreTasks(settings ?? undefined);
  const resolved = resolveTaskIntervalMs(taskId, settings);
  return resolved === undefined ? fallback : resolved;
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

function isTaskRunning(id: string) {
  return getTask(id)?.status === "running";
}

function hasConflictingHeavyTask(taskIds: readonly string[]) {
  return taskIds.find((taskId) => isTaskRunning(taskId)) ?? null;
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
  const gate = await shouldDeferRequestRecoveryWork();
  if (gate.defer) {
    logger.info({
      activeStreamCount: gate.streams,
      ioAvg10: gate.ioAvg10,
      mediaPropfindCount: gate.webdav.mediaPropfindCount,
      propfindCount: gate.webdav.propfindCount
    }, "request recovery deferred because playback, library scan, or hot IO is active");
    return { started: false, reason: "hot_io_or_scan_active" as const, ...gate };
  }
  const conflictingTaskId = hasConflictingHeavyTask([
    IMPORT_RECONCILE_TASK_ID,
    INTERRUPTED_RECOVERY_TASK_ID,
    NAMING_MIGRATION_TASK_ID,
    LIBRARY_CLEANUP_TASK_ID
  ]);
  if (conflictingTaskId) {
    return { started: false, reason: "conflicting_task_running" as const, conflictingTaskId };
  }
  try {
    const result = await runTrackedTask(REQUEST_RECOVERY_TASK_ID, async () => {
      const recoveryBatchLimit = REQUEST_RECOVERY_BATCH_LIMIT;
      const linkReconcile = await reconcileRequestLinkStates();
      if (linkReconcile.updated > 0) logger.info(linkReconcile, "request/download link states reconciled");
      const monitored = await ensureMonitoredRequests(logger, {
        activeWantedSearchLimit: undefined,
        timeoutBudget: undefined
      });
      if (monitored.retried > 0 || monitored.skippedBecauseQueueFull > 0) {
        logger.info({
          retried: monitored.retried,
          queueSeedTarget: monitored.queueSeedTarget,
          pendingQueueItems: monitored.pendingQueueItems,
          skippedBecauseQueueFull: monitored.skippedBecauseQueueFull
        }, "monitored request queue seeding completed");
      }
      const selectedReleaseRecovery = await recoverSelectedReleaseDownloads({ limit: recoveryBatchLimit });
      if (selectedReleaseRecovery.recovered > 0) {
        logger.info({ recovered: selectedReleaseRecovery.recovered }, "selected releases without downloads were re-queued");
      }
      const failedRecovery = await recoverFailedRequestDownloads({ limit: recoveryBatchLimit });
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
  const gate = await playbackGate();
  if (gate.playbackActive) {
    return {
      started: false,
      reason: "playback_active" as const,
      activeStreamCount: gate.streams,
      ioAvg10: gate.ioAvg10
    };
  }
  if (isLibraryMaintenanceRunning(NAMING_MIGRATION_TASK_ID) || isLibraryMaintenanceRunning(LIBRARY_CLEANUP_TASK_ID)) {
    return { started: false, reason: "conflicting_task_running" as const };
  }
  const conflictingTaskId = hasConflictingHeavyTask([
    REQUEST_RECOVERY_TASK_ID,
    INTERRUPTED_RECOVERY_TASK_ID
  ]);
  if (conflictingTaskId) {
    return { started: false, reason: "conflicting_task_running" as const, conflictingTaskId };
  }
  try {
    const result = await runTrackedTask(IMPORT_RECONCILE_TASK_ID, async () => {
      const reconciliation = await reconcileAvailableDownloadsWithoutImports(logger);
      if (reconciliation.mountedFixed > 0 || reconciliation.requeued > 0 || reconciliation.failed > 0) {
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
  const conflictingTaskId = hasConflictingHeavyTask([
    REQUEST_RECOVERY_TASK_ID,
    IMPORT_RECONCILE_TASK_ID,
    NAMING_MIGRATION_TASK_ID,
    LIBRARY_CLEANUP_TASK_ID
  ]);
  if (conflictingTaskId) {
    return { started: false, reason: "conflicting_task_running" as const, conflictingTaskId };
  }
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
      const linkReconcile = await reconcileRequestLinkStates();
      const library = await refreshMediaLibrary();
      logger.info({
        imported: aggregate.imported,
        updated: aggregate.updated,
        skipped: aggregate.skipped,
        fetched: aggregate.fetched,
        failedProviders: aggregate.failedProviders,
        metadataUpdated: metadataBackfill.updated,
        linkStatesUpdated: linkReconcile.updated,
        libraryRefreshed: library.refreshed
      }, "full request resync and library refresh completed");
      return aggregate;
    });
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
  const gate = await shouldDeferHeavyStartupSync();
  if (gate.defer) {
    logger.info({
      activeStreamCount: gate.streams,
      ioAvg10: gate.ioAvg10,
      mediaPropfindCount: gate.webdav.mediaPropfindCount,
      propfindCount: gate.webdav.propfindCount
    }, "request sync deferred because playback, library scan, or hot IO is active");
    return;
  }
  running = true;
  try {
    await runTrackedTask(REQUEST_SYNC_TASK_ID, async () => {
      const providers = await prisma.requestProvider.findMany({
        where: { enabled: true, type: "seerr" },
        select: { id: true, name: true }
      });
      const sync = {
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
        const skip = await getRequestSyncCursor(provider.id);
        const batch = await syncRequests(provider.id, {
          full: true,
          skip,
          maxRequests: INCREMENTAL_REQUEST_SYNC_BATCH_SIZE,
          pageSize: INCREMENTAL_REQUEST_SYNC_BATCH_SIZE,
          refreshLibrary: false
        });
        sync.imported += batch.imported;
        sync.updated += batch.updated;
        sync.skipped += batch.skipped;
        sync.fetched += batch.fetched;
        sync.failedProviders += batch.failedProviders;
        sync.autoGrabbed += batch.autoGrabbed;
        sync.budgetExceeded = sync.budgetExceeded || batch.budgetExceeded;
        sync.requests.push(...batch.requests);
        sync.providerResults.push(...batch.providerResults);

        const nextSkip = batch.fetched < INCREMENTAL_REQUEST_SYNC_BATCH_SIZE ? 0 : skip + INCREMENTAL_REQUEST_SYNC_BATCH_SIZE;
        await setRequestSyncCursor(provider.id, nextSkip);
        logger.info({
          providerId: provider.id,
          providerName: provider.name,
          skip,
          nextSkip,
          batchFetched: batch.fetched,
          batchImported: batch.imported,
          batchUpdated: batch.updated,
          batchSkipped: batch.skipped
        }, "request sync batch completed");
      }

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
      const linkReconcile = await reconcileRequestLinkStates();
      if (linkReconcile.updated > 0) logger.info(linkReconcile, "request/download link states reconciled");
      const cleanup = await cleanupDownloadHistory({ keepFailed: 0, keepCancelled: 0 });
      if (cleanup.deleted > 0 || cleanup.cleanedFailedJobs > 0) logger.info(cleanup, "download history auto-cleaned");
      return sync;
    });
    await runInterruptedRecoveryCycle(logger);
    await runImportReconcileCycle(logger);
  } catch (error) {
    logger.warn({ err: error }, "request sync/recovery failed");
  } finally {
    running = false;
  }
}

export function startRequestSyncSchedule(logger: FastifyBaseLogger) {
  void getSettings().then((settings) => registerCoreTasks(settings)).catch(() => registerCoreTasks());
  if (!startupRequestSyncScheduled) {
    startupRequestSyncScheduled = true;
    void hasCompletedStartupRequestSync().then((completed) => {
      if (completed) {
        logger.info("startup request sync skipped because it already completed on a previous boot");
        setTaskNextRun(REQUEST_SYNC_TASK_ID, null);
        return;
      }
      setTaskNextRun(REQUEST_SYNC_TASK_ID, new Date(Date.now() + STARTUP_REQUEST_SYNC_DELAY_MS));
      const scheduleStartupAttempt = (delayMs: number) => {
        startupRequestSyncHandle = setTimeout(() => {
          void (async () => {
            const gate = await shouldDeferHeavyStartupSync();
            if (gate.defer) {
              logger.info({ activeStreamCount: gate.streams, ioAvg10: gate.ioAvg10, mediaPropfindCount: gate.webdav.mediaPropfindCount, propfindCount: gate.webdav.propfindCount, retryDelayMs: STARTUP_REQUEST_SYNC_RETRY_DELAY_MS }, "startup request sync deferred because playback, library scan, or hot IO is active");
              setTaskNextRun(REQUEST_SYNC_TASK_ID, new Date(Date.now() + STARTUP_REQUEST_SYNC_RETRY_DELAY_MS));
              scheduleStartupAttempt(STARTUP_REQUEST_SYNC_RETRY_DELAY_MS);
              return;
            }
            await runFullRequestSyncRefresh(logger);
            await markStartupRequestSyncCompleted().catch((error) => {
              logger.warn({ err: error }, "failed to persist startup request sync stamp");
            });
            setTaskNextRun(REQUEST_SYNC_TASK_ID, null);
          })();
        }, delayMs);
      };
      scheduleStartupAttempt(STARTUP_REQUEST_SYNC_DELAY_MS);
    });
  }
  if (!scheduleHandles.has(REQUEST_RECOVERY_TASK_ID)) {
    void configuredTaskInterval(REQUEST_RECOVERY_TASK_ID, REQUEST_RECOVERY_INTERVAL_MS).then((intervalMs) => {
      if (!intervalMs) {
        setTaskNextRun(REQUEST_RECOVERY_TASK_ID, null);
        return;
      }
      scheduleDynamicTask({
        taskId: REQUEST_RECOVERY_TASK_ID,
        initialDelayMs: intervalMs,
        fallbackIntervalMs: REQUEST_RECOVERY_INTERVAL_MS,
        runner: () => runDeferredRequestRecovery(logger).then(() => undefined)
      });
    });
  }
  if (!scheduleHandles.has(NZBHYDRA_RSS_SYNC_TASK_ID)) {
    void configuredTaskInterval(NZBHYDRA_RSS_SYNC_TASK_ID, NZBHYDRA_RSS_SYNC_INTERVAL_MS).then((intervalMs) => {
      if (!intervalMs) {
        setTaskNextRun(NZBHYDRA_RSS_SYNC_TASK_ID, null);
        return;
      }
      scheduleDynamicTask({
        taskId: NZBHYDRA_RSS_SYNC_TASK_ID,
        initialDelayMs: Math.min(intervalMs, 10 * 60_000),
        fallbackIntervalMs: NZBHYDRA_RSS_SYNC_INTERVAL_MS,
        runner: () => runNzbhydraRssSyncCycle(logger)
      });
    });
  }
  if (!scheduleHandles.has(LOG_PRUNE_TASK_ID)) {
    void configuredTaskInterval(LOG_PRUNE_TASK_ID, LOG_PRUNE_INTERVAL_MS).then((intervalMs) => {
      if (!intervalMs) {
        setTaskNextRun(LOG_PRUNE_TASK_ID, null);
        return;
      }
      scheduleDynamicTask({
        taskId: LOG_PRUNE_TASK_ID,
        initialDelayMs: Math.min(intervalMs, 10 * 60_000),
        fallbackIntervalMs: LOG_PRUNE_INTERVAL_MS,
        runner: () => runLogPruneCycle(logger)
      });
    });
  }
  if (!scheduleHandles.has(SUBTITLE_BACKFILL_TASK_ID)) {
    void configuredTaskInterval(SUBTITLE_BACKFILL_TASK_ID, SUBTITLE_BACKFILL_INTERVAL_MS).then((intervalMs) => {
      if (!intervalMs) {
        setTaskNextRun(SUBTITLE_BACKFILL_TASK_ID, null);
        return;
      }
      scheduleDynamicTask({
        taskId: SUBTITLE_BACKFILL_TASK_ID,
        initialDelayMs: Math.min(intervalMs, 15 * 60_000),
        fallbackIntervalMs: SUBTITLE_BACKFILL_INTERVAL_MS,
        runner: () => runSubtitleBackfillCycle(logger)
      });
    });
  }
}

export function stopRequestSyncSchedule() {
  for (const handle of scheduleHandles.values()) clearTimeout(handle);
  scheduleHandles.clear();
  if (startupRequestSyncHandle) clearTimeout(startupRequestSyncHandle);
  startupRequestSyncHandle = null;
  startupRequestSyncScheduled = false;
}
