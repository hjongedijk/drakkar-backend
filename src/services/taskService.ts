import type { FastifyBaseLogger } from "fastify";
import {
  BACKGROUND_REPAIR_TASK_ID,
  IMPORT_RECONCILE_TASK_ID,
  INTERRUPTED_RECOVERY_TASK_ID,
  LIBRARY_CLEANUP_TASK_ID,
  LOG_PRUNE_TASK_ID,
  NAMING_MIGRATION_TASK_ID,
  NZBHYDRA_RSS_SYNC_TASK_ID,
  QUEUE_RECONCILE_TASK_ID,
  REQUEST_RECOVERY_TASK_ID,
  REQUEST_SYNC_TASK_ID,
  SUBTITLE_BACKFILL_TASK_ID
} from "../workers/tasks/coreTasks.js";
import { runTrackedTask } from "../workers/tasks/taskRegistry.js";
import { migrateImportsToCurrentNaming, repairSuspiciousImports } from "../services/importService.js";
import { runBackgroundRepairSweep } from "../services/repairService.js";
import { runDeferredRequestRecovery, runImportReconcileCycle, runInterruptedRecoveryCycle, runLogPruneCycle, runNzbhydraRssSyncCycle, runRequestSyncCycle } from "../services/requests/sync/scheduler.js";
import { refreshMediaLibrary } from "../services/libraryService.js";
import { cleanupSymlinks, pruneLibraryDirectories, removeStaleLibraryFilesystemEntries } from "../services/symlinkService.js";
import { normalizeNzbStoragePaths } from "../services/downloadService.js";
import { runSubtitleBackfill } from "../services/subtitleService.js";
import { reconcileDownloadQueueState } from "../workers/usenetWorkers.js";

export const supportedManualTasks = new Set([
  REQUEST_SYNC_TASK_ID,
  REQUEST_RECOVERY_TASK_ID,
  NZBHYDRA_RSS_SYNC_TASK_ID,
  BACKGROUND_REPAIR_TASK_ID,
  QUEUE_RECONCILE_TASK_ID,
  IMPORT_RECONCILE_TASK_ID,
  INTERRUPTED_RECOVERY_TASK_ID,
  NAMING_MIGRATION_TASK_ID,
  LIBRARY_CLEANUP_TASK_ID,
  LOG_PRUNE_TASK_ID,
  SUBTITLE_BACKFILL_TASK_ID
]);

export const exclusiveLibraryMaintenanceTasks = new Set([
  IMPORT_RECONCILE_TASK_ID,
  NAMING_MIGRATION_TASK_ID,
  LIBRARY_CLEANUP_TASK_ID
]);

export async function executeManualTask(id: string, logger: FastifyBaseLogger) {
  switch (id) {
    case REQUEST_SYNC_TASK_ID:
      return runRequestSyncCycle(logger);
    case REQUEST_RECOVERY_TASK_ID:
      return runDeferredRequestRecovery(logger);
    case NZBHYDRA_RSS_SYNC_TASK_ID:
      return runNzbhydraRssSyncCycle(logger);
    case BACKGROUND_REPAIR_TASK_ID:
      return runBackgroundRepairSweep(logger);
    case QUEUE_RECONCILE_TASK_ID:
      return runTrackedTask(id, () => reconcileDownloadQueueState(logger));
    case IMPORT_RECONCILE_TASK_ID:
      return runImportReconcileCycle(logger);
    case INTERRUPTED_RECOVERY_TASK_ID:
      return runInterruptedRecoveryCycle(logger);
    case NAMING_MIGRATION_TASK_ID:
      return runTrackedTask(id, async () => {
        const migrated = await migrateImportsToCurrentNaming();
        const repaired = await repairSuspiciousImports({ limit: 50 });
        return { migrated, repaired };
      });
    case LIBRARY_CLEANUP_TASK_ID:
      return runTrackedTask(id, async () => {
        const symlinkCleanup = await cleanupSymlinks();
        const staleFilesystem = await removeStaleLibraryFilesystemEntries();
        const pruned = await pruneLibraryDirectories();
        const nzbPaths = await normalizeNzbStoragePaths();
        const suspicious = await repairSuspiciousImports({ limit: 50 });
        await refreshMediaLibrary();
        return { symlinkCleanup, staleFilesystem, pruned, nzbPaths, suspicious };
      });
    case LOG_PRUNE_TASK_ID:
      return runLogPruneCycle(logger);
    case SUBTITLE_BACKFILL_TASK_ID:
      return runSubtitleBackfill(logger);
    default:
      throw new Error("Task runner not implemented.");
  }
}
