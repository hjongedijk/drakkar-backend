import type { FastifyInstance } from "fastify";
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
  registerCoreTasks
} from "../tasks/coreTasks.js";
import { getTask, listTasks, runTrackedTask } from "../tasks/taskRegistry.js";
import { migrateImportsToCurrentNaming, repairSuspiciousImports } from "../import/importService.js";
import { runBackgroundRepairSweep } from "../repair/repairService.js";
import { runDeferredRequestRecovery, runImportReconcileCycle, runInterruptedRecoveryCycle, runLogPruneCycle, runNzbhydraRssSyncCycle, runRequestSyncCycle } from "../requests/sync/scheduler.js";
import { refreshMediaLibrary } from "../media-library/libraryService.js";
import { cleanupSymlinks, pruneLibraryDirectories, removeStaleLibraryFilesystemEntries } from "../symlinks/symlinkService.js";
import { normalizeNzbStoragePaths } from "../downloads/downloadService.js";
import {
  reconcileDownloadQueueState,
} from "../usenet/workers.js";

function taskId(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

const supportedManualTasks = new Set([
  REQUEST_SYNC_TASK_ID,
  REQUEST_RECOVERY_TASK_ID,
  NZBHYDRA_RSS_SYNC_TASK_ID,
  BACKGROUND_REPAIR_TASK_ID,
  QUEUE_RECONCILE_TASK_ID,
  IMPORT_RECONCILE_TASK_ID,
  INTERRUPTED_RECOVERY_TASK_ID,
  NAMING_MIGRATION_TASK_ID,
  LIBRARY_CLEANUP_TASK_ID,
  LOG_PRUNE_TASK_ID
]);
const exclusiveLibraryMaintenanceTasks = new Set([IMPORT_RECONCILE_TASK_ID, NAMING_MIGRATION_TASK_ID, LIBRARY_CLEANUP_TASK_ID]);

async function executeManualTask(id: string, app: FastifyInstance) {
  switch (id) {
    case REQUEST_SYNC_TASK_ID:
      return runRequestSyncCycle(app.log);
    case REQUEST_RECOVERY_TASK_ID:
      return runDeferredRequestRecovery(app.log);
    case NZBHYDRA_RSS_SYNC_TASK_ID:
      return runNzbhydraRssSyncCycle(app.log);
    case BACKGROUND_REPAIR_TASK_ID:
      return runBackgroundRepairSweep(app.log);
    case QUEUE_RECONCILE_TASK_ID:
      return runTrackedTask(id, () => reconcileDownloadQueueState(app.log));
    case IMPORT_RECONCILE_TASK_ID:
      return runImportReconcileCycle(app.log);
    case INTERRUPTED_RECOVERY_TASK_ID:
      return runInterruptedRecoveryCycle(app.log);
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
      return runLogPruneCycle(app.log);
    default:
      throw new Error("Task runner not implemented.");
  }
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  registerCoreTasks();

  app.get("/api/tasks", async () => ({ tasks: listTasks() }));

  app.post("/api/tasks/:id/run", async (request, reply) => {
    const id = taskId(request);
    const task = getTask(id);
    if (!task) return reply.status(404).send({ message: "Task not found." });
    if (!task.manualRunnable) return reply.status(400).send({ message: "Task cannot be run manually." });
    if (task.status === "running") return { task, skipped: true, reason: "already_running" };
    if (!supportedManualTasks.has(id)) return reply.status(404).send({ message: "Task runner not implemented." });
    if (exclusiveLibraryMaintenanceTasks.has(id)) {
      const conflictingTask = [...exclusiveLibraryMaintenanceTasks]
        .filter((maintenanceId) => maintenanceId !== id)
        .map((maintenanceId) => getTask(maintenanceId))
        .find((maintenanceTask) => maintenanceTask?.status === "running");
      if (conflictingTask) {
        return reply.status(409).send({
          task,
          skipped: true,
          reason: "conflicting_task_running",
          conflictingTaskId: conflictingTask.id
        });
      }
    }
    void executeManualTask(id, app).catch((error) => {
      app.log.warn({ err: error, taskId: id }, "manual background task failed");
    });
    return reply.status(202).send({ task: getTask(id), skipped: false, accepted: true });
  });
}
