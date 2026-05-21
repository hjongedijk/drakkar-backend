import type { FastifyInstance } from "fastify";
import { getSettings, updateSettings } from "../settings/settingsStore.js";
import { resetEnvironment } from "../system/resetService.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => getSettings());

  app.put("/api/settings", async (request) => updateSettings(request.body));

  app.post("/api/system/reset-environment", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return resetEnvironment();
  });
}
