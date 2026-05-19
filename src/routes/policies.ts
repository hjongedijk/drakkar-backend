import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createBlocklistItem,
  deleteBlocklistItem,
  getIgnoredPatterns,
  getPolicySettings,
  listBlocklist,
  testIgnoredPath,
  updateIgnoredPatterns,
  updatePolicySettings
} from "../policies/policyService.js";

const ignoredTestSchema = z.object({
  path: z.string().min(1)
});

function idParam(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

export async function policyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/policies", async () => getPolicySettings());
  app.put("/api/settings/policies", async (request) => updatePolicySettings(request.body));

  app.get("/api/ignored-files", async () => getIgnoredPatterns());
  app.put("/api/ignored-files", async (request) => updateIgnoredPatterns(request.body));
  app.post("/api/ignored-files/test", async (request) => testIgnoredPath(ignoredTestSchema.parse(request.body).path));

  app.get("/api/blocklist", async () => listBlocklist());
  app.get("/api/blacklist", async () => listBlocklist());
  app.post("/api/blocklist", async (request) => createBlocklistItem(request.body));
  app.post("/api/blacklist", async (request) => createBlocklistItem(request.body));
  app.delete("/api/blocklist/:id", async (request) => deleteBlocklistItem(idParam(request)));
  app.delete("/api/blacklist/:id", async (request) => deleteBlocklistItem(idParam(request)));
}
