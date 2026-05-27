export type TaskStatus = "idle" | "running" | "success" | "failed" | "disabled";

export type TaskDefinition = {
  id: string;
  name: string;
  description: string;
  intervalMs?: number | null;
  enabled: boolean;
  manualRunnable?: boolean;
};

export type ScheduledTask = TaskDefinition & {
  status: TaskStatus;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  nextRunAt: string | null;
  lastError: string | null;
};

const tasks = new Map<string, ScheduledTask>();

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function registerTask(definition: TaskDefinition) {
  const existing = tasks.get(definition.id);
  tasks.set(definition.id, {
    ...definition,
    status: definition.enabled ? existing?.status ?? "idle" : "disabled",
    lastStartedAt: existing?.lastStartedAt ?? null,
    lastCompletedAt: existing?.lastCompletedAt ?? null,
    lastDurationMs: existing?.lastDurationMs ?? null,
    nextRunAt: existing?.nextRunAt ?? null,
    lastError: existing?.lastError ?? null
  });
}

export function listTasks() {
  return [...tasks.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getTask(id: string) {
  return tasks.get(id) ?? null;
}

export function setTaskNextRun(id: string, nextRunAt: Date | string | null) {
  const task = tasks.get(id);
  if (!task) return;
  task.nextRunAt = toIso(nextRunAt);
}

export function markTaskCompleted(id: string, error?: unknown) {
  const task = tasks.get(id);
  if (!task) return;
  task.status = error ? "failed" : task.enabled ? "success" : "disabled";
  task.lastCompletedAt = new Date().toISOString();
  if (task.lastStartedAt) task.lastDurationMs = Date.now() - new Date(task.lastStartedAt).getTime();
  task.lastError = error ? error instanceof Error ? error.message : String(error) : null;
}

export async function runTrackedTask<T>(id: string, action: () => Promise<T>): Promise<T | undefined> {
  const task = tasks.get(id);
  if (!task) return action();
  if (!task.enabled) {
    task.status = "disabled";
    return undefined;
  }
  // A long-running operation cannot be safely cancelled or duplicated in-process.
  // Restarting the service is the recovery path for a genuinely hung task.
  if (task.status === "running") return undefined;

  const startedAt = Date.now();
  task.status = "running";
  task.lastStartedAt = new Date(startedAt).toISOString();
  task.lastError = null;

  try {
    const result = await action();
    markTaskCompleted(id);
    return result;
  } catch (error) {
    markTaskCompleted(id, error);
    throw error;
  }
}
