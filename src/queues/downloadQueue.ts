import { Queue, type JobsOptions } from "bullmq";
import { redis } from "../db/redis.js";

export type DownloadJobData = {
  downloadId: string;
  nzbDocumentId?: string;
  title: string;
  requestId?: string;
};

export const nzbDownloadQueue = new Queue<DownloadJobData>("nzb-download", {
  connection: redis
});

export const usenetDownloadQueue = new Queue<DownloadJobData>("usenet-download", { connection: redis });
export const verifyQueue = new Queue<DownloadJobData>("verify", { connection: redis });
export const repairQueue = new Queue<DownloadJobData>("repair", { connection: redis });
export const extractQueue = new Queue<DownloadJobData>("extract", { connection: redis });
export const importQueue = new Queue<DownloadJobData>("import", { connection: redis });
export const symlinkQueue = new Queue<DownloadJobData>("symlink", { connection: redis });
export const cleanupQueue = new Queue<DownloadJobData>("cleanup", { connection: redis });
export const requestSyncQueue = new Queue<{ providerId?: string }>("request-sync", { connection: redis });

function queuePriority(priority: number | null | undefined) {
  const normalized = Math.max(0, Math.min(999, Number(priority ?? 0)));
  return 1000 - normalized;
}

export async function queueDownloadJob(
  input: {
    id: string;
    title: string;
    createdAt: Date;
    priority?: number | null;
  },
  name: string,
  data: DownloadJobData,
  options?: JobsOptions
) {
  const normalizedPriority = Number(input.priority ?? 0);
  return nzbDownloadQueue.add(name, data, {
    timestamp: input.createdAt.getTime(),
    ...(normalizedPriority > 0 ? { priority: queuePriority(normalizedPriority) } : {}),
    ...options
  });
}

export const pipelineQueues = [
  nzbDownloadQueue,
  usenetDownloadQueue,
  verifyQueue,
  repairQueue,
  extractQueue,
  importQueue,
  symlinkQueue,
  cleanupQueue,
  requestSyncQueue
] as const;
