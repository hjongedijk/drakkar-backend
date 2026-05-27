import cors from "@fastify/cors";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { registerAuthenticationHooks } from "../middleware/authentication.js";
import { buildRequestId, registerRequestLifecycle } from "../middleware/requestLifecycle.js";
import { registerCoreTasks } from "../workers/tasks/coreTasks.js";
import { buildLineLogger } from "./logging/lineLogger.js";
import { registerApiRoutes } from "../routes/registerRoutes.js";

export function buildApp() {
  registerCoreTasks();
  const app = Fastify({
    loggerInstance: buildLineLogger(env.LOG_LEVEL),
    disableRequestLogging: true,
    routerOptions: {
      ignoreTrailingSlash: true
    },
    genReqId: (request) => buildRequestId(request.headers)
  });

  registerRequestLifecycle(app);
  registerAuthenticationHooks(app);

  void app.register(cors, { origin: true });
  void app.register(registerApiRoutes);

  return app;
}
