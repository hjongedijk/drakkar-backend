import { prisma } from "./db/prisma.js";
import { redis } from "./db/redis.js";
import { pipelineQueues } from "./queues/downloadQueue.js";
import { buildApp } from "./app.js";
import { validateRequiredFolders } from "./utils/folders.js";
import { startRequestSyncSchedule, stopRequestSyncSchedule } from "./requests/sync/scheduler.js";
import {
  reconcileAvailableDownloadsWithoutImports,
  reconcileDownloadQueueState,
  recoverInterruptedDownloads,
  startDownloadWorkers,
  stopDownloadWorkers
} from "./usenet/workers.js";
import { startBackgroundRepairSchedule, stopBackgroundRepairSchedule } from "./repair/repairService.js";
import { bootstrapDevelopmentTestConnectionData } from "./dev/testConnectionData.js";
import { bootstrapRuntimeConfiguredServices } from "./config/runtimeConfigBootstrap.js";
import { env } from "./config/env.js";

const app = buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "worker shutting down");
  stopRequestSyncSchedule();
  stopBackgroundRepairSchedule();
  await stopDownloadWorkers();
  await Promise.all(pipelineQueues.map((queue) => queue.close()));
  await redis.quit();
  await prisma.$disconnect();
  await app.close().catch(() => undefined);
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

  if (env.STARTUP_RECOVERY_ENABLED) {
    await reconcileDownloadQueueState(app.log);
    await reconcileAvailableDownloadsWithoutImports(app.log);
    await recoverInterruptedDownloads(app.log);
  } else {
    app.log.warn("worker startup recovery disabled by config");
  }

  if (env.DOWNLOAD_WORKERS_ENABLED) startDownloadWorkers(app.log);
  else app.log.warn("worker download workers disabled by config");

  if (env.REQUEST_SYNC_ENABLED) startRequestSyncSchedule(app.log);
  else app.log.warn("worker request sync disabled by config");

  if (env.BACKGROUND_REPAIR_ENABLED) startBackgroundRepairSchedule(app.log);
  else app.log.warn("worker background repair disabled by config");

  app.log.info("background worker ready");
} catch (error) {
  app.log.error({ err: error }, "worker startup failed");
  process.exit(1);
}
