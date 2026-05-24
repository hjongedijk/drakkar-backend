import type { FastifyInstance } from "fastify";
import { getDrakkarApiToken, rotateDrakkarApiToken } from "../config/runtimeSettings.js";
import { getSettings, updateSettings } from "../settings/settingsStore.js";
import { resetEnvironment } from "../system/resetService.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return getSettings();
  });

  app.put("/api/settings", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return updateSettings(request.body);
  });

  app.get("/api/settings/drakkar-api-token", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return {
      drakkarApiToken: getDrakkarApiToken()
    };
  });

  app.post("/api/settings/drakkar-api-token/rotate", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    const runtime = rotateDrakkarApiToken();
    return {
      drakkarApiToken: runtime.drakkarApiToken
    };
  });

  app.get("/api/settings/frontend-token", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return { drakkarApiToken: getDrakkarApiToken() };
  });
  app.post("/api/settings/frontend-token/rotate", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    const runtime = rotateDrakkarApiToken();
    return { drakkarApiToken: runtime.drakkarApiToken };
  });

  app.post("/api/system/reset-environment", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return resetEnvironment();
  });
}
