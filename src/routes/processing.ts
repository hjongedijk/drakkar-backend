import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { getImport, importCompletedPath, listImports, migrateImportsToCurrentNaming, reprocessImport } from "../services/importService.js";
import { getNamingSettings, previewNaming, updateNamingSettings } from "../services/namingService.js";
import { refreshMediaLibrary } from "../services/libraryService.js";
import { extractDownloadPath, listRepairJobs, runBackgroundRepairSweep, runRepair } from "../services/repairService.js";
import { cleanupSymlinks, listSymlinks, pruneLibraryDirectories, removeStaleLibraryFilesystemEntries, repairSymlinks, revalidateLibrarySymlinks } from "../services/symlinkService.js";

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
  app.post("/api/repair/healthcheck", async (_request, reply) => {
    void runBackgroundRepairSweep(app.log);
    return reply.status(202).send({ accepted: true, message: "Background health check queued." });
  });
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
  app.post("/api/symlinks/revalidate", async (request) => {
    const body = z.object({
      limit: z.number().int().positive().max(2000).optional(),
      offset: z.number().int().min(0).optional()
    }).parse(request.body ?? {});
    return revalidateLibrarySymlinks(body);
  });
  app.post("/api/symlinks/cleanup", async () => {
    const symlinkCleanup = await cleanupSymlinks();
    const staleFilesystem = await removeStaleLibraryFilesystemEntries();
    const pruned = await pruneLibraryDirectories();
    return { symlinkCleanup, staleFilesystem, pruned };
  });

  app.get("/api/naming", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return getNamingSettings();
  });
  app.put("/api/naming", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    const naming = await updateNamingSettings(request.body);
    await migrateImportsToCurrentNaming();
    await repairSymlinks();
    await pruneLibraryDirectories();
    await refreshMediaLibrary();
    return naming;
  });
  app.post("/api/naming/preview", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return previewNaming(namingPreviewSchema.parse(request.body ?? {}));
  });
}
