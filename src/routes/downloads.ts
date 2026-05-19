import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  addNzbUpload,
  addUrl,
  cleanupDownloadHistory,
  deleteDownload,
  enqueueDownload,
  getHistory,
  getQueue,
  makeDownloadAvailable,
  setDownloadStatus
} from "../downloads/downloadService.js";
import { testNzbUrl } from "../usenet/urlNzb.js";

const addNzbSchema = z.object({
  filename: z.string().optional(),
  title: z.string().optional(),
  content: z.string().min(1)
});

const addUrlSchema = z.object({
  url: z.string().url(),
  title: z.string().optional()
});

const cleanupHistorySchema = z.object({
  keepFailed: z.number().int().min(0).max(100).optional(),
  keepCancelled: z.number().int().min(0).max(100).optional()
}).optional();

function idParam(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/downloads/queue", async () => getQueue());
  app.get("/api/downloads/history", async () => getHistory());
  app.post("/api/downloads/history/cleanup", async (request) => cleanupDownloadHistory(cleanupHistorySchema.parse(request.body)));
  app.post("/api/downloads/add-nzb", async (request) => addNzbUpload(addNzbSchema.parse(request.body)));
  app.post("/api/downloads/add-url", async (request) => {
    const body = addUrlSchema.parse(request.body);
    return addUrl(body.url, body.title);
  });
  app.post("/api/downloads/test-nzb-url", async (request) => {
    const body = addUrlSchema.parse(request.body);
    return testNzbUrl(body.url, body.title);
  });
  app.post("/api/downloads/:id/pause", async (request) => setDownloadStatus(idParam(request), "paused"));
  app.post("/api/downloads/:id/resume", async (request) => enqueueDownload(idParam(request)));
  app.post("/api/downloads/:id/cancel", async (request) => setDownloadStatus(idParam(request), "cancelled"));
  app.post("/api/downloads/:id/retry", async (request) => enqueueDownload(idParam(request)));
  app.post("/api/downloads/:id/make-available", async (request) => makeDownloadAvailable(idParam(request)));
  app.delete("/api/downloads/:id", async (request) => deleteDownload(idParam(request)));
}
