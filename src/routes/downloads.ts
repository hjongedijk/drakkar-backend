import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  addNzbUpload,
  addUrl,
  cleanupDownloadHistory,
  deleteDownload,
  enqueueDownload,
  getHistory,
  getHistoryPage,
  getQueue,
  getQueuePage,
  invalidateDownloadViewCache,
  makeDownloadAvailable,
  setDownloadStatus
} from "../services/downloadService.js";
import { testNzbUrl } from "../services/usenet/urlNzb.js";

const addNzbSchema = z.object({
  filename: z.string().optional(),
  title: z.string().optional(),
  content: z.string().min(1),
  category: z.string().optional()
});

const addUrlSchema = z.object({
  url: z.string().url(),
  title: z.string().optional()
});

const cleanupHistorySchema = z.object({
  keepFailed: z.number().int().min(0).max(100).optional(),
  keepCancelled: z.number().int().min(0).max(100).optional()
}).optional();

const pageSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25)
});

function idParam(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/downloads/queue", async () => getQueue());
  app.get("/api/downloads/queue/page", async (request) => getQueuePage(pageSchema.parse(request.query)));
  app.get("/api/downloads/history", async () => getHistory());
  app.get("/api/downloads/history/page", async (request) => getHistoryPage(pageSchema.parse(request.query)));
  app.post("/api/downloads/history/cleanup", async (request) => {
    invalidateDownloadViewCache();
    return cleanupDownloadHistory(cleanupHistorySchema.parse(request.body));
  });
  app.post("/api/downloads/add-nzb", async (request) => {
    invalidateDownloadViewCache();
    return addNzbUpload(addNzbSchema.parse(request.body));
  });
  app.post("/api/downloads/add-url", async (request) => {
    invalidateDownloadViewCache();
    const body = addUrlSchema.parse(request.body);
    return addUrl(body.url, body.title);
  });
  app.post("/api/downloads/test-nzb-url", async (request) => {
    const body = addUrlSchema.parse(request.body);
    return testNzbUrl(body.url, body.title);
  });
  app.post("/api/downloads/:id/pause", async (request) => {
    invalidateDownloadViewCache();
    return setDownloadStatus(idParam(request), "paused");
  });
  app.post("/api/downloads/:id/resume", async (request) => {
    invalidateDownloadViewCache();
    return enqueueDownload(idParam(request));
  });
  app.post("/api/downloads/:id/cancel", async (request) => {
    invalidateDownloadViewCache();
    return setDownloadStatus(idParam(request), "cancelled");
  });
  app.post("/api/downloads/:id/retry", async (request) => {
    invalidateDownloadViewCache();
    return enqueueDownload(idParam(request));
  });
  app.post("/api/downloads/:id/make-available", async (request) => {
    invalidateDownloadViewCache();
    return makeDownloadAvailable(idParam(request));
  });
  app.delete("/api/downloads/:id", async (request) => {
    invalidateDownloadViewCache();
    return deleteDownload(idParam(request));
  });
}
