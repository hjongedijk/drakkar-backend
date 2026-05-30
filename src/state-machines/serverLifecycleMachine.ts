import type { FastifyInstance } from "fastify";
import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
import { env } from "../services/config/env.js";
import { prisma } from "../repositories/db/prisma.js";
import { redis } from "../repositories/db/redis.js";
import { pipelineQueues } from "../workers/queues/downloadQueue.js";
import { migrateImportsToCurrentNaming } from "../services/importService.js";
import { validateRequiredFolders } from "../services/utils/folders.js";
import { runImportReconcileCycle, startRequestSyncSchedule, stopRequestSyncSchedule } from "../services/requests/sync/scheduler.js";
import {
  reconcileDownloadQueueState,
  recoverStaleActiveDownloadJobs,
  recoverInterruptedDownloads,
  startDownloadWorkers,
  stopDownloadWorkers
} from "../workers/usenetWorkers.js";
import { primeMountedStreamPool, reconcileStreamCacheDirectory } from "../services/mountedStream.service.js";
import { startFuseMount, stopFuseMount } from "../services/fuseMountService.js";
import { startBackgroundRepairSchedule, stopBackgroundRepairSchedule } from "../services/repairService.js";
import { bootstrapDevelopmentTestConnectionData } from "../services/dev/testConnectionData.js";
import { bootstrapRuntimeConfiguredServices } from "../services/config/runtimeConfigBootstrap.js";
import { pruneLibraryDirectories } from "../services/symlinkService.js";
import { normalizeNzbStoragePaths } from "../services/downloadService.js";
import { refreshPlexPath } from "../services/plexService.js";
import { fetchReleaseCalendar } from "../services/releaseCalendarService.js";
import {
  IMPORT_RECONCILE_TASK_ID,
  INTERRUPTED_RECOVERY_TASK_ID,
  NAMING_MIGRATION_TASK_ID,
  QUEUE_RECONCILE_TASK_ID
} from "../workers/tasks/coreTasks.js";
import { runTrackedTask } from "../workers/tasks/taskRegistry.js";

const STARTUP_NAMING_MIGRATION_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const STARTUP_NAMING_MIGRATION_STAMP = `${env.CONFIG_DIR}/startup-naming-migration.json`;

type LifecycleContext = {
  app: FastifyInstance;
  signal: string | null;
  startupPlexRefreshPaths: string[];
  startupError: string | null;
};

type LifecycleEvent = {
  type: "shutdown";
  signal: string;
};

