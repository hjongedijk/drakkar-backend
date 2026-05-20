import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { redis } from "./db/redis.js";
import { pipelineQueues } from "./queues/downloadQueue.js";
import { buildApp } from "./app.js";
import { migrateImportsToCurrentNaming } from "./import/importService.js";
import { validateRequiredFolders } from "./utils/folders.js";
import { startRequestSyncSchedule, stopRequestSyncSchedule } from "./requests/sync/scheduler.js";
import { reconcileDownloadQueueState, recoverInterruptedDownloads, startDownloadWorkers, stopDownloadWorkers } from "./usenet/workers.js";
import { startFuseMount, stopFuseMount } from "./vfs/fuseMountService.js";
import { startBackgroundRepairSchedule, stopBackgroundRepairSchedule } from "./repair/repairService.js";
import { ensureDefaultAdminUser } from "./auth/service.js";
import { bootstrapDevelopmentTestConnectionData } from "./dev/testConnectionData.js";

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
  await ensureDefaultAdminUser();
  await bootstrapDevelopmentTestConnectionData(app.log);
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  void (async () => {
    try {
      const namingMigration = await migrateImportsToCurrentNaming();
      if (namingMigration.moved > 0 || namingMigration.relinked > 0) {
        app.log.info({ namingMigration }, "library naming migration completed");
      }
      await reconcileDownloadQueueState(app.log);
      await recoverInterruptedDownloads(app.log);
      startDownloadWorkers(app.log);
    } catch (error) {
      app.log.error({ err: error }, "background queue recovery failed during startup");
    }
  })();
  await startFuseMount(app.log);
  if (env.REQUEST_SYNC_ENABLED) startRequestSyncSchedule(app.log);
  startBackgroundRepairSchedule(app.log);
} catch (error) {
  app.log.error({ err: error }, "startup failed");
  process.exit(1);
}
