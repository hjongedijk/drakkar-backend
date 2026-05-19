import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { getAuthUserByApiKey, getAuthUserById } from "./auth/service.js";
import { authCookieName, getSessionUserId, parseCookie } from "./auth/session.js";
import { authRoutes } from "./routes/auth.js";
import { settingsRoutes } from "./routes/settings.js";
import { statusRoutes } from "./routes/status.js";
import { searchRoutes } from "./routes/search.js";
import { profileRoutes } from "./routes/profiles.js";
import { downloadRoutes } from "./routes/downloads.js";
import { vfsRoutes } from "./routes/vfs.js";
import { sabRoutes } from "./routes/sab.js";
import { usenetRoutes } from "./routes/usenet.js";
import { requestRoutes } from "./routes/requests.js";
import { processingRoutes } from "./routes/processing.js";
import { policyRoutes } from "./routes/policies.js";
import { libraryRoutes } from "./routes/library.js";
import { logRoutes } from "./routes/logs.js";
import { calendarRoutes } from "./routes/calendar.js";

export function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug"
    },
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      return Array.isArray(header) ? header[0] ?? randomUUID() : header ?? randomUUID();
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (!request.url.startsWith("/api/")) return;
    const parsedUrl = new URL(request.url, env.APP_BASE_URL);
    const apiToken = request.headers["x-api-token"] ?? parsedUrl.searchParams.get("apiToken") ?? "";
    if (apiToken !== env.FRONTEND_API_TOKEN) {
      return reply.status(401).send({ message: "Invalid frontend API token." });
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (!request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/auth/login")) return;

    const authorization = request.headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
    const sessionToken = parseCookie(request.headers.cookie, authCookieName);
    const sessionUserId = await getSessionUserId(sessionToken);
    const user = sessionUserId
      ? await getAuthUserById(sessionUserId)
      : await getAuthUserByApiKey(bearerToken);

    if (!user) return reply.status(401).send({ message: "Authentication required." });
    request.authUser = user;
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : error.name,
      message: error.message,
      requestId: request.id
    });
  });

  void app.register(cors, { origin: true });
  void app.register(swagger, {
    openapi: {
      info: {
        title: "Drakkar API",
        version: "0.1.1"
      }
    }
  });
  void app.register(swaggerUi, {
    routePrefix: "/docs"
  });

  void app.register(statusRoutes);
  void app.register(authRoutes);
  void app.register(settingsRoutes);
  void app.register(searchRoutes);
  void app.register(profileRoutes);
  void app.register(downloadRoutes);
  void app.register(vfsRoutes);
  void app.register(sabRoutes);
  void app.register(usenetRoutes);
  void app.register(requestRoutes);
  void app.register(processingRoutes);
  void app.register(policyRoutes);
  void app.register(libraryRoutes);
  void app.register(logRoutes);
  void app.register(calendarRoutes);

  return app;
}
