import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { episodeParamsSchema, manualRequestSchema, providerSchema, releaseGrabSchema, syncRequestsSchema } from "../models/schemas/requestSchemas.js";
import { toPublicRelease } from "../services/releases/public.js";
import {
  createManualRequest,
  createProvider,
  deleteProvider,
  getRequest,
  getRequestMonitor,
  grabBestForRequest,
  grabMissingTvForRequest,
  grabReleaseForRequest,
  grabTvEpisodeForRequest,
  listProviders,
  listRequests,
  listRequestsPage,
  markRequestAvailable,
  rankReleasesForRequest,
  rankTvEpisodeForRequest,
  refreshRequest,
  setRequestStatus,
  enqueueWebhookSync,
  syncRequestFromWebhook,
  syncRequests,
  testRequestProvider,
  updateProvider
} from "../services/requests/sync/service.js";
import { isRequestSyncRunning, runDeferredRequestRecovery, runFullRequestSyncRefresh } from "../services/requests/sync/scheduler.js";
import { publicProvider, publicRequest, publicResult } from "../services/requestPresentationService.js";

function idParam(request: FastifyRequest) {
  return (request.params as { id: string }).id;
}

export async function listRequestProvidersHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return (await listProviders()).map(publicProvider);
}

export async function createRequestProviderHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return publicProvider(await createProvider(providerSchema.parse(request.body)));
}

export async function updateRequestProviderHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return publicProvider(await updateProvider(idParam(request), providerSchema.partial().parse(request.body)));
}

export async function deleteRequestProviderHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return publicProvider(await deleteProvider(idParam(request)));
}

export async function testRequestProviderHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return testRequestProvider(idParam(request));
}

export async function listRequestsHandler(request: FastifyRequest) {
  const query = (request.query ?? {}) as { page?: string; limit?: string; summary?: string };
  const page = query.page ? Number(query.page) : undefined;
  const limit = query.limit ? Number(query.limit) : undefined;
  const summaryOnly = query.summary === "1" || query.summary === "true";
  if (page || limit || summaryOnly) {
    const result = await listRequestsPage({ page, limit, summaryOnly });
    return { ...result, items: result.items.map(publicRequest) };
  }
  return (await listRequests()).items.map(publicRequest);
}

export async function createManualRequestHandler(request: FastifyRequest) {
  return publicResult(await createManualRequest(manualRequestSchema.parse(request.body)));
}

export async function getRequestHandler(request: FastifyRequest) {
  return publicRequest(await getRequest(idParam(request)));
}

export async function getRequestMonitorHandler(request: FastifyRequest) {
  return publicResult(await getRequestMonitor(idParam(request)));
}

export async function syncRequestsHandler(request: FastifyRequest) {
  const body = syncRequestsSchema.parse(request.body ?? {});
  const result = await syncRequests(body.providerId, { full: body.full });
  void runDeferredRequestRecovery(request.log);
  return publicResult({
    ...result,
    recovery: { recovered: 0, deferred: true },
    monitored: { retried: 0, deferred: true },
    requests: result.requests.map(publicRequest)
  });
}

export async function fullSyncRefreshHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  const body = syncRequestsSchema.parse(request.body ?? {});
  if (isRequestSyncRunning()) {
    return reply.status(202).send({ accepted: true, alreadyRunning: true, message: "Request Sync is already running." });
  }
  void runFullRequestSyncRefresh(request.log, body.providerId);
  return reply.status(202).send({ accepted: true, alreadyRunning: false, message: "Full resync queued. Check Request Sync task status for progress." });
}

export async function seerrWebhookHandler(request: FastifyRequest) {
  const providerId = (request.body && typeof request.body === "object" && "providerId" in (request.body as Record<string, unknown>))
    ? String((request.body as Record<string, unknown>).providerId ?? "")
    : undefined;
  const accepted = enqueueWebhookSync(request.log, request.body, providerId);
  return publicResult({
    ok: true,
    mode: "accepted",
    deferred: true,
    requestId: accepted.requestId,
    deduped: accepted.deduped
  });
}

export async function approveRequestHandler(request: FastifyRequest) {
  return publicRequest(await setRequestStatus(idParam(request), "approved"));
}

export async function rejectRequestHandler(request: FastifyRequest) {
  return publicRequest(await setRequestStatus(idParam(request), "rejected"));
}

export async function searchRequestReleasesHandler(request: FastifyRequest) {
  const result = await rankReleasesForRequest(idParam(request));
  return {
    ...result,
    request: publicRequest(result.request),
    releases: result.releases.map((item) => ({ ...item, release: toPublicRelease(item.release) }))
  };
}

export async function searchRequestEpisodeReleasesHandler(request: FastifyRequest) {
  const params = episodeParamsSchema.parse(request.params);
  const result = await rankTvEpisodeForRequest(params.id, params.season, params.episode);
  return {
    ...result,
    request: publicRequest(result.request),
    releases: result.releases.map((item) => ({ ...item, release: toPublicRelease(item.release) }))
  };
}

export async function downloadRequestEpisodeHandler(request: FastifyRequest) {
  const params = episodeParamsSchema.parse(request.params);
  return grabTvEpisodeForRequest(params.id, params.season, params.episode);
}

async function grabBestMatchingRequest(request: FastifyRequest) {
  const mediaRequest = await getRequest(idParam(request));
  const result = mediaRequest.mediaType === "tv" ? await grabMissingTvForRequest(mediaRequest.id) : await grabBestForRequest(mediaRequest.id);
  return "release" in result && result.release ? { ...result, release: toPublicRelease(result.release as Parameters<typeof toPublicRelease>[0]) } : result;
}

export async function grabRequestHandler(request: FastifyRequest) {
  return grabBestMatchingRequest(request);
}

export async function downloadRequestHandler(request: FastifyRequest) {
  return grabBestMatchingRequest(request);
}

export async function grabRequestReleaseHandler(request: FastifyRequest) {
  const result = await grabReleaseForRequest(idParam(request), releaseGrabSchema.parse(request.body).release);
  return "release" in result && result.release ? { ...result, release: toPublicRelease(result.release as Parameters<typeof toPublicRelease>[0]) } : result;
}

export async function refreshRequestHandler(request: FastifyRequest) {
  return publicRequest(await refreshRequest(idParam(request)));
}

export async function markRequestAvailableHandler(request: FastifyRequest) {
  return publicRequest(await markRequestAvailable(idParam(request)));
}
