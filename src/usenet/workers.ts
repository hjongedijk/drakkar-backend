import { Worker, type Job } from "bullmq";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { redis } from "../db/redis.js";
import { prisma } from "../db/prisma.js";
import { importCompletedPath, makeMountedDownloadAvailable } from "../import/importService.js";
import type { DownloadJobData } from "../queues/downloadQueue.js";
import { downloadNzbDocument, prepareNzbDocumentForStreaming } from "./downloadEngine.js";
import { fetchAndStoreNzbForDownload } from "./urlNzb.js";
import { nzbDownloadQueue } from "../queues/downloadQueue.js";
import { recoverFailedDownloadForRequest } from "../requests/recovery/releaseRecoveryService.js";
import { humanizeDownloadError } from "../downloads/presentation.js";

let workers: Worker[] = [];

function requiresMaterializedImport(message: string) {
  return /no streamable video file|archive file/i.test(message);
}

export function startDownloadWorkers(logger: FastifyBaseLogger) {
  if (workers.length > 0) return workers;

  const worker = new Worker<DownloadJobData>(
    "nzb-download",
    async (job: Job<DownloadJobData>) => {
      try {
        const current = await prisma.download.findUnique({ where: { id: job.data.downloadId } });
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

        const nzbDocumentId =
          job.data.nzbDocumentId ?? (await fetchAndStoreNzbForDownload({ downloadId: job.data.downloadId, logger })).id;

        const result = await prepareNzbDocumentForStreaming({
          downloadId: job.data.downloadId,
          nzbDocumentId,
          logger
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
            if (request) {
              await prisma.mediaRequest.update({
                where: { id: request.id },
                data: { status: "available" }
              });
            }
            logger.info({ downloadId: job.data.downloadId, streamPath: available.streamPath }, "streaming NZB prepared and symlinked");
          } catch (error) {
            const rawMessage = error instanceof Error ? error.message : "import failed";
            if (requiresMaterializedImport(rawMessage)) {
              logger.warn({ downloadId: job.data.downloadId, err: error }, "mounted import needs full download fallback");
              const completed = await downloadNzbDocument({
                downloadId: job.data.downloadId,
                nzbDocumentId,
                logger
              });
              if (completed.status === "completed") {
                const imported = await importCompletedPath({
                  downloadId: job.data.downloadId,
                  requestId: job.data.requestId,
                  sourcePath: join(env.VFS_DOWNLOADS_DIR, job.data.downloadId)
                });
                await prisma.download.update({
                  where: { id: job.data.downloadId },
                  data: { status: "available", error: null, completedAt: new Date(), progress: 100, speedBytesSec: 0, etaSeconds: 0 }
                });
                await prisma.mediaRequest.updateMany({
                  where: { downloadId: job.data.downloadId },
                  data: { status: "available" }
                });
                logger.info({ downloadId: job.data.downloadId, imported: imported.length }, "full NZB download extracted and imported");
                return { status: "available", imports: imported.length, mode: "materialized_fallback" };
              }
            }
            const message = humanizeDownloadError(rawMessage) ?? rawMessage;
            logger.warn({ downloadId: job.data.downloadId, err: error }, "streaming NZB prepared but symlink import failed");
            await prisma.download.update({ where: { id: job.data.downloadId }, data: { status: "failed", error: message } });
            await prisma.mediaRequest.updateMany({ where: { downloadId: job.data.downloadId }, data: { status: "import_failed" } });
            const recovery = await recoverFailedDownloadForRequest({
              downloadId: job.data.downloadId,
              requestId: job.data.requestId,
              title: current?.title,
              error: rawMessage,
              source: "import-validation"
            });
            if (recovery.recovered) {
              await prisma.download.update({
                where: { id: job.data.downloadId },
                data: { error: `${message} Replacement search queued automatically.` }
              });
            }
            logger.warn({ downloadId: job.data.downloadId, recovery }, "failed release blocklisted and replacement search attempted");
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
          const retry = await nzbDownloadQueue.add(
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
        await prisma.download.update({
          where: { id: job.data.downloadId },
          data: {
            status: "failed",
            error: message,
            speedBytesSec: 0
          }
        });
        const recovery = await recoverFailedDownloadForRequest({
          downloadId: job.data.downloadId,
          requestId: job.data.requestId,
          title: job.data.title,
          error: rawMessage,
          source: "usenet-validation"
        });
        if (recovery.recovered) {
          await prisma.download.update({
            where: { id: job.data.downloadId },
            data: { error: `${message} Replacement search queued automatically.` }
          });
        }
        logger.warn({ downloadId: job.data.downloadId, recovery }, "failed release blocklisted and replacement search attempted");
        throw error;
      }
    },
    {
      connection: redis,
      concurrency: 1,
      lockDuration: 5 * 60 * 1000
    }
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, err: error }, "download worker job failed");
  });

  workers = [worker];
  return workers;
}

async function existingQueueJobForDownload(downloadId: string) {
  const jobs = await nzbDownloadQueue.getJobs(["active", "waiting", "delayed", "prioritized"], 0, 200, true);
  return jobs.find((job) => job.data?.downloadId === downloadId) ?? null;
}

export async function reconcileDownloadQueueState(logger: FastifyBaseLogger) {
  const jobs = await nzbDownloadQueue.getJobs(["active", "waiting", "delayed", "prioritized"], 0, 500, true);
  const byDownload = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const downloadId = job.data?.downloadId;
    if (!downloadId) continue;
    const list = byDownload.get(downloadId) ?? [];
    list.push(job);
    byDownload.set(downloadId, list);
  }

  for (const [downloadId, matches] of byDownload.entries()) {
    const ranked = await Promise.all(matches.map(async (job) => ({
      job,
      state: await job.getState(),
      score: (job.name === "parse-and-download" ? 100 : job.name === "retry-download" ? 80 : job.name === "startup-recovery" ? 10 : 50) + (job.processedOn ? 5 : 0) + (job.timestamp ?? 0) / 1e15
    })));
    ranked.sort((a, b) => b.score - a.score);
    const keep = ranked[0]?.job;
    if (!keep) continue;
    for (const duplicate of ranked.slice(1)) {
      if (duplicate.state === "waiting" || duplicate.state === "delayed") {
        await duplicate.job.remove().catch(() => undefined);
        logger.warn({ downloadId, removedJobId: duplicate.job.id, keptJobId: keep.id }, "duplicate queue job removed during reconciliation");
      }
    }
    await prisma.download.updateMany({
      where: { id: downloadId },
      data: { jobId: String(keep.id) }
    });
  }

  const activeLikeDownloads = await prisma.download.findMany({
    where: {
      status: { in: ["queued", "downloading", "fetching_nzb", "verifying", "waiting_for_provider", "waiting_for_nzb"] }
    },
    select: {
      id: true,
      title: true,
      status: true,
      jobId: true,
      nzbDocumentId: true
    }
  });
  const queuedDownloadIds = new Set(byDownload.keys());

  for (const download of activeLikeDownloads) {
    if (queuedDownloadIds.has(download.id)) continue;
    if (!download.nzbDocumentId) {
      logger.warn({ downloadId: download.id, jobId: download.jobId, status: download.status }, "active-like download has no NZB document and no queue job");
      continue;
    }
    const linkedRequest = await prisma.mediaRequest.findFirst({
      where: { downloadId: download.id },
      select: { id: true }
    });
    const job = await nzbDownloadQueue.add("startup-recovery", {
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
    logger.warn({ downloadId: download.id, previousJobId: download.jobId, jobId: job.id }, "missing queue job recreated during reconciliation");
  }
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
