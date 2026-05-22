import { Worker, type Job } from "bullmq";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { redis } from "../db/redis.js";
import { prisma } from "../db/prisma.js";
import { importCompletedPath, makeMountedDownloadAvailable, reconcileRequestStatusAfterImport } from "../import/importService.js";
import type { DownloadJobData } from "../queues/downloadQueue.js";
import { downloadNzbDocument, getNzbImportMode, getNzbImportPlan, prepareNzbDocumentForStreaming } from "./downloadEngine.js";
import { fetchAndStoreNzbForDownload } from "./urlNzb.js";
import { nzbDownloadQueue, queueDownloadJob } from "../queues/downloadQueue.js";
import { recoverFailedDownloadForRequest } from "../requests/recovery/releaseRecoveryService.js";
import { humanizeDownloadError } from "../downloads/presentation.js";
import { getAllowedDownloadConnections } from "../bandwidth/bandwidthScheduler.js";
import { env } from "../config/env.js";
import { classifyQueueDecisionKey, getPolicySettings, getQueueDecisionAction } from "../policies/policyService.js";

let workers: Worker[] = [];
let activeDownloadJobs = 0;
const DOWNLOAD_WORKER_LOCK_MS = 30 * 60 * 1000;
const ACTIVE_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const ORPHANED_QUEUE_GRACE_MS = 60 * 1000;
const STREAMING_BACKOFF_RETRY_MS = 5 * 60 * 1000;

function downloadWorkerConcurrency() {
  return 1;
}

function requiresMaterializedImport(message: string) {
  return /no streamable video file|archive file/i.test(message);
}

async function handleQueueDecisionFailure(input: {
  downloadId: string;
  requestId?: string;
  title?: string;
  rawMessage: string;
  publicMessage: string;
  source: "import-validation" | "usenet-validation";
}) {
  const policies = await getPolicySettings();
  const decisionKey = classifyQueueDecisionKey(input.rawMessage);
  const action = getQueueDecisionAction(policies, decisionKey);
  const terminalStatus = action === "remove" ? "cancelled" : "failed";

  await prisma.download.update({
    where: { id: input.downloadId },
    data: {
      status: terminalStatus,
      error: input.publicMessage,
      speedBytesSec: 0,
      etaSeconds: null
    }
  });
  await prisma.failedRelease.create({
    data: {
      title: input.title ?? input.downloadId,
      reason: input.rawMessage,
      downloadId: input.downloadId
    }
  }).catch(() => undefined);

  if (action === "remove" || action === "remove_and_blocklist" || action === "do_nothing") {
    await prisma.mediaRequest.updateMany({
      where: { downloadId: input.downloadId },
      data: { status: "import_failed", downloadId: null }
    }).catch(() => undefined);
    return { action, decisionKey, recovered: false };
  }

  const recoveryInput = {
    downloadId: input.downloadId,
    requestId: input.requestId,
    title: input.title,
    error: input.rawMessage,
    source: input.source,
    blocklist: action !== "search_again"
  } as const;

  void recoverFailedDownloadForRequest(recoveryInput)
    .then(async (recovery) => {
      if (!recovery.recovered) return;
      await prisma.download.update({
        where: { id: input.downloadId },
        data: { error: `${input.publicMessage} Replacement search queued automatically.` }
      }).catch(() => undefined);
    })
    .catch(() => undefined);

  return { action, decisionKey, recovered: false, recoveryQueued: true };
}

async function finalizeMaterializedImport(input: { downloadId: string; requestId?: string }) {
  const sourcePath = join(env.VFS_DOWNLOADS_DIR, input.downloadId);
  const imported = await importCompletedPath({
    sourcePath,
    downloadId: input.downloadId,
    requestId: input.requestId
  });
  if (imported.length === 0) throw new Error("materialized download produced no importable media files");
  await prisma.download.update({
    where: { id: input.downloadId },
    data: {
      status: "available",
      progress: 100,
      speedBytesSec: 0,
      etaSeconds: 0,
      error: null,
      completedAt: new Date()
    }
  });
  await reconcileRequestStatusAfterImport(input.requestId, input.downloadId);
  await rm(sourcePath, { recursive: true, force: true }).catch(() => undefined);
  return imported;
}

