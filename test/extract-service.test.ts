import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractArchivesInPath } from "../src/services/extractService.js";

function run(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

describe("extractArchivesInPath", () => {
  it("extracts zip archives into a sibling extraction folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usenet-vfs-extract-"));
    const source = join(dir, "sample.txt");
    const archive = join(dir, "sample.zip");
    await writeFile(source, "hello from zip");
    await run("zip", ["-q", archive, "sample.txt"], dir);

    const results = await extractArchivesInPath(dir);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "zip");
    assert.equal(await readFile(join(dir, "sample_extracted", "sample.txt"), "utf8"), "hello from zip");
  });
});
