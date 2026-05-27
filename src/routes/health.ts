import type { FastifyInstance } from "fastify";
import { getHealthChecksHandler, getHealthHandler } from "../controllers/healthController.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            database: { type: "string" },
            valkey: { type: "string" },
            version: { type: "string" },
            servicesUp: { type: "number" },
            servicesTotal: { type: "number" },
            healthPercent: { type: "number" },
            checks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  status: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  }, getHealthHandler);

  app.get("/api/health/checks", getHealthChecksHandler);
}
