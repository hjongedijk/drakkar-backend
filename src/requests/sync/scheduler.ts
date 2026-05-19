import type { FastifyBaseLogger } from "fastify";
import { cleanupDownloadHistory } from "../../downloads/downloadService.js";
import { ensureMonitoredRequests, recoverFailedRequestDownloads, syncRequests } from "./service.js";

let timer: NodeJS.Timeout | undefined;

export function startRequestSyncSchedule(logger: FastifyBaseLogger) {
  if (timer) return;
  timer = setInterval(() => {
    syncRequests()
      .then(() => recoverFailedRequestDownloads())
      .then(() => ensureMonitoredRequests())
      .then(() => cleanupDownloadHistory({ keepFailed: 10, keepCancelled: 10 }))
      .catch((error) => logger.warn({ err: error }, "request sync/recovery failed"));
  }, 60_000);
}

export function stopRequestSyncSchedule() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
