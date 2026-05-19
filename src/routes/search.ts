import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { addNzbFromPath } from "../downloads/downloadService.js";
import { getSettings } from "../settings/settingsStore.js";
import { downloadNzb, fetchNzbForRelease, testDownloadNzb, testNzbhydraConnection } from "../indexers/nzbhydra/client.js";
import { fetchDiscoverHome } from "../metadata/metadataService.js";
import { getSearchHistory, runSearch } from "../search/searchService.js";
import { toPublicReleases } from "../releases/public.js";

const baseSearchSchema = z.object({
  query: z.string().optional(),
  imdbId: z.string().optional(),
  tmdbId: z.string().optional(),
  tvdbId: z.string().optional(),
  season: z.number().int().positive().optional(),
  episode: z.number().int().positive().optional(),
  categories: z.array(z.string()).optional()
});

const downloadSchema = z.object({
  release: z.any()
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/indexers/nzbhydra/test", async () => testNzbhydraConnection(await getSettings()));
  app.get("/api/discover/home", async () => fetchDiscoverHome(await getSettings()));

  app.post("/api/search/movie", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "movie" })));
  app.post("/api/search/tv", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "tv" })));
  app.post("/api/search/season", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "season" })));
  app.post("/api/search/episode", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "episode" })));
  app.post("/api/search/manual", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "manual" })));
  app.get("/api/search/history", async () => getSearchHistory());

  app.post("/api/search/download", async (request) => {
    const body = downloadSchema.parse(request.body);
    const nzb = await downloadNzb(await getSettings(), body.release);
    return addNzbFromPath(nzb.primaryPath, body.release.title, { guid: body.release.guid ? String(body.release.guid) : undefined });
  });

  app.post("/api/search/download-nzb-test", async (request) => {
    const body = downloadSchema.parse(request.body);
    return testDownloadNzb(await getSettings(), body.release);
  });

  app.post("/api/search/download-nzb-file", async (request, reply) => {
    const body = downloadSchema.parse(request.body);
    const nzb = await fetchNzbForRelease(await getSettings(), body.release);
    return reply
      .header("content-type", nzb.contentType.includes("xml") ? nzb.contentType : "application/x-nzb")
      .header("content-disposition", `attachment; filename="${nzb.filename.replace(/"/g, "")}"`)
      .send(nzb.bytes);
  });
}
