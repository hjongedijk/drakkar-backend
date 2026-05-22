import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesIgnoredPattern, normalizePolicyConnectionBudgets } from "../src/policies/policyService.js";

describe("matchesIgnoredPattern", () => {
  it("matches extension and substring ignore patterns", () => {
    const patterns = ["*.nfo", "*sample*"];

    assert.equal(matchesIgnoredPattern("/vfs/downloads/movie.nfo", patterns), true);
    assert.equal(matchesIgnoredPattern("/vfs/downloads/Sample.Movie.mkv", patterns), true);
    assert.equal(matchesIgnoredPattern("/vfs/downloads/movie.mkv", patterns), false);
  });

  it("matches recursive folder patterns", () => {
    const patterns = ["BDMV/**", "VIDEO_TS/**"];

    assert.equal(matchesIgnoredPattern("/vfs/downloads/BDMV/STREAM/file.m2ts", patterns), true);
    assert.equal(matchesIgnoredPattern("/vfs/downloads/VIDEO_TS/VTS_01_1.VOB", patterns), true);
    assert.equal(matchesIgnoredPattern("/vfs/downloads/movie/VIDEO/file.mkv", patterns), false);
  });

  it("does not permanently reserve streaming connections away from downloads", () => {
    assert.deepEqual(
      normalizePolicyConnectionBudgets({
        totalEnabledConnections: 30,
        maxStreamingConnections: 10,
        maxDownloadConnections: 20
      }),
      {
        maxStreamingConnections: 10,
        maxDownloadConnections: 20,
        maxTotalUsenetConnections: 30
      }
    );
  });
});
