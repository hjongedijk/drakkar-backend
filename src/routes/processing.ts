import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { getImport, importCompletedPath, listImports, reprocessImport } from "../import/importService.js";
import { getNamingSettings, previewNaming, updateNamingSettings } from "../naming/namingService.js";
import { extractDownloadPath, listRepairJobs, runCompletedHealthcheck, runRepair } from "../repair/repairService.js";
import { cleanupSymlinks, listSymlinks, repairSymlinks } from "../symlinks/symlinkService.js";

const reprocessSchema = z.object({
  sourcePath: z.string().optional()
});

const importSchema = z.object({
  sourcePath: z.string().min(1),
  downloadId: z.string().optional(),
  requestId: z.string().optional()
});

const extractSchema = z.object({
  sourcePath: z.string().min(1)
});

const namingPreviewSchema = z.object({
  media: z
    .object({
      mediaType: z.string().optional(),
      title: z.string().optional(),
      year: z.number().int().optional(),
      season: z.number().int().optional(),
      episode: z.number().int().optional()
    })
    .optional(),
  sourcePath: z.string().optional(),
  strategy: z.string().optional()
});

function idParam(request: { params: unknown }) {
  return (request.params as { id?: string; downloadId?: string }).id ?? (request.params as { downloadId: string }).downloadId;
}

export async function processingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/repair/jobs", async () => listRepairJobs());
  app.post("/api/repair/healthcheck", async () => runCompletedHealthcheck());
  app.post("/api/repair/:downloadId", async (request) => runRepair(idParam(request)));
  app.post("/api/extract", async (request) => extractDownloadPath(extractSchema.parse(request.body).sourcePath));

  app.get("/api/imports", async () => listImports());
  app.post("/api/imports", async (request) => importCompletedPath(importSchema.parse(request.body)));
  app.get("/api/imports/:id", async (request) => getImport(idParam(request)));
  app.post("/api/imports/:id/reprocess", async (request) => {
    reprocessSchema.parse(request.body ?? {});
    return reprocessImport(idParam(request));
  });

  app.get("/api/symlinks", async () => listSymlinks());
  app.post("/api/symlinks/repair", async () => repairSymlinks());
  app.post("/api/symlinks/cleanup", async () => cleanupSymlinks());

  app.get("/api/naming", async () => getNamingSettings());
  app.put("/api/naming", async (request) => updateNamingSettings(request.body));
  app.post("/api/naming/preview", async (request) => previewNaming(namingPreviewSchema.parse(request.body ?? {})));
}
