import type { FastifyInstance } from "fastify";
import { getSettings, updateSettings } from "../settings/settingsStore.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => getSettings());

  app.put("/api/settings", async (request) => updateSettings(request.body));
}
