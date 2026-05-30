import cors from "@fastify/cors";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { registerAuthenticationHooks } from "../middleware/authentication.js";
import { buildRequestId, registerRequestLifecycle } from "../middleware/requestLifecycle.js";
import { registerCoreTasks } from "../workers/tasks/coreTasks.js";
import { buildLineLogger } from "./logging/lineLogger.js";
import { registerApiRoutes } from "../routes/registerRoutes.js";

export function buildApp(mode: "backend" = env.APP_ROLE) {
  if (mode === "backend") registerCoreTasks();
  const app = Fastify({
    loggerInstance: buildLineLogger(env.LOG_LEVEL),
    disableRequestLogging: true,
    routerOptions: {
      ignoreTrailingSlash: true
    },
    genReqId: (request) => buildRequestId(request.headers)
  });
  app.addHttpMethod("PROPFIND", { hasBody: false });
  app.addHook("onRequest", async (request, reply) => {
    const url = request.raw.url ?? "/";
    const method = request.method.toUpperCase();
    if (url === "*") {
      // Some clients send server-wide "*" probes. End them at the raw socket level
      // so they never reach routing/error handling or generate noisy 500 logs.
      reply.hijack();
      reply.raw.statusCode = method === "OPTIONS" ? 200 : 204;
      reply.raw.setHeader("x-request-id", request.id);
      reply.raw.end();
      return;
    }
    const webdavRootMethod = method === "OPTIONS" || method === "PROPFIND" || method === "GET" || method === "HEAD";
    if (webdavRootMethod && (url === "/" || url.startsWith("/?"))) {
      request.raw.url = `/dav${url.slice(1)}`;
      return;
    }
    if (url === "/dav/") {
      request.raw.url = "/dav";
      return;
    }
    if (url.startsWith("/dav/?")) {
      request.raw.url = `/dav${url.slice("/dav/".length)}`;
    }
  });

  registerRequestLifecycle(app);
  registerAuthenticationHooks(app);

  void app.register(cors, { origin: true });
  void app.register(registerApiRoutes);

  return app;
}
