import { Queue } from "bullmq";
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
