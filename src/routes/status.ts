import type { FastifyInstance } from "fastify";
import { getDiagnosticsHandler, getStatusHandler, getUsenetDebugHandler } from "../controllers/statusController.js";
import { healthRoutes } from "./health.js";

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  await healthRoutes(app);
  app.get("/api/status", getStatusHandler);
  app.get("/api/diagnostics", getDiagnosticsHandler);
  app.get("/api/debug/usenet", getUsenetDebugHandler);
}
