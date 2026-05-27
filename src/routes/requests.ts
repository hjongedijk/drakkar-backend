import type { FastifyInstance } from "fastify";
import {
  approveRequestHandler,
  createManualRequestHandler,
  createRequestProviderHandler,
  deleteRequestProviderHandler,
  downloadRequestEpisodeHandler,
  downloadRequestHandler,
  fullSyncRefreshHandler,
  getRequestHandler,
  getRequestMonitorHandler,
  grabRequestHandler,
  grabRequestReleaseHandler,
  listRequestProvidersHandler,
  listRequestsHandler,
  markRequestAvailableHandler,
  refreshRequestHandler,
  rejectRequestHandler,
  searchRequestEpisodeReleasesHandler,
  searchRequestReleasesHandler,
  seerrWebhookHandler,
  syncRequestsHandler,
  testRequestProviderHandler,
  updateRequestProviderHandler
} from "../controllers/requestController.js";

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/request-providers", listRequestProvidersHandler);
  app.post("/api/request-providers", createRequestProviderHandler);
  app.put("/api/request-providers/:id", updateRequestProviderHandler);
  app.delete("/api/request-providers/:id", deleteRequestProviderHandler);
  app.post("/api/request-providers/:id/test", testRequestProviderHandler);
  app.get("/api/requests", listRequestsHandler);
  app.post("/api/requests", createManualRequestHandler);
  app.get("/api/requests/:id", getRequestHandler);
  app.get("/api/requests/:id/monitor", getRequestMonitorHandler);
  app.post("/api/requests/sync", syncRequestsHandler);
  app.post("/api/requests/full-sync-refresh", fullSyncRefreshHandler);
  app.post("/api/webhooks/seerr", seerrWebhookHandler);
  app.post("/api/requests/:id/approve", approveRequestHandler);
  app.post("/api/requests/:id/reject", rejectRequestHandler);
  app.post("/api/requests/:id/search", searchRequestReleasesHandler);
  app.post("/api/requests/:id/episodes/:season/:episode/search", searchRequestEpisodeReleasesHandler);
  app.post("/api/requests/:id/episodes/:season/:episode/download", downloadRequestEpisodeHandler);
  app.post("/api/requests/:id/grab", grabRequestHandler);
  app.post("/api/requests/:id/download", downloadRequestHandler);
  app.post("/api/requests/:id/grab-release", grabRequestReleaseHandler);
  app.post("/api/requests/:id/refresh", refreshRequestHandler);
  app.post("/api/requests/:id/available", markRequestAvailableHandler);
}
