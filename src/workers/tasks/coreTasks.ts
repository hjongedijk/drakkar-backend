import { env } from "../../services/config/env.js";
import type { AppSettings } from "../../services/settings/settingsStore.js";
import { registerTask } from "./taskRegistry.js";

export const REQUEST_SYNC_TASK_ID = "request-sync";
export const REQUEST_RECOVERY_TASK_ID = "request-download-recovery";
export const NZBHYDRA_RSS_SYNC_TASK_ID = "nzbhydra-rss-sync";
export const BACKGROUND_REPAIR_TASK_ID = "background-repair";
export const QUEUE_RECONCILE_TASK_ID = "download-queue-reconcile";
export const IMPORT_RECONCILE_TASK_ID = "import-reconcile";
export const INTERRUPTED_RECOVERY_TASK_ID = "interrupted-download-recovery";
export const NAMING_MIGRATION_TASK_ID = "library-naming-migration";
export const LIBRARY_CLEANUP_TASK_ID = "library-cleanup";
export const LOG_PRUNE_TASK_ID = "log-prune";
export const SUBTITLE_BACKFILL_TASK_ID = "subtitle-backfill";

export const REQUEST_SYNC_INTERVAL_MS = 15 * 60_000;
export const REQUEST_RECOVERY_INTERVAL_MS = 10 * 60_000;
export const NZBHYDRA_RSS_SYNC_INTERVAL_MS = 15 * 60_000;
export const BACKGROUND_REPAIR_INTERVAL_MS = 30 * 60_000;
export const LOG_PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
export const SUBTITLE_BACKFILL_INTERVAL_MS = 6 * 60 * 60_000;

export const DEFAULT_TASK_INTERVALS: Record<string, number | null> = {
  [REQUEST_SYNC_TASK_ID]: null,
  [REQUEST_RECOVERY_TASK_ID]: null,
  [NZBHYDRA_RSS_SYNC_TASK_ID]: null,
  [BACKGROUND_REPAIR_TASK_ID]: null,
  [QUEUE_RECONCILE_TASK_ID]: null,
  [IMPORT_RECONCILE_TASK_ID]: null,
  [INTERRUPTED_RECOVERY_TASK_ID]: REQUEST_SYNC_INTERVAL_MS,
  [NAMING_MIGRATION_TASK_ID]: null,
  [LIBRARY_CLEANUP_TASK_ID]: null,
  [LOG_PRUNE_TASK_ID]: LOG_PRUNE_INTERVAL_MS,
  [SUBTITLE_BACKFILL_TASK_ID]: null
};

export function resolveTaskIntervalMs(taskId: string, settings?: Pick<AppSettings, "taskIntervals"> | null) {
  const override = settings?.taskIntervals?.[taskId];
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  if (override === null) return null;
  return DEFAULT_TASK_INTERVALS[taskId] ?? null;
}

export function registerCoreTasks(settings?: Pick<AppSettings, "taskIntervals"> | null) {
  registerTask({
    id: REQUEST_SYNC_TASK_ID,
    name: "Request Sync",
    description: "One-shot startup Seerr import plus manual full sync. Day-to-day request updates should arrive through the Seerr webhook.",
    intervalMs: resolveTaskIntervalMs(REQUEST_SYNC_TASK_ID, settings),
    enabled: env.REQUEST_SYNC_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: REQUEST_RECOVERY_TASK_ID,
    name: "Request Download Recovery",
    description: "Seed monitored missing requests into the queue and retry selected or failed request downloads in bounded batches.",
    intervalMs: resolveTaskIntervalMs(REQUEST_RECOVERY_TASK_ID, settings),
    enabled: env.REQUEST_SYNC_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: NZBHYDRA_RSS_SYNC_TASK_ID,
    name: "NZBHydra RSS Sync",
    description: "Run broad Movie and TV update queries and cache results so request grabs avoid repeated per-episode API searches.",
    intervalMs: resolveTaskIntervalMs(NZBHYDRA_RSS_SYNC_TASK_ID, settings),
    enabled: true,
    manualRunnable: true
  });
  registerTask({
    id: BACKGROUND_REPAIR_TASK_ID,
    name: "Background Health Check",
    description: "Probe available mounted releases for playable video files and record health-check results.",
    intervalMs: resolveTaskIntervalMs(BACKGROUND_REPAIR_TASK_ID, settings),
    enabled: env.BACKGROUND_REPAIR_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: QUEUE_RECONCILE_TASK_ID,
    name: "Download Queue Reconcile",
    description: "Startup-only rebuild of BullMQ download jobs from database state before workers process queue items.",
    intervalMs: resolveTaskIntervalMs(QUEUE_RECONCILE_TASK_ID, settings),
    enabled: env.STARTUP_RECOVERY_ENABLED,
    manualRunnable: false
  });
  registerTask({
    id: IMPORT_RECONCILE_TASK_ID,
    name: "Import Reconcile",
    description: "Repair available/completed downloads that have no library import or symlink yet.",
    intervalMs: resolveTaskIntervalMs(IMPORT_RECONCILE_TASK_ID, settings),
    enabled: env.STARTUP_RECOVERY_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: INTERRUPTED_RECOVERY_TASK_ID,
    name: "Missing Worker Job Recovery",
    description: "Safely requeue active or queued downloads only when their recorded BullMQ worker job no longer exists.",
    intervalMs: resolveTaskIntervalMs(INTERRUPTED_RECOVERY_TASK_ID, settings),
    enabled: env.STARTUP_RECOVERY_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: NAMING_MIGRATION_TASK_ID,
    name: "Library Naming Migration",
    description: "Move existing imports and symlinks to the current movie/TV naming format.",
    intervalMs: resolveTaskIntervalMs(NAMING_MIGRATION_TASK_ID, settings),
    enabled: true,
    manualRunnable: true
  });
  registerTask({
    id: LIBRARY_CLEANUP_TASK_ID,
    name: "Library Cleanup",
    description: "Prune orphaned links, remove empty library directories, and refresh library state without forcing a full naming migration.",
    intervalMs: resolveTaskIntervalMs(LIBRARY_CLEANUP_TASK_ID, settings),
    enabled: true,
    manualRunnable: true
  });
  registerTask({
    id: LOG_PRUNE_TASK_ID,
    name: "Log Prune",
    description: "Rotate database-backed logs/history by pruning old search history, repair jobs, failed releases, release decisions, and expired blocklist entries.",
    intervalMs: resolveTaskIntervalMs(LOG_PRUNE_TASK_ID, settings),
    enabled: true,
    manualRunnable: true
  });
  registerTask({
    id: SUBTITLE_BACKFILL_TASK_ID,
    name: "Subtitle Backfill",
    description: "Download configured sidecar subtitles for available library items that do not have them yet.",
    intervalMs: resolveTaskIntervalMs(SUBTITLE_BACKFILL_TASK_ID, settings),
    enabled: true,
    manualRunnable: true
  });
}
