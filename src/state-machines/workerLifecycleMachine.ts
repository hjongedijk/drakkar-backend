import type { FastifyInstance } from "fastify";
import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
import { prisma } from "../repositories/db/prisma.js";
import { redis } from "../repositories/db/redis.js";
import { pipelineQueues } from "../workers/queues/downloadQueue.js";
import { startRequestSyncSchedule, stopRequestSyncSchedule } from "../services/requests/sync/scheduler.js";
import {
  reconcileAvailableDownloadsWithoutImports,
  reconcileDownloadQueueState,
  recoverInterruptedDownloads,
  startDownloadWorkers,
  stopDownloadWorkers
} from "../workers/usenetWorkers.js";
import { startBackgroundRepairSchedule, stopBackgroundRepairSchedule } from "../services/repairService.js";
import { bootstrapDevelopmentTestConnectionData } from "../services/dev/testConnectionData.js";
import { bootstrapRuntimeConfiguredServices } from "../services/config/runtimeConfigBootstrap.js";
import { validateRequiredFolders } from "../services/utils/folders.js";
import { env } from "../services/config/env.js";

type WorkerLifecycleContext = {
  app: FastifyInstance;
  signal: string | null;
  startupError: string | null;
};

type WorkerLifecycleEvent = {
  type: "shutdown";
  signal: string;
};

const workerLifecycleMachine = setup({
  types: {
    context: {} as WorkerLifecycleContext,
    events: {} as WorkerLifecycleEvent,
    input: {} as { app: FastifyInstance }
  },
  actors: {
    validateFolders: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => validateRequiredFolders(input.app.log)),
    bootstrapRuntimeConfig: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => bootstrapRuntimeConfiguredServices(input.app.log)),
    bootstrapDevData: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => bootstrapDevelopmentTestConnectionData(input.app.log)),
    startupRecovery: fromPromise(async ({ input }: { input: { app: FastifyInstance } }) => {
      if (env.STARTUP_RECOVERY_ENABLED) {
        await reconcileDownloadQueueState(input.app.log);
        await reconcileAvailableDownloadsWithoutImports(input.app.log);
        await recoverInterruptedDownloads(input.app.log);
      } else {
        input.app.log.warn("worker startup recovery disabled by config");
      }
    }),
    shutdownRuntime: fromPromise(async ({ input }: { input: { app: FastifyInstance; signal: string } }) => {
      input.app.log.info({ signal: input.signal }, "worker shutting down");
      stopRequestSyncSchedule();
      stopBackgroundRepairSchedule();
      await stopDownloadWorkers();
      await Promise.all(pipelineQueues.map((queue) => queue.close()));
      await redis.quit();
      await prisma.$disconnect();
      await input.app.close().catch(() => undefined);
    })
  },
  actions: {
    setStartupError: assign(({ event }) => ({
      startupError: event && typeof event === "object" && "error" in event && event.error instanceof Error
        ? event.error.message
        : "worker startup failed"
    })),
    rememberSignal: assign(({ event }) => {
      if (event.type !== "shutdown") return {};
      return { signal: event.signal };
    }),
    startRuntimeServices: ({ context }) => {
      if (env.DOWNLOAD_WORKERS_ENABLED) startDownloadWorkers(context.app.log);
      else context.app.log.warn("worker download workers disabled by config");

      if (env.REQUEST_SYNC_ENABLED) startRequestSyncSchedule(context.app.log);
      else context.app.log.warn("worker request sync disabled by config");

      if (env.BACKGROUND_REPAIR_ENABLED) startBackgroundRepairSchedule(context.app.log);
      else context.app.log.warn("worker background repair disabled by config");

      context.app.log.info("background worker ready");
    },
    logFatalAndExit: ({ context }) => {
      context.app.log.error({ error: context.startupError }, "worker startup failed");
      process.exit(1);
    },
    exitClean: () => {
      process.exit(0);
    }
  }
}).createMachine({
  id: "workerLifecycle",
  context: ({ input }) => ({
    app: input.app,
    signal: null,
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
            onError: { target: "#workerLifecycle.failed", actions: "setStartupError" }
          }
        },
        bootstrappingConfig: {
          invoke: {
            src: "bootstrapRuntimeConfig",
            input: ({ context }) => ({ app: context.app }),
            onDone: "bootstrappingDevData",
            onError: { target: "#workerLifecycle.failed", actions: "setStartupError" }
          }
        },
        bootstrappingDevData: {
          invoke: {
            src: "bootstrapDevData",
            input: ({ context }) => ({ app: context.app }),
            onDone: "startupRecovery",
            onError: { target: "#workerLifecycle.failed", actions: "setStartupError" }
          }
        },
        startupRecovery: {
          invoke: {
            src: "startupRecovery",
            input: ({ context }) => ({ app: context.app }),
            onDone: "#workerLifecycle.running",
            onError: { target: "#workerLifecycle.failed", actions: "setStartupError" }
          }
        }
      }
    },
    running: {
      entry: "startRuntimeServices"
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

export async function runWorkerLifecycle(app: FastifyInstance) {
  const actor = createActor(workerLifecycleMachine, { input: { app } });
  actor.start();
  await waitFor(actor, (snapshot) => snapshot.matches("running") || snapshot.matches("failed") || snapshot.matches("stopped"));
  return actor;
}
