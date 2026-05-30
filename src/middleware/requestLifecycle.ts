import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export function registerRequestLifecycle(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    const responseTime = reply.elapsedTime;
    if (reply.statusCode >= 500 || responseTime > 2500) {
      const path = request.routeOptions.url || request.url.split("?")[0] || request.url;
      request.log[reply.statusCode >= 500 ? "error" : "warn"]({
        method: request.method,
        path,
        statusCode: reply.statusCode,
        ms: Math.round(responseTime)
      }, "request slow");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    if (rawUrl === "*" || request.url === "*") {
      if (!reply.sent) {
        reply.status(204).send();
      }
      return;
    }
    request.log.error({ err: error }, "request failed");
    const typedError = error as Error & { statusCode?: number };
    const statusCode = typedError.statusCode ?? 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : typedError.name,
      message: typedError.message,
      requestId: request.id
    });
  });
}

export function buildRequestId(headers: Record<string, string | string[] | undefined>) {
  const header = headers["x-request-id"];
  return Array.isArray(header) ? header[0] ?? randomUUID() : header ?? randomUUID();
}
