import { Worker, type Job } from "bullmq";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { redis } from "../repositories/db/redis.js";
import { prisma, Prisma } from "../repositories/db/prisma.js";
import { importCompletedPath, makeMountedDownloadAvailable, reconcileRequestStatusAfterImport } from "../services/importService.js";
import type { DownloadJobData } from "../workers/queues/downloadQueue.js";
import { getNzbImportMode } from "../services/usenet/downloadEngine.js";
import { nzbDownloadQueue, queueDownloadJob } from "../workers/queues/downloadQueue.js";
import { recoverFailedDownloadForRequest } from "../services/requests/recovery/releaseRecoveryService.js";
import { humanizeDownloadError } from "../services/downloads/presentation.js";
import { env } from "../services/config/env.js";
import { classifyQueueDecisionKey, getPolicySettings, getQueueDecisionAction } from "../services/policyService.js";
import { getFuseMountStatus } from "../services/fuseMountService.js";
import { runDownloadJobMachine } from "../state-machines/downloadJobMachine.js";

let workers: Worker[] = [];
let activeDownloadJobs = 0;
const DOWNLOAD_WORKER_LOCK_MS = 30 * 60 * 1000;
const ACTIVE_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const ORPHANED_QUEUE_GRACE_MS = 60 * 1000;
const STREAMING_BACKOFF_RETRY_MS = 5 * 60 * 1000;
const NORMAL_DOWNLOAD_JOB_LIMIT = 2;

function downloadWorkerConcurrency() {
  return NORMAL_DOWNLOAD_JOB_LIMIT;
}

async function currentDownloadJobLimit() {
  return NORMAL_DOWNLOAD_JOB_LIMIT;
}

async function waitForAdaptiveDownloadSlot(logger: FastifyBaseLogger, downloadId: string) {
  void logger;
  void downloadId;
}

async function waitForAdaptiveImportWork(logger: FastifyBaseLogger, reason: string) {
  void logger;
  void reason;
}

function isMissingDownloadRecordError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

