import type { FastifyInstance } from "fastify";
import {
  cleanupExpiredBlocklistHandler,
  clearBlocklistHandler,
  createBlocklistHandler,
  deleteBlocklistHandler,
  getBlocklistStatsHandler,
  getIgnoredFilesHandler,
  getPolicySettingsHandler,
  getPolicyUsageHandler,
  listBlocklistHandler,
  matchBlocklistHandler,
  testIgnoredFileHandler,
  updateBlocklistHandler,
  updateIgnoredFilesHandler,
  updatePolicySettingsHandler
} from "../controllers/policyController.js";

export async function policyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/policies", getPolicySettingsHandler);
  app.get("/api/settings/policies/usage", getPolicyUsageHandler);
  app.put("/api/settings/policies", updatePolicySettingsHandler);
  app.get("/api/ignored-files", getIgnoredFilesHandler);
  app.put("/api/ignored-files", updateIgnoredFilesHandler);
  app.post("/api/ignored-files/test", testIgnoredFileHandler);
  app.get("/api/blocklist", listBlocklistHandler);
  app.get("/api/blacklist", listBlocklistHandler);
  app.get("/api/blocklist/stats", getBlocklistStatsHandler);
  app.get("/api/blacklist/stats", getBlocklistStatsHandler);
  app.post("/api/blocklist", createBlocklistHandler);
  app.post("/api/blacklist", createBlocklistHandler);
  app.post("/api/blocklist/match", matchBlocklistHandler);
  app.post("/api/blacklist/match", matchBlocklistHandler);
  app.put("/api/blocklist/:id", updateBlocklistHandler);
  app.put("/api/blacklist/:id", updateBlocklistHandler);
  app.delete("/api/blocklist/:id", deleteBlocklistHandler);
  app.delete("/api/blacklist/:id", deleteBlocklistHandler);
  app.post("/api/blocklist/cleanup-expired", cleanupExpiredBlocklistHandler);
  app.post("/api/blacklist/cleanup-expired", cleanupExpiredBlocklistHandler);
  app.delete("/api/blocklist", clearBlocklistHandler);
  app.delete("/api/blacklist", clearBlocklistHandler);
}