async function requeueForStreamingPriority(input: {
  current: NonNullable<Awaited<ReturnType<typeof prisma.download.findUnique>>>;
  job: Job<DownloadJobData>;
  logger: FastifyBaseLogger;
}) {
  const retry = await queueDownloadJob(
    input.current,
    "streaming-priority-backoff",
    {
      downloadId: input.job.data.downloadId,
      nzbDocumentId: input.job.data.nzbDocumentId,
      title: input.job.data.title,
      requestId: input.job.data.requestId
    },
    { delay: STREAMING_BACKOFF_RETRY_MS, jobId: `streaming-priority-${input.job.data.downloadId}` }
  );
  await prisma.download.update({
    where: { id: input.job.data.downloadId },
    data: {
      status: "queued",
      jobId: String(retry.id),
      speedBytesSec: 0,
      etaSeconds: null,
      error: "Streaming is active; queue job delayed so Plex gets all Usenet capacity."
    }
  });
  input.logger.warn({ downloadId: input.job.data.downloadId, retryJobId: retry.id }, "download delayed because streaming has priority");
  return { status: "queued", reason: "streaming_priority", retryJobId: retry.id };
}

export function startDownloadWorkers(logger: FastifyBaseLogger) {
  if (workers.length > 0) return workers;

  const worker = new Worker<DownloadJobData>(
    "nzb-download",
    async (job: Job<DownloadJobData>) => {
      activeDownloadJobs += 1;
      let current = await prisma.download.findUnique({ where: { id: job.data.downloadId } });
      try {
        if (!current) {
          logger.warn({ downloadId: job.data.downloadId, jobId: job.id }, "download job skipped because download no longer exists");
          return { status: "missing" };
        }
        if (current.jobId && String(current.jobId) !== String(job.id)) {
          logger.warn(
            { downloadId: job.data.downloadId, jobId: job.id, currentJobId: current.jobId },
            "download job skipped because a newer job owns the download"
          );
          return { status: "stale" };
        }
        if (current?.status === "cancelled" || current?.status === "paused") return { status: current.status };

        if ((await getAllowedDownloadConnections()) <= 0) {
          return requeueForStreamingPriority({ current, job, logger });
        }

        const nzbDocumentId =
          job.data.nzbDocumentId ?? (await fetchAndStoreNzbForDownload({ downloadId: job.data.downloadId, logger })).id;
        const importPlan = await getNzbImportPlan(nzbDocumentId);
        const importMode = importPlan.mode;

        if (importMode === "unsupported") {
          const rawMessage = importPlan.reason === "archive_payload"
            ? "Archive/RAR NZB would require full disk materialization; refusing and searching for a direct streamable release"
            : "NZB contains no direct streamable video file";
          const recovery = await handleQueueDecisionFailure({
            downloadId: job.data.downloadId,
            requestId: job.data.requestId,
            title: current?.title ?? job.data.title,
            rawMessage,
            publicMessage: rawMessage,
            source: "import-validation"
          });
          logger.warn({ downloadId: job.data.downloadId, recovery, importPlan }, "unsupported NZB import avoided materialized disk download");
          return { status: "failed", action: recovery.action, recovered: recovery.recovered ?? false, mode: "unsupported" };
        }

        if (importMode === "materialized") {
          if ((await getAllowedDownloadConnections()) <= 0) {
            return requeueForStreamingPriority({ current, job, logger });
          }
          const result = await downloadNzbDocument({
            downloadId: job.data.downloadId,
            nzbDocumentId,
            logger
          });
          if (result.status === "completed") {
            const imported = await finalizeMaterializedImport({
              downloadId: job.data.downloadId,
              requestId: job.data.requestId
            });
            logger.info({ downloadId: job.data.downloadId, imported: imported.length }, "archive/materialized NZB downloaded and imported");
            return { status: "available", imports: imported.length, mode: "materialized" };
          }
          return result;
        }

        const allowedConnections = await getAllowedDownloadConnections();
        if (allowedConnections <= 0) {
          return requeueForStreamingPriority({ current, job, logger });
        }
        const sharedConnections = Math.max(1, Math.floor(allowedConnections / Math.max(1, activeDownloadJobs)));
        const result = await prepareNzbDocumentForStreaming({
          downloadId: job.data.downloadId,
          nzbDocumentId,
          logger,
          maxConnectionsOverride: sharedConnections
        });
        if (result.status === "prepared") {
          try {
            const request = job.data.requestId
              ? await prisma.mediaRequest.findUnique({ where: { id: job.data.requestId } })
              : await prisma.mediaRequest.findFirst({ where: { downloadId: job.data.downloadId } });
            const available = await makeMountedDownloadAvailable({
              downloadId: job.data.downloadId,
              requestId: job.data.requestId ?? request?.id
            });
            await reconcileRequestStatusAfterImport(request?.id, job.data.downloadId);
            logger.info({ downloadId: job.data.downloadId, streamPath: available.streamPath }, "streaming NZB prepared and symlinked");
          } catch (error) {
            const rawMessage = error instanceof Error ? error.message : "import failed";
            if (requiresMaterializedImport(rawMessage)) {
              const recovery = await handleQueueDecisionFailure({
                downloadId: job.data.downloadId,
                requestId: job.data.requestId,
                title: current?.title,
                rawMessage: "Mounted NZB would require archive extraction/full materialization; refusing and searching for a direct streamable release",
                publicMessage: "Mounted NZB would require archive extraction/full materialization; refusing and searching for a direct streamable release",
                source: "import-validation"
              });
              logger.warn({ downloadId: job.data.downloadId, recovery, err: error }, "mounted import avoided materialized disk download");
              return { status: "failed", action: recovery.action, recovered: recovery.recovered ?? false };
            }
            const message = humanizeDownloadError(rawMessage) ?? rawMessage;
            logger.warn({ downloadId: job.data.downloadId, err: error }, "streaming NZB prepared but symlink import failed");
            const recovery = await handleQueueDecisionFailure({
              downloadId: job.data.downloadId,
              requestId: job.data.requestId,
              title: current?.title,
              rawMessage,
              publicMessage: message,
              source: "import-validation"
            });
            logger.warn({ downloadId: job.data.downloadId, recovery }, "queue decision applied after streaming import failure");
          }
        }
        return result;
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : "download worker failed";
        const message = humanizeDownloadError(rawMessage) ?? rawMessage;
        if (/too many connections/i.test(message)) {
          await prisma.download.update({
            where: { id: job.data.downloadId },
            data: {
              status: "waiting_for_provider",
              error: "Usenet provider reports too many active connections; retrying automatically",
              speedBytesSec: 0
            }
          });
          current = current ?? await prisma.download.findUnique({ where: { id: job.data.downloadId } });
          const retry = await queueDownloadJob(
            current ?? {
              id: job.data.downloadId,
              title: job.data.title,
              createdAt: new Date(),
              priority: 0
            },
            "provider-backoff-retry",
            {
              downloadId: job.data.downloadId,
              nzbDocumentId: job.data.nzbDocumentId,
              title: job.data.title,
              requestId: job.data.requestId
            },
            { delay: 5 * 60 * 1000 }
          );
          await prisma.download.update({ where: { id: job.data.downloadId }, data: { jobId: retry.id } });
          logger.warn({ downloadId: job.data.downloadId, retryJobId: retry.id }, "provider connection limit reached; delayed retry queued");
          return { status: "waiting_for_provider", retryJobId: retry.id };
        }
        if (/Usenet provider configuration changed; restarting download with new connection pool/i.test(message)) {
          current = current ?? await prisma.download.findUnique({ where: { id: job.data.downloadId } });
          const retry = await queueDownloadJob(
            current ?? {
              id: job.data.downloadId,
              title: job.data.title,
              createdAt: new Date(),
              priority: 0
            },
            "provider-config-refresh",
            {
              downloadId: job.data.downloadId,
              nzbDocumentId: job.data.nzbDocumentId,
              title: job.data.title,
              requestId: job.data.requestId
            }
          );
          await prisma.download.update({
            where: { id: job.data.downloadId },
            data: {
              status: "queued",
              jobId: String(retry.id),
              speedBytesSec: 0,
              etaSeconds: null,
              error: "Usenet provider settings changed. Download restarting with new connection pool."
            }
          });
          logger.warn({ downloadId: job.data.downloadId, retryJobId: retry.id }, "download requeued after provider config change");
          return { status: "queued", retryJobId: retry.id };
        }
        const recovery = await handleQueueDecisionFailure({
          downloadId: job.data.downloadId,
          requestId: job.data.requestId,
          title: job.data.title,
          rawMessage,
          publicMessage: message,
          source: "usenet-validation"
        });
        logger.warn({ downloadId: job.data.downloadId, recovery }, "queue decision applied after worker failure");
        return { status: "failed", action: recovery.action, recovered: recovery.recovered ?? false };
      } finally {
        activeDownloadJobs = Math.max(0, activeDownloadJobs - 1);
      }
    },
    {
      connection: redis,
      concurrency: downloadWorkerConcurrency(),
      lockDuration: DOWNLOAD_WORKER_LOCK_MS,
      maxStalledCount: 3
    }
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, err: error }, "download worker job failed");
  });

  worker.on("stalled", async (jobId) => {
    logger.warn({ jobId }, "download worker job stalled");
    if (!jobId) return;
    const job = await nzbDownloadQueue.getJob(jobId).catch(() => null);
    const downloadId = job?.data?.downloadId;
    if (!downloadId) return;
    await prisma.download.update({
      where: { id: downloadId },
      data: {
        status: "queued",
        error: "Download worker stalled; job returned to queue automatically.",
        speedBytesSec: 0,
        etaSeconds: null
      }
    }).catch(() => undefined);
  });

  workers = [worker];
  return workers;
}

