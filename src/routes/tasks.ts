import type { FastifyInstance } from "fastify";
import { listTasksHandler, runTaskHandler } from "../controllers/taskController.js";
import { getSettings } from "../services/settings/settingsStore.js";
import { registerCoreTasks } from "../workers/tasks/coreTasks.js";

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  registerCoreTasks(await getSettings().catch(() => undefined));

  app.get("/api/tasks", listTasksHandler);
  app.post("/api/tasks/:id/run", runTaskHandler);
}
