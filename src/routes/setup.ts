import type { FastifyInstance } from "fastify";
import { completeSetupHandler, getSetupStatusHandler } from "../controllers/setupController.js";

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/setup/status", getSetupStatusHandler);
  app.post("/api/setup/complete", completeSetupHandler);
}