async function existingQueueJobForDownload(downloadId: string) {
  const jobs = await nzbDownloadQueue.getJobs(["active", "waiting", "delayed", "prioritized"], 0, 200, true);
  return jobs.find((job) => job.data?.downloadId === downloadId) ?? null;
}

export async function reconcileDownloadQueueState(logger: FastifyBaseLogger) {
  const queueCountsBefore = await nzbDownloadQueue.getJobCounts("active", "waiting", "delayed", "prioritized").catch(() => null);
  await nzbDownloadQueue.pause().catch(() => undefined);
  await nzbDownloadQueue.obliterate({ force: true }).catch(async (error) => {
    logger.warn({ err: error }, "download queue obliterate failed; falling back to best-effort cleanup");
    await Promise.all([
      nzbDownloadQueue.clean(0, 5000, "active").catch(() => []),
      nzbDownloadQueue.clean(0, 5000, "waiting").catch(() => []),
      nzbDownloadQueue.clean(0, 5000, "delayed").catch(() => []),
      nzbDownloadQueue.clean(0, 5000, "prioritized").catch(() => [])
    ]);
  });
  await nzbDownloadQueue.resume().catch(() => undefined);

  const activeLikeDownloads = await prisma.download.findMany({
    where: {
      status: { in: ["queued", "downloading", "fetching_nzb", "verifying", "waiting_for_provider", "waiting_for_nzb"] }
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      createdAt: true,
      priority: true,
      status: true,
      jobId: true,
      nzbDocumentId: true
    }
  });
  let requeued = 0;
  let failed = 0;

  for (const download of activeLikeDownloads) {
    if (!download.nzbDocumentId) {
      const ageMs = Date.now() - new Date(download.createdAt).getTime();
      if (ageMs < ORPHANED_QUEUE_GRACE_MS) {
        logger.warn({ downloadId: download.id, jobId: download.jobId, status: download.status }, "active-like download is still within orphan grace period");
        continue;
      }
      await prisma.download.update({
        where: { id: download.id },
        data: {
          status: "failed",
          error: "Queued download is missing both NZB payload and worker job. Re-add or retry the release.",
          speedBytesSec: 0,
          etaSeconds: null
        }
      }).catch(() => undefined);
      await prisma.mediaRequest.updateMany({
        where: { downloadId: download.id },
        data: { status: "release_failed", downloadId: null }
      }).catch(() => undefined);
      logger.error({ downloadId: download.id, jobId: download.jobId, status: download.status }, "orphaned queued download marked failed");
      failed += 1;
      continue;
    }
    const linkedRequest = await prisma.mediaRequest.findFirst({
      where: { downloadId: download.id },
      select: { id: true }
    });
    const job = await queueDownloadJob(download, "startup-recovery", {
      downloadId: download.id,
      nzbDocumentId: download.nzbDocumentId,
      title: download.title,
      requestId: linkedRequest?.id
    });
    await prisma.download.update({
      where: { id: download.id },
      data: {
        status: "queued",
        jobId: String(job.id),
        error: null,
        speedBytesSec: 0,
        etaSeconds: null
      }
    });
    requeued += 1;
  }
  logger.warn({ queueCountsBefore, requeued, failed }, "download queue rebuilt from database during startup reconciliation");
}

