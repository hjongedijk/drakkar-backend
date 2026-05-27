import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export function registerRequestLifecycle(app: FastifyInstance) {
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
}

export function buildRequestId(headers: Record<string, string | string[] | undefined>) {
  const header = headers["x-request-id"];
  return Array.isArray(header) ? header[0] ?? randomUUID() : header ?? randomUUID();
}
