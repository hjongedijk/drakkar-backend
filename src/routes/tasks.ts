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
  REQUEST_SYNC_TASK_ID,
  registerCoreTasks
} from "../tasks/coreTasks.js";
import { getTask, listTasks, runTrackedTask } from "../tasks/taskRegistry.js";
import { migrateImportsToCurrentNaming } from "../import/importService.js";
import { runBackgroundRepairSweep } from "../repair/repairService.js";
import { runLogPruneCycle, runNzbhydraRssSyncCycle, runRequestSyncCycle } from "../requests/sync/scheduler.js";
import { refreshMediaLibrary } from "../media-library/libraryService.js";
import { cleanupSymlinks, pruneLibraryDirectories } from "../symlinks/symlinkService.js";
import { normalizeNzbStoragePaths } from "../downloads/downloadService.js";
import {
  reconcileAvailableDownloadsWithoutImports,
  reconcileDownloadQueueState,
  recoverInterruptedDownloads
} from "../usenet/workers.js";

function taskId(request: { params: unknown }) {
  return (request.params as { id: string }).id;
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

    let result: unknown;
    switch (id) {
      case REQUEST_SYNC_TASK_ID:
        result = await runRequestSyncCycle(app.log);
        break;
      case NZBHYDRA_RSS_SYNC_TASK_ID:
        result = await runNzbhydraRssSyncCycle(app.log);
        break;
      case BACKGROUND_REPAIR_TASK_ID:
        result = await runBackgroundRepairSweep(app.log);
        break;
      case QUEUE_RECONCILE_TASK_ID:
        result = await runTrackedTask(id, () => reconcileDownloadQueueState(app.log));
        break;
      case IMPORT_RECONCILE_TASK_ID:
        result = await runTrackedTask(id, () => reconcileAvailableDownloadsWithoutImports(app.log));
        break;
      case INTERRUPTED_RECOVERY_TASK_ID:
        result = await runTrackedTask(id, () => recoverInterruptedDownloads(app.log));
        break;
      case NAMING_MIGRATION_TASK_ID:
        result = await runTrackedTask(id, () => migrateImportsToCurrentNaming());
        break;
      case LIBRARY_CLEANUP_TASK_ID:
        result = await runTrackedTask(id, async () => {
          const symlinkCleanup = await cleanupSymlinks();
          const pruned = await pruneLibraryDirectories();
          const nzbPaths = await normalizeNzbStoragePaths();
          await refreshMediaLibrary();
          return { symlinkCleanup, pruned, nzbPaths };
        });
        break;
      case LOG_PRUNE_TASK_ID:
        result = await runLogPruneCycle(app.log);
        break;
      default:
        return reply.status(404).send({ message: "Task runner not implemented." });
    }

    return { task: getTask(id), skipped: false, result };
  });
}
