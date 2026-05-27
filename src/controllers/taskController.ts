import type { FastifyReply, FastifyRequest } from "fastify";
import { getSettings } from "../services/settings/settingsStore.js";
import { executeManualTask, exclusiveLibraryMaintenanceTasks, supportedManualTasks } from "../services/taskService.js";
import { registerCoreTasks } from "../workers/tasks/coreTasks.js";
import { getTask, listTasks } from "../workers/tasks/taskRegistry.js";

function taskId(request: FastifyRequest) {
  return (request.params as { id: string }).id;
}

export async function listTasksHandler() {
  registerCoreTasks(await getSettings().catch(() => undefined));
  return { tasks: listTasks() };
}

export async function runTaskHandler(request: FastifyRequest, reply: FastifyReply) {
  const id = taskId(request);
  const task = getTask(id);
  if (!task) return reply.status(404).send({ message: "Task not found." });
  if (!task.manualRunnable) return reply.status(400).send({ message: "Task cannot be run manually." });
  if (task.status === "running") return { task, skipped: true, reason: "already_running" };
  if (!supportedManualTasks.has(id)) return reply.status(404).send({ message: "Task runner not implemented." });
  if (exclusiveLibraryMaintenanceTasks.has(id)) {
    const conflictingTask = [...exclusiveLibraryMaintenanceTasks]
      .filter((maintenanceId) => maintenanceId !== id)
      .map((maintenanceId) => getTask(maintenanceId))
      .find((maintenanceTask) => maintenanceTask?.status === "running");
    if (conflictingTask) {
      return reply.status(409).send({
        task,
        skipped: true,
        reason: "conflicting_task_running",
        conflictingTaskId: conflictingTask.id
      });
    }
  }
  void executeManualTask(id, request.log).catch((error) => {
    request.log.warn({ err: error, taskId: id }, "manual background task failed");
  });
  return reply.status(202).send({ task: getTask(id), skipped: false, accepted: true });
}