export async function recoverStaleActiveDownloadJobs(logger: FastifyBaseLogger) {
  const activeJobs = await nzbDownloadQueue.getJobs(["active"], 0, 500, true).catch(() => []);
  const staleJobs = activeJobs.filter((job) => {
    const processedOn = Number(job.processedOn ?? job.timestamp ?? 0);
    return processedOn > 0 && Date.now() - processedOn > ACTIVE_JOB_TIMEOUT_MS;
  });

  for (const job of staleJobs) {
    const downloadId = job.data?.downloadId;
    if (!downloadId) continue;
    await job.remove().catch(() => undefined);
    await prisma.download.update({
      where: { id: downloadId },
      data: {
        status: "queued",
        jobId: null,
        error: "Download worker active job timed out; requeued.",
        speedBytesSec: 0,
        etaSeconds: null
      }
    }).catch(() => undefined);
  }

  if (staleJobs.length > 0) {
    logger.warn({ recovered: staleJobs.length }, "stale active download jobs cleared before queue rebuild");
    await reconcileDownloadQueueState(logger);
  }
  return { recovered: staleJobs.length };
}

export async function reconcileAvailableDownloadsWithoutImports(logger: FastifyBaseLogger) {
  const candidates = await prisma.download.findMany({
    where: {
      status: { in: ["available", "completed"] },
      nzbDocumentId: { not: null },
      imports: { none: {} }
    },
    include: {
      nzbDocument: { include: { files: true } }
    }
  });

  let mountedFixed = 0;
  let materializedImported = 0;
  let requeued = 0;
  let failed = 0;

  for (const download of candidates) {
    if (!download.nzbDocumentId || !download.nzbDocument) continue;
    const linkedRequest = await prisma.mediaRequest.findFirst({
      where: { downloadId: download.id },
      select: { id: true }
    });

    try {
      const importMode = await getNzbImportMode(download.nzbDocumentId);
      if (importMode === "mounted") {
        await makeMountedDownloadAvailable({
          downloadId: download.id,
          requestId: linkedRequest?.id
        });
        await reconcileRequestStatusAfterImport(linkedRequest?.id, download.id);
        mountedFixed += 1;
        continue;
      }

      const sourcePath = join(env.VFS_DOWNLOADS_DIR, download.id);
      const sourceStats = await stat(sourcePath).catch(() => null);
      if (sourceStats) {
        await finalizeMaterializedImport({
          downloadId: download.id,
          requestId: linkedRequest?.id
        });
        materializedImported += 1;
        continue;
      }

      const existingJob = await existingQueueJobForDownload(download.id);
      const job = existingJob ?? await queueDownloadJob(
        download,
        "startup-materialized-recovery",
        {
          downloadId: download.id,
          nzbDocumentId: download.nzbDocumentId,
          title: download.title,
          requestId: linkedRequest?.id
        }
      );
      await prisma.download.update({
        where: { id: download.id },
        data: {
          status: "queued",
          jobId: String(job.id),
          error: sourceStats ? null : "Recovering stale available download without imports",
          speedBytesSec: 0,
          etaSeconds: null
        }
      });
      requeued += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ downloadId: download.id, err: error }, "available download without imports could not be reconciled");
    }
  }

  if (mountedFixed > 0 || materializedImported > 0 || requeued > 0 || failed > 0) {
    logger.warn({ mountedFixed, materializedImported, requeued, failed }, "reconciled stale available downloads without imports");
  }

  return { scanned: candidates.length, mountedFixed, materializedImported, requeued, failed };
}

