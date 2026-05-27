import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { prisma, type Download } from "../repositories/db/prisma.js";
import type { DownloadJobData } from "../workers/queues/downloadQueue.js";
import { getAllowedDownloadConnections } from "../services/bandwidth/bandwidthScheduler.js";
import { fetchAndStoreNzbForDownload } from "../services/usenet/urlNzb.js";
import { getNzbImportPlan, prepareNzbDocumentForStreaming, downloadNzbDocument } from "../services/usenet/downloadEngine.js";
import { makeMountedDownloadAvailable, reconcileRequestStatusAfterImport } from "../services/importService.js";
import { queueDownloadJob } from "../workers/queues/downloadQueue.js";
import { humanizeDownloadError } from "../services/downloads/presentation.js";
import { hydrateLegacyRequestFields } from "../services/media-library/normalizedMedia.js";

const DOWNLOAD_JOB_REQUEST_RELATION_SELECT = {
  movie: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true } },
  tvShow: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true } },
  seasonTarget: { select: { seasonNumber: true, title: true, overview: true } },
  episodeTarget: { select: { seasonNumber: true, episodeNumber: true, title: true, overview: true, airDate: true } }
} as const;

type DownloadJobMachineInput = {
  job: Job<DownloadJobData>;
  logger: FastifyBaseLogger;
  activeDownloadJobs: number;
  streamBackoffRetryMs: number;
  queueDecisionFailure: (input: {
    downloadId: string;
    requestId?: string;
    title?: string;
    rawMessage: string;
    publicMessage: string;
    source: "import-validation" | "usenet-validation";
  }) => Promise<{ action: string; decisionKey: string | null; recovered?: boolean; recoveryQueued?: boolean }>;
  finalizeMaterializedImport: (input: { downloadId: string; requestId?: string }) => Promise<unknown[]>;
  requeueForStreamingPriority: (input: {
    current: Download;
    job: Job<DownloadJobData>;
    logger: FastifyBaseLogger;
  }) => Promise<Record<string, unknown>>;
  safeUpdateDownload: (downloadId: string, data: Parameters<typeof prisma.download.update>[0]["data"]) => Promise<boolean>;
};

type MachineResult = Record<string, unknown>;

type MachineContext = {
  current: Download | null;
  nzbDocumentId: string | null;
  importPlan: { mode: "mounted" | "materialized" | "unsupported"; reason?: string } | null;
  result: MachineResult | null;
  lastError: unknown;
};

type EventWithOutput<T> = { output: T };

function getEventOutput<T>(event: unknown): T | null {
  if (!event || typeof event !== "object" || !("output" in event)) return null;
  return (event as EventWithOutput<T>).output;
}

function requiresMaterializedImport(message: string) {
  return /no streamable video file|archive file/i.test(message);
}

