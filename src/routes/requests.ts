import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { toPublicRelease } from "../releases/public.js";
import {
  createProvider,
  createManualRequest,
  deleteProvider,
  getRequest,
  getRequestMonitor,
  grabBestForRequest,
  grabMissingTvForRequest,
  grabTvEpisodeForRequest,
  grabReleaseForRequest,
  listProviders,
  listRequests,
  markRequestAvailable,
  rankReleasesForRequest,
  rankTvEpisodeForRequest,
  recoverFailedRequestDownloads,
  ensureMonitoredRequests,
  refreshRequest,
  setRequestStatus,
  syncRequests,
  syncRequestFromWebhook,
  testRequestProvider,
  updateProvider
} from "../requests/sync/service.js";

const providerSchema = z.object({
  type: z.literal("seerr").default("seerr"),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  enabled: z.boolean().default(true),
  syncIntervalMinutes: z.number().int().positive().default(15),
  defaultMovieProfile: z.string().optional(),
  defaultTvProfile: z.string().optional()
});

const releaseGrabSchema = z.object({
  release: z.any()
});

const manualRequestSchema = z.object({
  mediaType: z.enum(["movie", "tv"]),
  title: z.string().min(1),
  year: z.number().int().positive().optional(),
  tmdbId: z.string().optional(),
  tvdbId: z.string().optional(),
  imdbId: z.string().optional()
});

const episodeParamsSchema = z.object({
  id: z.string(),
  season: z.coerce.number().int().positive(),
  episode: z.coerce.number().int().positive()
});

function idParam(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

function publicProvider(provider: Record<string, unknown> | null | undefined) {
  if (!provider) return provider;
  const { apiKey, ...safeProvider } = provider;
  void apiKey;
  return safeProvider;
}

function publicRequest<T>(request: T): T {
  if (!request || typeof request !== "object") return request;
  const typed = request as { provider?: Record<string, unknown>; selectedRelease?: unknown };
  return {
    ...request,
    provider: publicProvider(typed.provider),
    selectedRelease:
      typed.selectedRelease && typeof typed.selectedRelease === "object"
        ? toPublicRelease(typed.selectedRelease as Parameters<typeof toPublicRelease>[0])
        : typed.selectedRelease
  };
}

function publicResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicResult) as T;
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = key === "release" && item && typeof item === "object" ? toPublicRelease(item as Parameters<typeof toPublicRelease>[0]) : publicResult(item);
  }
  return output as T;
}

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/request-providers", async () => (await listProviders()).map(publicProvider));
  app.post("/api/request-providers", async (request) => publicProvider(await createProvider(providerSchema.parse(request.body))));
  app.put("/api/request-providers/:id", async (request) => publicProvider(await updateProvider(idParam(request), providerSchema.partial().parse(request.body))));
  app.delete("/api/request-providers/:id", async (request) => publicProvider(await deleteProvider(idParam(request))));
  app.post("/api/request-providers/:id/test", async (request) => testRequestProvider(idParam(request)));

  app.get("/api/requests", async () => (await listRequests()).map(publicRequest));
  app.post("/api/requests", async (request) => publicResult(await createManualRequest(manualRequestSchema.parse(request.body))));
  app.get("/api/requests/:id", async (request) => publicRequest(await getRequest(idParam(request))));
  app.get("/api/requests/:id/monitor", async (request) => publicResult(await getRequestMonitor(idParam(request))));
  app.post("/api/requests/sync", async (request) => {
    const result = await syncRequests((request.body as { providerId?: string } | undefined)?.providerId);
    void (async () => {
      try {
        await recoverFailedRequestDownloads();
        await ensureMonitoredRequests();
      } catch (error) {
        request.log.warn({ err: error }, "post-sync recovery/monitor refresh failed");
      }
    })();
    return publicResult({
      ...result,
      recovery: { recovered: 0, deferred: true },
      monitored: { retried: 0, deferred: true },
      requests: result.requests.map(publicRequest)
    });
  });
  app.post("/api/webhooks/seerr", async (request) => {
    const providerId = (request.body && typeof request.body === "object" && "providerId" in (request.body as Record<string, unknown>))
      ? String((request.body as Record<string, unknown>).providerId ?? "")
      : undefined;
    const result = await syncRequestFromWebhook(request.body, providerId);
    request.log.info({
      mode: "mode" in result ? result.mode : "noop",
      requestId: "requestId" in result ? result.requestId : undefined,
      ok: result.ok
    }, "seerr webhook processed");
    return publicResult(result);
  });
  app.post("/api/requests/:id/approve", async (request) => publicRequest(await setRequestStatus(idParam(request), "approved")));
  app.post("/api/requests/:id/reject", async (request) => publicRequest(await setRequestStatus(idParam(request), "rejected")));
  app.post("/api/requests/:id/search", async (request) => {
    const result = await rankReleasesForRequest(idParam(request));
    return {
      ...result,
      request: publicRequest(result.request),
      releases: result.releases.map((item) => ({ ...item, release: toPublicRelease(item.release) }))
    };
  });
  app.post("/api/requests/:id/episodes/:season/:episode/search", async (request) => {
    const params = episodeParamsSchema.parse(request.params);
    const result = await rankTvEpisodeForRequest(params.id, params.season, params.episode);
    return {
      ...result,
      request: publicRequest(result.request),
      releases: result.releases.map((item) => ({ ...item, release: toPublicRelease(item.release) }))
    };
  });
  app.post("/api/requests/:id/episodes/:season/:episode/download", async (request) => {
    const params = episodeParamsSchema.parse(request.params);
    const result = await grabTvEpisodeForRequest(params.id, params.season, params.episode);
    return result;
  });
  app.post("/api/requests/:id/grab", async (request) => {
    const mediaRequest = await getRequest(idParam(request));
    const result = mediaRequest.mediaType === "tv" ? await grabMissingTvForRequest(mediaRequest.id) : await grabBestForRequest(mediaRequest.id);
    return "release" in result && result.release ? { ...result, release: toPublicRelease(result.release) } : result;
  });
  app.post("/api/requests/:id/download", async (request) => {
    const mediaRequest = await getRequest(idParam(request));
    const result = mediaRequest.mediaType === "tv" ? await grabMissingTvForRequest(mediaRequest.id) : await grabBestForRequest(mediaRequest.id);
    return "release" in result && result.release ? { ...result, release: toPublicRelease(result.release) } : result;
  });
  app.post("/api/requests/:id/grab-release", async (request) => {
    const result = await grabReleaseForRequest(idParam(request), releaseGrabSchema.parse(request.body).release);
    return "release" in result && result.release ? { ...result, release: toPublicRelease(result.release) } : result;
  });
  app.post("/api/requests/:id/refresh", async (request) => publicRequest(await refreshRequest(idParam(request))));
  app.post("/api/requests/:id/available", async (request) => publicRequest(await markRequestAvailable(idParam(request))));
}