async function shouldRunStartupNamingMigration() {
  try {
    const { readFile } = await import("node:fs/promises");
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
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(env.CONFIG_DIR, { recursive: true });
  await writeFile(
    STARTUP_NAMING_MIGRATION_STAMP,
    JSON.stringify({ completedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function refreshStartupPlexPaths(app: FastifyInstance, paths: string[]) {
  if (paths.length === 0) return;
  void (async () => {
    for (const path of paths) {
      try {
        const result = await refreshPlexPath(path);
        if (!result.skipped) app.log.info({ result }, "startup plex refresh triggered");
      } catch (error) {
        app.log.warn({ err: error, path }, "startup plex refresh failed");
      }
    }
  })();
}

function monthKeyFromOffset(offset: number) {
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}`;
}

function prewarmCalendar(app: FastifyInstance) {
  const months = [monthKeyFromOffset(0), monthKeyFromOffset(1)];
  void (async () => {
    for (const month of months) {
      try {
        const startedAt = Date.now();
        await fetchReleaseCalendar(month, { compact: false });
        app.log.info({ month, durationMs: Date.now() - startedAt }, "calendar prewarm completed");
      } catch (error) {
        app.log.warn({ err: error, month }, "calendar prewarm failed");
      }
    }
  })();
}

async function runStartupRecovery(app: FastifyInstance) {
  const startupPlexRefreshPaths = new Set<string>();
  const streamCacheState = await reconcileStreamCacheDirectory();
  app.log.info({ streamCacheState }, "stream cache directory reconciled");
  const runStartupNamingMigrationByCooldown = await shouldRunStartupNamingMigration();
  const runStartupNamingMigration = false;
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
    app.log.info({
      cooldownHours: STARTUP_NAMING_MIGRATION_COOLDOWN_MS / 3_600_000,
      shouldRun: runStartupNamingMigrationByCooldown
    }, "startup naming migration skipped");
  }
  await pruneLibraryDirectories().catch(() => undefined);
  if (env.STARTUP_RECOVERY_ENABLED) {
    await recoverStaleActiveDownloadJobs(app.log);
    await runTrackedTask(QUEUE_RECONCILE_TASK_ID, () => reconcileDownloadQueueState(app.log));
    if (env.DOWNLOAD_WORKERS_ENABLED) startDownloadWorkers(app.log);
    else app.log.warn("download workers disabled by config");
    const importReconcile = await runImportReconcileCycle(app.log);
    if (importReconcile?.started === false && importReconcile.reason === "playback_active") {
      app.log.info(importReconcile, "startup import reconcile deferred because playback is active");
    } else if (importReconcile?.started === false && importReconcile.reason === "conflicting_task_running") {
      app.log.info(importReconcile, "startup import reconcile skipped because conflicting task is active");
    }
    await runTrackedTask(INTERRUPTED_RECOVERY_TASK_ID, () => recoverInterruptedDownloads(app.log));
  } else {
    app.log.warn("startup recovery disabled by config");
    if (env.DOWNLOAD_WORKERS_ENABLED) startDownloadWorkers(app.log);
    else app.log.warn("download workers disabled by config");
  }
  return {
    startupPlexRefreshPaths: [...startupPlexRefreshPaths]
  };
}

async function shutdownRuntime(app: FastifyInstance, signal: string) {
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

const serverLifecycleMachine = setup({
  types: {
    context: {} as LifecycleContext,
    events: {} as LifecycleEvent,
    input: {} as { app: FastifyInstance }
  },
  actors: {
    validateFolders: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => validateRequiredFolders(input.app.log)),
    bootstrapRuntimeConfig: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => bootstrapRuntimeConfiguredServices(input.app.log)),
    bootstrapDevData: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => bootstrapDevelopmentTestConnectionData(input.app.log)),
    mountFuse: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => {
      if (!env.FUSE_MOUNT_ENABLED) return { enabled: false, mounted: false, path: env.FUSE_MOUNT_PATH };
      return startFuseMount(input.app.log);
    }),
    listen: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => input.app.listen({ port: env.PORT, host: "0.0.0.0" })),
    startupRecovery: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => runStartupRecovery(input.app)),
    shutdownRuntime: fromPromise(async ({ input }: { input: { app: FastifyInstance; signal: string } }) => shutdownRuntime(input.app, input.signal))
  },
  actions: {
    cacheStartupResult: assign(({ event }) => {
      if (!event || typeof event !== "object" || !("output" in event)) return {};
      const output = event.output as { startupPlexRefreshPaths?: string[] };
      return {
        startupPlexRefreshPaths: output.startupPlexRefreshPaths ?? [],
        startupError: null
      };
    }),
    setStartupError: assign(({ event }) => ({
      startupError: event && typeof event === "object" && "error" in event && event.error instanceof Error
        ? event.error.message
        : "runtime startup failed"
    })),
    rememberSignal: assign(({ event }) => {
      if (event.type !== "shutdown") return {};
      return { signal: event.signal };
    }),
    startRuntimeServices: ({ context }) => {
      refreshStartupPlexPaths(context.app, context.startupPlexRefreshPaths);
      if (env.CALENDAR_PREWARM_ENABLED) prewarmCalendar(context.app);
      else context.app.log.warn("calendar prewarm disabled by config");
      if (env.STREAM_POOL_PRIME_ENABLED) {
        void primeMountedStreamPool().catch((error) => {
          context.app.log.debug({ err: error }, "mounted stream pool prewarm skipped");
        });
      } else {
        context.app.log.warn("mounted stream pool prewarm disabled by config");
      }
      if (env.REQUEST_SYNC_ENABLED) startRequestSyncSchedule(context.app.log);
      if (env.BACKGROUND_REPAIR_ENABLED) startBackgroundRepairSchedule(context.app.log);
    },
    logFatalAndExit: ({ context }) => {
      context.app.log.error({ error: context.startupError }, "startup failed");
      process.exit(1);
    },
    exitClean: () => {
      process.exit(0);
    }
  }
}).createMachine({
  id: "serverLifecycle",
  context: ({ input }) => ({
    app: input.app,
    signal: null,
    startupPlexRefreshPaths: [],
    startupError: null
  }),
  initial: "bootstrapping",
  on: {
    shutdown: {
      target: ".shuttingDown",
      actions: "rememberSignal"
    }
  },
  states: {
    bootstrapping: {
      initial: "validatingFolders",
      states: {
        validatingFolders: {
          invoke: {
            src: "validateFolders",
            input: ({ context }) => ({ app: context.app }),
            onDone: "bootstrappingConfig",
            onError: { target: "#serverLifecycle.failed", actions: "setStartupError" }
          }
        },
        bootstrappingConfig: {
          invoke: {
            src: "bootstrapRuntimeConfig",
            input: ({ context }) => ({ app: context.app }),
            onDone: "bootstrappingDevData",
            onError: { target: "#serverLifecycle.failed", actions: "setStartupError" }
          }
        },
        bootstrappingDevData: {
          invoke: {
            src: "bootstrapDevData",
            input: ({ context }) => ({ app: context.app }),
            onDone: "mountingFuse",
            onError: { target: "#serverLifecycle.failed", actions: "setStartupError" }
          }
        },
        mountingFuse: {
          invoke: {
            src: "mountFuse",
            input: ({ context }) => ({ app: context.app }),
            onDone: "listening",
            onError: { target: "#serverLifecycle.failed", actions: "setStartupError" }
          }
        },
        listening: {
          invoke: {
            src: "listen",
            input: ({ context }) => ({ app: context.app }),
            onDone: "startupRecovery",
            onError: { target: "#serverLifecycle.failed", actions: "setStartupError" }
          }
        },
        startupRecovery: {
          invoke: {
            src: "startupRecovery",
            input: ({ context }) => ({ app: context.app }),
            onDone: { target: "#serverLifecycle.running", actions: "cacheStartupResult" },
            onError: { target: "#serverLifecycle.failed", actions: "setStartupError" }
          }
        }
      }
    },
    running: {
      entry: "startRuntimeServices",
    },
    shuttingDown: {
      invoke: {
        src: "shutdownRuntime",
        input: ({ context }) => ({ app: context.app, signal: context.signal ?? "unknown" }),
        onDone: "stopped",
        onError: "stopped"
      }
    },
    failed: {
      entry: "logFatalAndExit"
    },
    stopped: {
      type: "final",
      entry: "exitClean"
    }
  }
});

export async function runServerLifecycle(app: FastifyInstance) {
  const actor = createActor(serverLifecycleMachine, { input: { app } });
  actor.start();
  await waitFor(actor, (snapshot) => snapshot.matches("running") || snapshot.matches("failed") || snapshot.matches("stopped"));
  return actor;
}