export async function runDownloadJobMachine(input: DownloadJobMachineInput) {
  const machine = setup({
    types: {
      context: {} as MachineContext,
      input: {} as DownloadJobMachineInput,
      events: {} as { type: "noop" }
    },
    actors: {
      loadDownload: fromPromise(async () => prisma.download.findUnique({ where: { id: input.job.data.downloadId } })),
      checkDownloadState: fromPromise(async ({ input: actorInput }: { input: { current: Download | null } }) => {
        const current = actorInput.current;
        if (!current) {
          input.logger.warn({ downloadId: input.job.data.downloadId, jobId: input.job.id }, "download job skipped because download no longer exists");
          return { terminal: { status: "missing" } };
        }
        if (current.jobId && String(current.jobId) !== String(input.job.id)) {
          input.logger.warn(
            { downloadId: input.job.data.downloadId, jobId: input.job.id, currentJobId: current.jobId },
            "download job skipped because a newer job owns the download"
          );
          return { terminal: { status: "stale" } };
        }
        if (current.status === "cancelled" || current.status === "paused") return { terminal: { status: current.status } };
        return { terminal: null };
      }),
      checkStreamingPriority: fromPromise(async ({ input: actorInput }: { input: { current: Download } }) => {
        if ((await getAllowedDownloadConnections()) > 0) return null;
        return input.requeueForStreamingPriority({ current: actorInput.current, job: input.job, logger: input.logger });
      }),
      ensureNzbDocument: fromPromise(async ({ input: actorInput }: { input: { current: Download } }) => {
        return input.job.data.nzbDocumentId ?? (await fetchAndStoreNzbForDownload({ downloadId: actorInput.current.id, logger: input.logger })).id;
      }),
      loadImportPlan: fromPromise(async ({ input: actorInput }: { input: { nzbDocumentId: string } }) => getNzbImportPlan(actorInput.nzbDocumentId)),
      processUnsupported: fromPromise(async ({ input: actorInput }: { input: { current: Download; importPlan: { reason?: string } } }) => {
        const rawMessage = actorInput.importPlan.reason === "archive_payload"
          ? "Archive/RAR NZB would require full disk materialization; refusing and searching for a direct streamable release"
          : "NZB contains no direct streamable video file";
        const recovery = await input.queueDecisionFailure({
          downloadId: input.job.data.downloadId,
          requestId: input.job.data.requestId,
          title: actorInput.current.title ?? input.job.data.title,
          rawMessage,
          publicMessage: rawMessage,
          source: "import-validation"
        });
        input.logger.warn({ downloadId: input.job.data.downloadId, recovery, importPlan: actorInput.importPlan }, "unsupported NZB import avoided materialized disk download");
        return { status: "failed", action: recovery.action, recovered: recovery.recovered ?? false, mode: "unsupported" };
      }),
      processMaterialized: fromPromise(async ({ input: actorInput }: { input: { nzbDocumentId: string } }) => {
        if ((await getAllowedDownloadConnections()) <= 0) {
          const current = await prisma.download.findUnique({ where: { id: input.job.data.downloadId } });
          if (!current) return { status: "missing" };
          return input.requeueForStreamingPriority({ current, job: input.job, logger: input.logger });
        }
        const result = await downloadNzbDocument({
          downloadId: input.job.data.downloadId,
          nzbDocumentId: actorInput.nzbDocumentId,
          logger: input.logger
        });
        if (result.status === "completed") {
          const imported = await input.finalizeMaterializedImport({
            downloadId: input.job.data.downloadId,
            requestId: input.job.data.requestId
          });
          input.logger.info({ downloadId: input.job.data.downloadId, imported: imported.length }, "archive/materialized NZB downloaded and imported");
          return { status: "available", imports: imported.length, mode: "materialized" };
        }
        return result;
      }),
      processMounted: fromPromise(async ({ input: actorInput }: { input: { nzbDocumentId: string } }) => {
        const allowedConnections = await getAllowedDownloadConnections();
        if (allowedConnections <= 0) {
          const current = await prisma.download.findUnique({ where: { id: input.job.data.downloadId } });
          if (!current) return { status: "missing" };
          return input.requeueForStreamingPriority({ current, job: input.job, logger: input.logger });
        }
        const sharedConnections = Math.max(1, Math.floor(allowedConnections / Math.max(1, input.activeDownloadJobs)));
        const result = await prepareNzbDocumentForStreaming({
          downloadId: input.job.data.downloadId,
          nzbDocumentId: actorInput.nzbDocumentId,
          logger: input.logger,
          maxConnectionsOverride: sharedConnections
        });
        if (result.status !== "prepared") return result;
        try {
          const request = input.job.data.requestId
            ? await prisma.mediaRequest.findUnique({ where: { id: input.job.data.requestId }, include: DOWNLOAD_JOB_REQUEST_RELATION_SELECT }).then((value) => value ? hydrateLegacyRequestFields(value) : null)
            : await prisma.mediaRequest.findFirst({ where: { downloadId: input.job.data.downloadId }, include: DOWNLOAD_JOB_REQUEST_RELATION_SELECT }).then((value) => value ? hydrateLegacyRequestFields(value) : null);
          const available = await makeMountedDownloadAvailable({
            downloadId: input.job.data.downloadId,
            requestId: input.job.data.requestId ?? request?.id
          });
          await reconcileRequestStatusAfterImport(request?.id, input.job.data.downloadId);
          input.logger.info({ downloadId: input.job.data.downloadId, streamPath: available.streamPath }, "streaming NZB prepared and symlinked");
          return result;
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : "import failed";
          if (requiresMaterializedImport(rawMessage)) {
            const recovery = await input.queueDecisionFailure({
              downloadId: input.job.data.downloadId,
              requestId: input.job.data.requestId,
              title: actorInput.nzbDocumentId,
              rawMessage: "Mounted NZB would require archive extraction/full materialization; refusing and searching for a direct streamable release",
              publicMessage: "Mounted NZB would require archive extraction/full materialization; refusing and searching for a direct streamable release",
              source: "import-validation"
            });
            input.logger.warn({ downloadId: input.job.data.downloadId, recovery, err: error }, "mounted import avoided materialized disk download");
            return { status: "failed", action: recovery.action, recovered: recovery.recovered ?? false };
          }
          const message = humanizeDownloadError(rawMessage) ?? rawMessage;
          input.logger.warn({ downloadId: input.job.data.downloadId, err: error }, "streaming NZB prepared but symlink import failed");
          const recovery = await input.queueDecisionFailure({
            downloadId: input.job.data.downloadId,
            requestId: input.job.data.requestId,
            title: input.job.data.title,
            rawMessage,
            publicMessage: message,
            source: "import-validation"
          });
          input.logger.warn({ downloadId: input.job.data.downloadId, recovery }, "queue decision applied after streaming import failure");
          return result;
        }
      }),
      handleWorkerError: fromPromise(async ({ input: actorInput }: { input: { error: unknown } }) => {
        const rawMessage = actorInput.error instanceof Error ? actorInput.error.message : "download worker failed";
        const message = humanizeDownloadError(rawMessage) ?? rawMessage;
        if (/too many connections/i.test(message)) {
          await input.safeUpdateDownload(input.job.data.downloadId, {
            status: "waiting_for_provider",
            error: "Usenet provider reports too many active connections; retrying automatically",
            speedBytesSec: 0
          });
          const current = await prisma.download.findUnique({ where: { id: input.job.data.downloadId } });
          const retry = await queueDownloadJob(
            current ?? {
              id: input.job.data.downloadId,
              title: input.job.data.title,
              createdAt: new Date(),
              priority: 0
            },
            "provider-backoff-retry",
            {
              downloadId: input.job.data.downloadId,
              nzbDocumentId: input.job.data.nzbDocumentId,
              title: input.job.data.title,
              requestId: input.job.data.requestId
            },
            { delay: 5 * 60 * 1000 }
          );
          await input.safeUpdateDownload(input.job.data.downloadId, { jobId: retry.id });
          input.logger.warn({ downloadId: input.job.data.downloadId, retryJobId: retry.id }, "provider connection limit reached; delayed retry queued");
          return { status: "waiting_for_provider", retryJobId: retry.id };
        }
        if (/Usenet provider configuration changed; restarting download with new connection pool/i.test(message)) {
          const current = await prisma.download.findUnique({ where: { id: input.job.data.downloadId } });
          const retry = await queueDownloadJob(
            current ?? {
              id: input.job.data.downloadId,
              title: input.job.data.title,
              createdAt: new Date(),
              priority: 0
            },
            "provider-config-refresh",
            {
              downloadId: input.job.data.downloadId,
              nzbDocumentId: input.job.data.nzbDocumentId,
              title: input.job.data.title,
              requestId: input.job.data.requestId
            }
          );
          await input.safeUpdateDownload(input.job.data.downloadId, {
            status: "queued",
            jobId: String(retry.id),
            speedBytesSec: 0,
            etaSeconds: null,
            error: "Usenet provider settings changed. Download restarting with new connection pool."
          });
          input.logger.warn({ downloadId: input.job.data.downloadId, retryJobId: retry.id }, "download requeued after provider config change");
          return { status: "queued", retryJobId: retry.id };
        }
        const recovery = await input.queueDecisionFailure({
          downloadId: input.job.data.downloadId,
          requestId: input.job.data.requestId,
          title: input.job.data.title,
          rawMessage,
          publicMessage: message,
          source: "usenet-validation"
        });
        input.logger.warn({ downloadId: input.job.data.downloadId, recovery }, "queue decision applied after worker failure");
        return { status: "failed", action: recovery.action, recovered: recovery.recovered ?? false };
      })
    },
    guards: {
      hasTerminalCheck: ({ event }) => Boolean(getEventOutput<{ terminal: MachineResult | null }>(event)?.terminal),
      needsPriorityDelay: ({ event }) => Boolean(getEventOutput<MachineResult | null>(event)),
      importUnsupported: ({ context }) => context.importPlan?.mode === "unsupported",
      importMaterialized: ({ context }) => context.importPlan?.mode === "materialized",
      importMounted: ({ context }) => context.importPlan?.mode === "mounted"
    },
    actions: {
      setCurrent: assign(({ event }) => ({ current: getEventOutput<Download | null>(event) })),
      setTerminalResult: assign(({ event }) => {
        const terminal =
          getEventOutput<{ terminal: MachineResult | null }>(event)?.terminal
          ?? getEventOutput<MachineResult>(event)
          ?? null;
        return terminal ? { result: terminal } : {};
      }),
      setNzbDocumentId: assign(({ event }) => ({ nzbDocumentId: getEventOutput<string>(event) })),
      setImportPlan: assign(({ event }) => ({ importPlan: getEventOutput<{ mode: "mounted" | "materialized" | "unsupported"; reason?: string }>(event) }))
      ,
      setLastError: assign(({ event }) => ("error" in event ? { lastError: event.error } : {}))
    }
  }).createMachine({
    id: "downloadJobLifecycle",
    context: {
      current: null,
      nzbDocumentId: null,
      importPlan: null,
      result: null,
      lastError: null
    },
    initial: "loadingDownload",
    states: {
      loadingDownload: {
        invoke: {
          src: "loadDownload",
          onDone: { target: "checkingDownloadState", actions: "setCurrent" },
          onError: { target: "handlingError", actions: "setLastError" }
        }
      },
      checkingDownloadState: {
        invoke: {
          src: "checkDownloadState",
          input: ({ context }) => ({ current: context.current }),
          onDone: [
            { guard: "hasTerminalCheck", target: "done", actions: "setTerminalResult" },
            { target: "checkingStreamingPriority" }
          ],
          onError: { target: "handlingError", actions: "setLastError" }
        }
      },
      checkingStreamingPriority: {
        invoke: {
          src: "checkStreamingPriority",
          input: ({ context }) => ({ current: context.current as Download }),
          onDone: [
            { guard: "needsPriorityDelay", target: "done", actions: "setTerminalResult" },
            { target: "ensuringNzbDocument" }
          ],
          onError: { target: "handlingError", actions: "setLastError" }
        }
      },
      ensuringNzbDocument: {
        invoke: {
          src: "ensureNzbDocument",
          input: ({ context }) => ({ current: context.current as Download }),
          onDone: { target: "loadingImportPlan", actions: "setNzbDocumentId" },
          onError: { target: "handlingError", actions: "setLastError" }
        }
      },
      loadingImportPlan: {
        invoke: {
          src: "loadImportPlan",
          input: ({ context }) => ({ nzbDocumentId: context.nzbDocumentId as string }),
          onDone: { target: "routingImportMode", actions: "setImportPlan" },
          onError: { target: "handlingError", actions: "setLastError" }
        }
      },
      routingImportMode: {
        always: [
          { guard: "importUnsupported", target: "processingUnsupported" },
          { guard: "importMaterialized", target: "processingMaterialized" },
          { guard: "importMounted", target: "processingMounted" },
          { target: "done", actions: assign({ result: () => ({ status: "missing_import_mode" }) }) }
        ]
      },
      processingUnsupported: {
        invoke: {
          src: "processUnsupported",
          input: ({ context }) => ({ current: context.current as Download, importPlan: context.importPlan as { reason?: string } }),
          onDone: { target: "done", actions: "setTerminalResult" },
          onError: { target: "handlingError", actions: "setLastError" }
        }
      },
      processingMaterialized: {
        invoke: {
          src: "processMaterialized",
          input: ({ context }) => ({ nzbDocumentId: context.nzbDocumentId as string }),
          onDone: { target: "done", actions: "setTerminalResult" },
          onError: { target: "handlingError", actions: "setLastError" }
        }
      },
      processingMounted: {
        invoke: {
          src: "processMounted",
          input: ({ context }) => ({ nzbDocumentId: context.nzbDocumentId as string }),
          onDone: { target: "done", actions: "setTerminalResult" },
          onError: { target: "handlingError", actions: "setLastError" }
        }
      },
      handlingError: {
        invoke: {
          src: "handleWorkerError",
          input: ({ context }) => ({ error: context.lastError }),
          onDone: { target: "done", actions: "setTerminalResult" }
        }
      },
      done: {
        type: "final"
      }
    }
  });

  const actor = createActor(machine, { input });
  try {
    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === "done");
    return actor.getSnapshot().context.result as MachineResult;
  } finally {
    actor.stop();
  }
}