async function safeUpdateDownload(downloadId: string, data: Parameters<typeof prisma.download.update>[0]["data"]) {
  try {
    await prisma.download.update({
      where: { id: downloadId },
      data
    });
    return true;
  } catch (error) {
    if (isMissingDownloadRecordError(error)) return false;
    throw error;
  }
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

  await safeUpdateDownload(input.downloadId, {
    status: terminalStatus,
    error: input.publicMessage,
    speedBytesSec: 0,
    etaSeconds: null
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

  if (decisionKey === "archiveNeedsExtraction" || decisionKey === "missingArticles") {
    const recovery = await recoverFailedDownloadForRequest(recoveryInput).catch(() => null);
    if (recovery?.recovered) {
      await safeUpdateDownload(input.downloadId, {
        error: `${input.publicMessage} Replacement search queued automatically.`
      }).catch(() => undefined);
    }
    return {
      action,
      decisionKey,
      recovered: recovery?.recovered ?? false,
      recoveryQueued: Boolean(recovery?.recovered),
      deferred: Boolean(recovery && "deferred" in recovery && recovery.deferred)
    };
  }

  void recoverFailedDownloadForRequest(recoveryInput)
    .then(async (recovery) => {
      if (!recovery.recovered) return;
      await safeUpdateDownload(input.downloadId, {
        error: `${input.publicMessage} Replacement search queued automatically.`
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
  await safeUpdateDownload(input.downloadId, {
    status: "available",
    progress: 100,
    speedBytesSec: 0,
    etaSeconds: 0,
    error: null,
    completedAt: new Date()
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
  await safeUpdateDownload(input.job.data.downloadId, {
    status: "queued",
    jobId: String(retry.id),
    speedBytesSec: 0,
    etaSeconds: null,
    error: "Streaming is active; queue job delayed so Plex gets all Usenet capacity."
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
      try {
        await waitForAdaptiveDownloadSlot(logger, job.data.downloadId);
        return await runDownloadJobMachine({
          job,
          logger,
          activeDownloadJobs,
          streamBackoffRetryMs: STREAMING_BACKOFF_RETRY_MS,
          queueDecisionFailure: handleQueueDecisionFailure,
          finalizeMaterializedImport,
          requeueForStreamingPriority,
          safeUpdateDownload
        });
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
    await safeUpdateDownload(downloadId, {
      status: "queued",
      error: "Download worker stalled; job returned to queue automatically.",
      speedBytesSec: 0,
      etaSeconds: null
    }).catch(() => undefined);
  });

  workers = [worker];
  return workers;
}

async function existingQueueJobForDownload(download: { id: string; jobId?: string | null }) {
  if (download.jobId) {
    const ownedJob = await nzbDownloadQueue.getJob(String(download.jobId)).catch(() => null);
    if (ownedJob?.data?.downloadId === download.id) {
      const state = await ownedJob.getState().catch(() => "unknown");
      if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state)) return ownedJob;
    }
  }
  const jobs = await nzbDownloadQueue.getJobs(["active", "waiting", "delayed", "prioritized"], 0, 200, true);
  return jobs.find((job) => job.data?.downloadId === download.id) ?? null;
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
      await safeUpdateDownload(download.id, {
        status: "failed",
        error: "Queued download is missing both NZB payload and worker job. Re-add or retry the release.",
        speedBytesSec: 0,
        etaSeconds: null
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
    await safeUpdateDownload(download.id, {
      status: "queued",
      jobId: String(job.id),
      error: null,
      speedBytesSec: 0,
      etaSeconds: null
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
    await safeUpdateDownload(downloadId, {
      status: "queued",
      jobId: null,
      error: "Download worker active job timed out; requeued.",
      speedBytesSec: 0,
      etaSeconds: null
    }).catch(() => undefined);
  }

  if (staleJobs.length > 0) {
    logger.warn({ recovered: staleJobs.length }, "stale active download jobs cleared before queue rebuild");
    await reconcileDownloadQueueState(logger);
  }
  return { recovered: staleJobs.length };
}

export async function reconcileAvailableDownloadsWithoutImports(logger: FastifyBaseLogger) {
  const fuseStatus = getFuseMountStatus();
  const candidates = await prisma.download.findMany({
    where: {
      status: { in: ["available", "completed", "prepared"] },
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
    await waitForAdaptiveImportWork(logger, "available-download-reconcile");
    if (!download.nzbDocumentId || !download.nzbDocument) continue;
    const linkedRequest = await prisma.mediaRequest.findFirst({
      where: { downloadId: download.id },
      select: { id: true }
    });

    const supersedingImport = linkedRequest?.id
      ? await prisma.importItem.findFirst({
          where: {
            requestId: linkedRequest.id,
            downloadId: { not: download.id },
            symlinks: { some: { status: { not: "broken" } } }
          },
          select: { downloadId: true }
        })
      : null;
    if (linkedRequest?.id && supersedingImport?.downloadId) {
      await safeUpdateDownload(download.id, {
        status: "replaced",
        error: "Superseded by an existing imported release for the same request.",
        speedBytesSec: 0,
        etaSeconds: null
      });
      await prisma.mediaRequest.update({
        where: { id: linkedRequest.id },
        data: {
          status: "available",
          downloadId: supersedingImport.downloadId
        }
      }).catch(() => undefined);
      continue;
    }

    try {
      const importMode = await getNzbImportMode(download.nzbDocumentId);
      if (importMode === "mounted") {
        if (env.FUSE_MOUNT_ENABLED && !fuseStatus.mounted) {
          logger.warn({ downloadId: download.id, fusePath: fuseStatus.path, fuseError: fuseStatus.error }, "skipping mounted import reconcile because FUSE mount is unavailable");
          continue;
        }
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

      const existingJob = await existingQueueJobForDownload(download);
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
      await safeUpdateDownload(download.id, {
        status: "queued",
        jobId: String(job.id),
        error: sourceStats ? null : "Recovering stale available download without imports",
        speedBytesSec: 0,
        etaSeconds: null
      });
      requeued += 1;
    } catch (error) {
      failed += 1;
      const rawMessage = error instanceof Error ? error.message : "import reconcile failed";
      const message = humanizeDownloadError(rawMessage) ?? rawMessage;
      await handleQueueDecisionFailure({
        downloadId: download.id,
        requestId: linkedRequest?.id,
        title: download.title,
        rawMessage,
        publicMessage: message,
        source: "import-validation"
      }).catch(() => undefined);
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
      status: { in: ["queued", "fetching_nzb", "verifying", "downloading", "waiting_for_provider", "waiting_for_nzb"] }
    },
    include: { nzbDocument: true }
  });

  let recovered = 0;
  let alreadyQueued = 0;
  let withinGracePeriod = 0;
  for (const download of interrupted) {
    const limit = await currentDownloadJobLimit();
    if (activeDownloadJobs >= limit) {
      logger.info({ activeDownloadJobs, allowedDownloadJobs: limit }, "skipping interrupted download recovery because workers are throttled");
      break;
    }
    const existingJob = await existingQueueJobForDownload(download);
    if (existingJob) {
      if (String(download.jobId ?? "") !== String(existingJob.id)) {
        await safeUpdateDownload(download.id, { jobId: String(existingJob.id) });
      }
      alreadyQueued += 1;
      continue;
    }
    if (Date.now() - download.createdAt.getTime() < ORPHANED_QUEUE_GRACE_MS) {
      withinGracePeriod += 1;
      continue;
    }
    const linkedRequest = await prisma.mediaRequest.findFirst({
      where: { downloadId: download.id },
      select: { id: true }
    });
    const job = await queueDownloadJob(download, "missing-job-recovery", {
      downloadId: download.id,
      nzbDocumentId: download.nzbDocumentId ?? undefined,
      title: download.title,
      requestId: linkedRequest?.id
    });
    await safeUpdateDownload(download.id, {
      status: "queued",
      jobId: job.id,
      error: null,
      speedBytesSec: 0,
      etaSeconds: null
    });
    recovered += 1;
    logger.warn({ downloadId: download.id, jobId: job.id }, "download with missing worker job recovered and requeued");
  }

  return { scanned: interrupted.length, recovered, alreadyQueued, withinGracePeriod };
}

export async function stopDownloadWorkers() {
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
}
