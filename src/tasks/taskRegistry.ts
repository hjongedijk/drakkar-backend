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
const STALE_RUNNING_TASK_MS = 10 * 60_000;

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isStaleRunningTask(task: Pick<ScheduledTask, "status" | "lastStartedAt"> | undefined) {
  if (!task || task.status !== "running" || !task.lastStartedAt) return false;
  return Date.now() - new Date(task.lastStartedAt).getTime() > STALE_RUNNING_TASK_MS;
}

export function isTaskStaleRunning(id: string) {
  return isStaleRunningTask(tasks.get(id));
}

export function registerTask(definition: TaskDefinition) {
  const existing = tasks.get(definition.id);
  const recoveredRunning = isStaleRunningTask(existing);
  tasks.set(definition.id, {
    ...definition,
    status: definition.enabled ? recoveredRunning ? "idle" : existing?.status ?? "idle" : "disabled",
    lastStartedAt: existing?.lastStartedAt ?? null,
    lastCompletedAt: existing?.lastCompletedAt ?? null,
    lastDurationMs: existing?.lastDurationMs ?? null,
    nextRunAt: existing?.nextRunAt ?? null,
    lastError: recoveredRunning ? "Recovered stale running task after restart." : existing?.lastError ?? null
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
  if (task.status === "running" && !isStaleRunningTask(task)) return undefined;
  if (task.status === "running" && isStaleRunningTask(task)) {
    task.status = "failed";
    task.lastError = "Recovered stale running task.";
    task.lastCompletedAt = new Date().toISOString();
    if (task.lastStartedAt) task.lastDurationMs = Date.now() - new Date(task.lastStartedAt).getTime();
  }

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
