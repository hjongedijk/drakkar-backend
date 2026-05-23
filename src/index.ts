import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { redis } from "./db/redis.js";
import { pipelineQueues } from "./queues/downloadQueue.js";
import { buildApp } from "./app.js";
import { migrateImportsToCurrentNaming } from "./import/importService.js";
import { validateRequiredFolders } from "./utils/folders.js";
import { startRequestSyncSchedule, stopRequestSyncSchedule } from "./requests/sync/scheduler.js";
import {
  reconcileAvailableDownloadsWithoutImports,
  reconcileDownloadQueueState,
  recoverStaleActiveDownloadJobs,
  recoverInterruptedDownloads,
  startDownloadWorkers,
  stopDownloadWorkers
} from "./usenet/workers.js";
import { primeMountedStreamPool } from "./streaming/mountedStream.service.js";
import { startFuseMount, stopFuseMount } from "./vfs/fuseMountService.js";
import { startBackgroundRepairSchedule, stopBackgroundRepairSchedule } from "./repair/repairService.js";
import { bootstrapDevelopmentTestConnectionData } from "./dev/testConnectionData.js";
import { bootstrapRuntimeConfiguredServices } from "./config/runtimeConfigBootstrap.js";
import {
  IMPORT_RECONCILE_TASK_ID,
  INTERRUPTED_RECOVERY_TASK_ID,
  NAMING_MIGRATION_TASK_ID,
  QUEUE_RECONCILE_TASK_ID
} from "./tasks/coreTasks.js";
import { markTaskCompleted, runTrackedTask } from "./tasks/taskRegistry.js";

const app = buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  stopRequestSyncSchedule();
  stopBackgroundRepairSchedule();
  await stopDownloadWorkers();
  await stopFuseMount(app.log);
  await Promise.all(pipelineQueues.map((queue) => queue.close()));
  await redis.quit();
  await prisma.$disconnect();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

try {
  await validateRequiredFolders(app.log);
  await bootstrapRuntimeConfiguredServices(app.log);
  await bootstrapDevelopmentTestConnectionData(app.log);
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  void (async () => {
    try {
      const namingMigration = await runTrackedTask(NAMING_MIGRATION_TASK_ID, () => migrateImportsToCurrentNaming());
      markTaskCompleted(NAMING_MIGRATION_TASK_ID);
      if (namingMigration && (namingMigration.moved > 0 || namingMigration.relinked > 0)) {
        app.log.info({ namingMigration }, "library naming migration completed");
      }
      if (env.STARTUP_RECOVERY_ENABLED) {
        await recoverStaleActiveDownloadJobs(app.log);
        await runTrackedTask(QUEUE_RECONCILE_TASK_ID, () => reconcileDownloadQueueState(app.log));
        if (env.DOWNLOAD_WORKERS_ENABLED) startDownloadWorkers(app.log);
        else app.log.warn("download workers disabled by config");
        await runTrackedTask(IMPORT_RECONCILE_TASK_ID, () => reconcileAvailableDownloadsWithoutImports(app.log));
        await runTrackedTask(INTERRUPTED_RECOVERY_TASK_ID, () => recoverInterruptedDownloads(app.log));
      } else {
        app.log.warn("startup recovery disabled by config");
        if (env.DOWNLOAD_WORKERS_ENABLED) startDownloadWorkers(app.log);
        else app.log.warn("download workers disabled by config");
      }
    } catch (error) {
      app.log.error({ err: error }, "background queue recovery failed during startup");
    }
  })();
  await startFuseMount(app.log);
  if (env.STREAM_POOL_PRIME_ENABLED) {
    void primeMountedStreamPool().catch((error) => {
      app.log.debug({ err: error }, "mounted stream pool prewarm skipped");
    });
  } else {
    app.log.warn("mounted stream pool prewarm disabled by config");
  }
  if (env.REQUEST_SYNC_ENABLED) startRequestSyncSchedule(app.log);
  if (env.BACKGROUND_REPAIR_ENABLED) startBackgroundRepairSchedule(app.log);
} catch (error) {
  app.log.error({ err: error }, "startup failed");
  process.exit(1);
}
