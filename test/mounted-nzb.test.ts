import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMountedPath } from "../src/vfs/mountedNzbService.js";

describe("mounted NZB VFS helpers", () => {
  it("detects mounted paths", () => {
    assert.equal(isMountedPath("/mounted/releases"), true);
    assert.equal(isMountedPath("/mounted/releases/document-id/file.mkv"), true);
    assert.equal(isMountedPath("/mounted/document-id/file.mkv"), true);
    assert.equal(isMountedPath("/completed/movie.mkv"), false);
  });

  it("does not treat regular VFS paths as mounted stream paths", () => {
    assert.equal(isMountedPath("/downloads/file.mkv"), false);
    assert.equal(isMountedPath("/mounted/completed/movie.mkv"), false);
    assert.equal(isMountedPath("/mounted/downloads/file.mkv"), false);
    assert.equal(isMountedPath("/mounted/nzb/file.nzb"), false);
    assert.equal(isMountedPath("/mounted-release/file.mkv"), false);
  });
});
