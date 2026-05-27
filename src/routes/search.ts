import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { addNzbFromPath, findReusableDownload } from "../services/downloadService.js";
import { getSettings } from "../services/settings/settingsStore.js";
import { downloadNzb, fetchNzbForRelease, testDownloadNzb, testNzbhydraConnection } from "../services/indexers/nzbhydra/client.js";
import { fetchDiscoverHome, fetchDiscoverList, fetchMediaDetails, searchDiscoverMedia } from "../services/metadataService.js";
import { getSearchHistory, runSearch } from "../services/searchService.js";
import { toPublicReleases } from "../services/releases/public.js";

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
  app.get("/api/discover/search", async (request) => {
    const query = z.object({ query: z.string().min(1) }).parse(request.query);
    return searchDiscoverMedia(await getSettings(), query.query);
  });
  app.get("/api/discover/:mediaType", async (request) => {
    const params = z.object({
      mediaType: z.enum(["movie", "tv"])
    }).parse(request.params);
    const query = z.object({
      page: z.coerce.number().int().positive().optional()
    }).parse(request.query);
    return fetchDiscoverList(await getSettings(), params.mediaType, query.page ?? 1);
  });
  app.get("/api/discover/details/:mediaType", async (request, reply) => {
    const params = z.object({
      mediaType: z.enum(["movie", "tv"])
    }).parse(request.params);
    const query = z.object({
      title: z.string().optional(),
      year: z.coerce.number().int().positive().optional(),
      tmdbId: z.string().optional(),
      tvdbId: z.string().optional(),
      imdbId: z.string().optional()
    }).parse(request.query);
    const details = await fetchMediaDetails(await getSettings(), { ...query, title: query.title ?? "", mediaType: params.mediaType });
    if (!details) return reply.status(404).send({ message: "Media details not found." });
    return details;
  });

  app.post("/api/search/movie", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "movie" })));
  app.post("/api/search/tv", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "tv" })));
  app.post("/api/search/season", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "season" })));
  app.post("/api/search/episode", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "episode" })));
  app.post("/api/search/manual", async (request) => toPublicReleases(await runSearch({ ...baseSearchSchema.parse(request.body), kind: "manual" })));
  app.get("/api/search/history", async () => getSearchHistory());

  app.post("/api/search/download", async (request) => {
    const body = downloadSchema.parse(request.body);
    const reusable = await findReusableDownload({
      guid: body.release?.guid ? String(body.release.guid) : undefined,
      title: body.release?.title
    });
    if (reusable) return reusable;
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
