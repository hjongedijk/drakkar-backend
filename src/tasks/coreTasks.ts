import { env } from "../config/env.js";
import { registerTask } from "./taskRegistry.js";

export const REQUEST_SYNC_TASK_ID = "request-sync";
export const NZBHYDRA_RSS_SYNC_TASK_ID = "nzbhydra-rss-sync";
export const BACKGROUND_REPAIR_TASK_ID = "background-repair";
export const QUEUE_RECONCILE_TASK_ID = "download-queue-reconcile";
export const IMPORT_RECONCILE_TASK_ID = "import-reconcile";
export const INTERRUPTED_RECOVERY_TASK_ID = "interrupted-download-recovery";
export const NAMING_MIGRATION_TASK_ID = "library-naming-migration";
export const LOG_PRUNE_TASK_ID = "log-prune";

export const REQUEST_SYNC_INTERVAL_MS = 60_000;
export const NZBHYDRA_RSS_SYNC_INTERVAL_MS = 15 * 60_000;
export const BACKGROUND_REPAIR_INTERVAL_MS = 10 * 60_000;
export const LOG_PRUNE_INTERVAL_MS = 6 * 60 * 60_000;

export function registerCoreTasks() {
  registerTask({
    id: REQUEST_SYNC_TASK_ID,
    name: "Request Sync",
    description: "Sync Seerr requests, recover failed request downloads, ensure monitored requests, and clean old failed/cancelled history.",
    intervalMs: REQUEST_SYNC_INTERVAL_MS,
    enabled: env.REQUEST_SYNC_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: NZBHYDRA_RSS_SYNC_TASK_ID,
    name: "NZBHydra RSS Sync",
    description: "Run broad Movie and TV update queries and cache results so request grabs avoid repeated per-episode API searches.",
    intervalMs: NZBHYDRA_RSS_SYNC_INTERVAL_MS,
    enabled: true,
    manualRunnable: true
  });
  registerTask({
    id: BACKGROUND_REPAIR_TASK_ID,
    name: "Background Health Check",
    description: "Probe available mounted releases for playable video files and record health-check results.",
    intervalMs: BACKGROUND_REPAIR_INTERVAL_MS,
    enabled: env.BACKGROUND_REPAIR_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: QUEUE_RECONCILE_TASK_ID,
    name: "Download Queue Reconcile",
    description: "Rebuild active BullMQ download jobs from database state so stuck or hidden queue items are recovered.",
    intervalMs: null,
    enabled: env.STARTUP_RECOVERY_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: IMPORT_RECONCILE_TASK_ID,
    name: "Import Reconcile",
    description: "Repair available/completed downloads that have no library import or symlink yet.",
    intervalMs: null,
    enabled: env.STARTUP_RECOVERY_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: INTERRUPTED_RECOVERY_TASK_ID,
    name: "Interrupted Download Recovery",
    description: "Requeue downloads interrupted while fetching, verifying, or downloading.",
    intervalMs: null,
    enabled: env.STARTUP_RECOVERY_ENABLED,
    manualRunnable: true
  });
  registerTask({
    id: NAMING_MIGRATION_TASK_ID,
    name: "Library Naming Migration",
    description: "Move existing imports and symlinks to the current movie/TV naming format.",
    intervalMs: null,
    enabled: true,
    manualRunnable: true
  });
  registerTask({
    id: LOG_PRUNE_TASK_ID,
    name: "Log Prune",
    description: "Rotate database-backed logs by pruning old search history, old repair jobs, and expired blocklist entries.",
    intervalMs: LOG_PRUNE_INTERVAL_MS,
    enabled: true,
    manualRunnable: true
  });
}