export async function recoverInterruptedDownloads(logger: FastifyBaseLogger) {
  const interrupted = await prisma.download.findMany({
    where: {
      status: { in: ["fetching_nzb", "verifying", "downloading"] }
    },
    include: { nzbDocument: true }
  });

  for (const download of interrupted) {
    const existingJob = await existingQueueJobForDownload(download.id);
    if (existingJob) {
      await prisma.download.update({
        where: { id: download.id },
        data: {
          status: "queued",
          jobId: String(existingJob.id),
          error: null,
          speedBytesSec: 0,
          etaSeconds: null
        }
      });
      logger.warn({ downloadId: download.id, jobId: existingJob.id }, "interrupted download already had a queue job; duplicate recovery skipped");
      continue;
    }
    const linkedRequest = await prisma.mediaRequest.findFirst({
      where: { downloadId: download.id },
      select: { id: true }
    });
    const job = await nzbDownloadQueue.add("startup-recovery", {
      downloadId: download.id,
      nzbDocumentId: download.nzbDocumentId ?? undefined,
      title: download.title,
      requestId: linkedRequest?.id
    });
    await prisma.download.update({
      where: { id: download.id },
      data: {
        status: "queued",
        jobId: job.id,
        error: null,
        speedBytesSec: 0,
        etaSeconds: null
      }
    });
    logger.warn({ downloadId: download.id, jobId: job.id }, "interrupted download recovered and requeued");
  }

  return interrupted.length;
}

export async function stopDownloadWorkers() {
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
}
