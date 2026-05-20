import type { FastifyBaseLogger } from "fastify";
import { cleanupDownloadHistory } from "../../downloads/downloadService.js";
import { ensureMonitoredRequests, recoverFailedRequestDownloads, syncRequests } from "./service.js";

let timer: NodeJS.Timeout | undefined;
let running = false;

async function runCycle(logger: FastifyBaseLogger) {
  if (running) return;
  running = true;
  try {
    await syncRequests();
    await recoverFailedRequestDownloads();
    await ensureMonitoredRequests();
    await cleanupDownloadHistory({ keepFailed: 10, keepCancelled: 10 });
  } catch (error) {
    logger.warn({ err: error }, "request sync/recovery failed");
  } finally {
    running = false;
  }
}

export function startRequestSyncSchedule(logger: FastifyBaseLogger) {
  if (timer) return;
  void runCycle(logger);
  timer = setInterval(() => {
    void runCycle(logger);
  }, 60_000);
}

export function stopRequestSyncSchedule() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
