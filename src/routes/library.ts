import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { toPublicRelease } from "../releases/public.js";
import {
  autoReplaceLibraryItem,
  deleteLibraryItem,
  getLibraryItem,
  libraryStats,
  listLibraryItems,
  refreshMediaLibrary,
  replaceLibraryItemWithRelease,
  searchLibraryItemReplacements
} from "../media-library/libraryService.js";
import { reprocessImport } from "../import/importService.js";

function idParam(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

const replaceReleaseSchema = z.object({
  release: z.any()
});

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/library", async () => listLibraryItems());
  app.get("/api/library/stats", async () => libraryStats());
  app.post("/api/library/refresh", async () => refreshMediaLibrary());
  app.get("/api/library/:id", async (request) => getLibraryItem(idParam(request)));
  app.get("/api/library/:id/replacements", async (request) => searchLibraryItemReplacements(idParam(request)));
  app.delete("/api/library/:id", async (request) => deleteLibraryItem(idParam(request), { blocklist: false }));
  app.post("/api/library/:id/replace-auto", async (request) => autoReplaceLibraryItem(idParam(request)));
  app.post("/api/library/:id/replace-release", async (request) => {
    const result = await replaceLibraryItemWithRelease(idParam(request), replaceReleaseSchema.parse(request.body).release);
    return "release" in result && result.release ? { ...result, release: toPublicRelease(result.release as Parameters<typeof toPublicRelease>[0]) } : result;
  });
  app.post("/api/library/:id/reimport", async (request) => {
    const item = await getLibraryItem(idParam(request));
    if (!item.sourceKey.startsWith("import:")) throw new Error("library item is not an imported item");
    return reprocessImport(item.sourceKey.replace("import:", ""));
  });
}
