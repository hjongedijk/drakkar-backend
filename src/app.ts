import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
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
import { taskRoutes } from "./routes/tasks.js";
import { plexRoutes } from "./routes/plex.js";
import { getSetupStatus, setupRoutes } from "./routes/setup.js";
import { registerCoreTasks } from "./tasks/coreTasks.js";
import { graphqlRoutes } from "./routes/graphql.js";
import { buildLineLogger } from "./logging/lineLogger.js";

const API_TOKEN_AUTH_USER = {
  id: "drakkar-api-token",
  username: "drakkar",
  displayName: "Drakkar API",
  isAdmin: true,
  mustChangePassword: false
} as const;

export function buildApp() {
  registerCoreTasks();
  const app = Fastify({
    loggerInstance: buildLineLogger(env.LOG_LEVEL),
    disableRequestLogging: true,
    ignoreTrailingSlash: true,
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      return Array.isArray(header) ? header[0] ?? randomUUID() : header ?? randomUUID();
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    const responseTime = reply.elapsedTime;
    if (reply.statusCode >= 400 || responseTime > 1000) {
      request.log[reply.statusCode >= 500 ? "error" : "warn"]({
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime
      }, "request completed");
    }
  });

  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS") return;
    if (!request.url.startsWith("/api/")) return;
    if (request.url === "/api/health") return;
    const parsedUrl = new URL(request.url, env.APP_BASE_URL);
    const drakkarApiToken = env.getDrakkarApiToken(env.CONFIG_DIR);
    const authorization = request.headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
    const headerToken = Array.isArray(request.headers["x-api-token"]) ? request.headers["x-api-token"][0] : request.headers["x-api-token"];
    const apiToken = headerToken ?? parsedUrl.searchParams.get("apiToken") ?? (bearerToken === drakkarApiToken ? bearerToken : "");
    if (!apiToken || apiToken !== drakkarApiToken) return;
    request.authUser = { ...API_TOKEN_AUTH_USER };
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (!request.url.startsWith("/api/")) return;
    {
      const parsedUrl = new URL(request.url, env.APP_BASE_URL);
      if (parsedUrl.pathname === "/api/health") return;
      if (parsedUrl.pathname === "/api/setup/status") return;
      const setup = await getSetupStatus();
      if (parsedUrl.pathname === "/api/setup/complete") {
        if (!setup.completed) return;
      } else if (!setup.completed) {
        return reply.status(428).send({ message: "Setup must be completed before using Drakkar." });
      }
    }
    if (request.url.startsWith("/api/auth/login")) return;
    if (request.authUser) return;

    const parsedUrl = new URL(request.url, env.APP_BASE_URL);
    if (parsedUrl.pathname === "/api/webhooks/seerr") return;
    const authorization = request.headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
    const sessionToken = parseCookie(request.headers.cookie, authCookieName);
    const sessionUserId = await getSessionUserId(sessionToken);
    const user = sessionUserId
      ? await getAuthUserById(sessionUserId)
      : await getAuthUserByApiKey(bearerToken);

    if (!user) {
      if (request.method === "GET" && ["/api/docs", "/api/graphql"].includes(parsedUrl.pathname) && !parsedUrl.searchParams.has("query")) {
        return reply.redirect("/login");
      }
      return reply.status(401).send({ message: "Authentication required." });
    }
    request.authUser = user;
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const typedError = error as Error & { statusCode?: number };
    const statusCode = typedError.statusCode ?? 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : typedError.name,
      message: typedError.message,
      requestId: request.id
    });
  });

  void app.register(cors, { origin: true });
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
  void app.register(taskRoutes);
  void app.register(plexRoutes);
  void app.register(setupRoutes);
  void app.register(graphqlRoutes);

  return app;
}
