import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createBlocklistItem,
  clearBlocklistItems,
  deleteBlocklistItem,
  deleteExpiredBlocklistItems,
  getBlocklistStats,
  getIgnoredPatterns,
  getPolicyUsageReport,
  getPolicySettings,
  listBlocklist,
  matchBlocklistRelease,
  testIgnoredPath,
  updateBlocklistItem,
  updateIgnoredPatterns,
  updatePolicySettings,
  blocklistQuerySchema
} from "../policies/policyService.js";

const ignoredTestSchema = z.object({
  path: z.string().min(1)
});

const blocklistMatchSchema = z.object({
  guid: z.string().optional(),
  title: z.string().min(1)
});

function idParam(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

export async function policyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/policies", async () => getPolicySettings());
  app.get("/api/settings/policies/usage", async () => getPolicyUsageReport());
  app.put("/api/settings/policies", async (request) => updatePolicySettings(request.body));

  app.get("/api/ignored-files", async () => getIgnoredPatterns());
  app.put("/api/ignored-files", async (request) => updateIgnoredPatterns(request.body));
  app.post("/api/ignored-files/test", async (request) => testIgnoredPath(ignoredTestSchema.parse(request.body).path));

  app.get("/api/blocklist", async (request) => listBlocklist(blocklistQuerySchema.parse(request.query)));
  app.get("/api/blacklist", async (request) => listBlocklist(blocklistQuerySchema.parse(request.query)));
  app.get("/api/blocklist/stats", async () => getBlocklistStats());
  app.get("/api/blacklist/stats", async () => getBlocklistStats());
  app.post("/api/blocklist", async (request) => createBlocklistItem(request.body));
  app.post("/api/blacklist", async (request) => createBlocklistItem(request.body));
  app.post("/api/blocklist/match", async (request) => matchBlocklistRelease(blocklistMatchSchema.parse(request.body)));
  app.post("/api/blacklist/match", async (request) => matchBlocklistRelease(blocklistMatchSchema.parse(request.body)));
  app.put("/api/blocklist/:id", async (request) => updateBlocklistItem(idParam(request), request.body));
  app.put("/api/blacklist/:id", async (request) => updateBlocklistItem(idParam(request), request.body));
  app.delete("/api/blocklist/:id", async (request) => deleteBlocklistItem(idParam(request)));
  app.delete("/api/blacklist/:id", async (request) => deleteBlocklistItem(idParam(request)));
  app.post("/api/blocklist/cleanup-expired", async () => deleteExpiredBlocklistItems());
  app.post("/api/blacklist/cleanup-expired", async () => deleteExpiredBlocklistItems());
  app.delete("/api/blocklist", async () => clearBlocklistItems());
  app.delete("/api/blacklist", async () => clearBlocklistItems());
}
