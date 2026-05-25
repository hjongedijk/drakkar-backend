import { env } from "./config/env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { pruneLibraryDirectories } from "./symlinks/symlinkService.js";
import { normalizeNzbStoragePaths } from "./downloads/downloadService.js";
import { refreshPlexPath } from "./plex/plexService.js";
import {
  IMPORT_RECONCILE_TASK_ID,
  INTERRUPTED_RECOVERY_TASK_ID,
  NAMING_MIGRATION_TASK_ID,
  QUEUE_RECONCILE_TASK_ID
} from "./tasks/coreTasks.js";
import { runTrackedTask } from "./tasks/taskRegistry.js";

const app = buildApp();
const STARTUP_PLEX_REFRESH_DELAY_MS = 120_000;
const STARTUP_NAMING_MIGRATION_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const STARTUP_NAMING_MIGRATION_STAMP = join(env.CONFIG_DIR, "startup-naming-migration.json");

async function shouldRunStartupNamingMigration() {
  try {
    const raw = await readFile(STARTUP_NAMING_MIGRATION_STAMP, "utf8");
    const parsed = JSON.parse(raw) as { completedAt?: string };
    const completedAt = parsed.completedAt ? new Date(parsed.completedAt).getTime() : 0;
    if (completedAt > 0 && Date.now() - completedAt < STARTUP_NAMING_MIGRATION_COOLDOWN_MS) return false;
  } catch {
    return true;
  }
  return true;
}

async function markStartupNamingMigrationCompleted() {
  await mkdir(env.CONFIG_DIR, { recursive: true });
  await writeFile(
    STARTUP_NAMING_MIGRATION_STAMP,
    JSON.stringify({ completedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function scheduleDeferredStartupPlexRefresh(paths: Set<string>) {
  if (paths.size === 0) return;
  const uniquePaths = [...paths];
  app.log.info({ changedPaths: uniquePaths.length, delayMs: STARTUP_PLEX_REFRESH_DELAY_MS }, "startup plex refresh scheduled");
  setTimeout(() => {
    void (async () => {
      for (const path of uniquePaths) {
        try {
          const result = await refreshPlexPath(path);
          if (!result.skipped) app.log.info({ result }, "startup plex refresh triggered");
        } catch (error) {
          app.log.warn({ err: error, path }, "startup plex refresh failed");
        }
      }
    })();
  }, STARTUP_PLEX_REFRESH_DELAY_MS);
}

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
  await startFuseMount(app.log);
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  void (async () => {
    try {
      const startupPlexRefreshPaths = new Set<string>();
      const runStartupNamingMigration = await shouldRunStartupNamingMigration();
      const namingMigration = runStartupNamingMigration
        ? await runTrackedTask(
            NAMING_MIGRATION_TASK_ID,
            () => migrateImportsToCurrentNaming({ refreshPlex: false, changedPaths: startupPlexRefreshPaths })
          )
        : undefined;
      const nzbPathNormalization = await normalizeNzbStoragePaths();
      if (nzbPathNormalization.updated > 0 || nzbPathNormalization.moved > 0 || nzbPathNormalization.cleanedLegacy > 0) {
        app.log.info({ nzbPathNormalization }, "legacy nzb storage paths normalized");
      }
      if (namingMigration && (namingMigration.moved > 0 || namingMigration.relinked > 0 || namingMigration.skipped > 0)) {
        app.log.info({ namingMigration }, "library naming migration completed");
      }
      if (namingMigration?.skipped) {
        app.log.warn({ skipped: namingMigration.skipped, failures: namingMigration.failures }, "library naming migration skipped invalid imports");
      }
      if (runStartupNamingMigration) {
        await markStartupNamingMigrationCompleted().catch((error) => {
          app.log.warn({ err: error }, "failed to persist startup naming migration stamp");
        });
      } else {
        app.log.info({ cooldownHours: STARTUP_NAMING_MIGRATION_COOLDOWN_MS / 3_600_000 }, "startup naming migration skipped due to recent successful run");
      }
      await pruneLibraryDirectories().catch(() => undefined);
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
      scheduleDeferredStartupPlexRefresh(startupPlexRefreshPaths);
    } catch (error) {
      app.log.error({ err: error }, "background queue recovery failed during startup");
    }
  })();
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
