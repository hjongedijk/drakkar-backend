import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTask, registerTask, runTrackedTask } from "../src/workers/tasks/taskRegistry.js";

describe("task registry", () => {
  it("does not start an overlapping execution for a running task", async () => {
    const id = `overlap-${Date.now()}`;
    let finish: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let executions = 0;

    registerTask({ id, name: id, description: id, enabled: true });
    const first = runTrackedTask(id, async () => {
      executions += 1;
      await held;
      return "first";
    });
    const second = await runTrackedTask(id, async () => {
      executions += 1;
      return "second";
    });

    assert.equal(second, undefined);
    assert.equal(executions, 1);
    assert.equal(getTask(id)?.status, "running");

    finish?.();
    assert.equal(await first, "first");
    assert.equal(getTask(id)?.status, "success");
  });
});
