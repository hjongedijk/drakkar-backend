import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRepairOutcome, deriveImportHealth, estimateHealthProgress } from "../src/health/checks.js";

describe("health check helpers", () => {
  it("classifies repaired jobs before healthy fallback", () => {
    const outcome = deriveImportHealth({
      repair: {
        type: "par2-verify-repair",
        status: "completed",
        message: "PAR2 repair completed"
      },
      primarySymlink: { status: "ok" }
    });

    assert.equal(outcome, "repaired");
  });

  it("classifies deleted jobs from repair message", () => {
    assert.equal(
      classifyRepairOutcome({
        type: "background-mounted-healthcheck",
        status: "completed",
        message: "File had missing articles. Deleted file."
      }),
      "deleted"
    );
  });

  it("estimates running repair progress", () => {
    assert.equal(
      estimateHealthProgress({
        type: "par2-verify-repair",
        status: "running",
        message: "running PAR2 verify/repair"
      }),
      70
    );
  });
});
