import type { FastifyInstance } from "fastify";
import { authRoutes } from "./auth.js";
import { calendarRoutes } from "./calendar.js";
import { downloadRoutes } from "./downloads.js";
import { graphqlRoutes } from "./graphql.js";
import { libraryRoutes } from "./library.js";
import { logRoutes } from "./logs.js";
import { plexRoutes } from "./plex.js";
import { policyRoutes } from "./policies.js";
import { processingRoutes } from "./processing.js";
import { profileRoutes } from "./profiles.js";
import { requestRoutes } from "./requests.js";
import { sabRoutes } from "./sab.js";
import { searchRoutes } from "./search.js";
import { settingsRoutes } from "./settings.js";
import { setupRoutes } from "./setup.js";
import { statusRoutes } from "./status.js";
import { taskRoutes } from "./tasks.js";
import { usenetRoutes } from "./usenet.js";
import { vfsRoutes } from "./vfs.js";

const routeRegistrations = [
  statusRoutes,
  authRoutes,
  settingsRoutes,
  searchRoutes,
  profileRoutes,
  downloadRoutes,
  vfsRoutes,
  sabRoutes,
  usenetRoutes,
  requestRoutes,
  processingRoutes,
  policyRoutes,
  libraryRoutes,
  logRoutes,
  calendarRoutes,
  taskRoutes,
  plexRoutes,
  setupRoutes,
  graphqlRoutes
] as const;

export async function registerApiRoutes(app: FastifyInstance) {
  for (const registerRoute of routeRegistrations) {
    await app.register(registerRoute);
  }
}
