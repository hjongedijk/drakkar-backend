import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMountedPath, parseMountedPath } from "../src/services/mountedNzbService.js";
import { isPar2File } from "../src/services/extract/detect.js";

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

  it("parses mounted release file paths with embedded file ids", () => {
    assert.deepEqual(
      parseMountedPath("/mounted/releases/cmpl1ln8g00aeswmbgxn317ok/cmpl1lod204byswmbrkp4wjn2-Movie.Name.2024.mkv"),
      {
        parts: ["mounted", "releases", "cmpl1ln8g00aeswmbgxn317ok", "cmpl1lod204byswmbrkp4wjn2-Movie.Name.2024.mkv"],
        documentId: "cmpl1ln8g00aeswmbgxn317ok",
        mountPath: "/mounted/releases/cmpl1ln8g00aeswmbgxn317ok",
        isReleasePath: true,
        isRoot: false,
        isArchivePath: false,
        fileIndex: 3,
        rawSegment: "cmpl1lod204byswmbrkp4wjn2-Movie.Name.2024.mkv",
        decodedSegment: "cmpl1lod204byswmbrkp4wjn2-Movie.Name.2024.mkv",
        fileId: "cmpl1lod204byswmbrkp4wjn2"
      }
    );
    assert.equal(parseMountedPath("/completed/movie.mkv"), null);
  });

  it("detects par2 repair files even when names contain media extensions", () => {
    assert.equal(isPar2File("Episode.S01E01.1080p.WEB-DL.mkv.par2"), true);
    assert.equal(isPar2File("Episode.S01E01.1080p.WEB-DL.mkv"), false);
  });
});
