import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRange } from "../src/streaming/rangePlanner.service.js";

describe("normalizeRange", () => {
  it("returns the full file range when no range is provided", () => {
    assert.deepEqual(normalizeRange(undefined, 1000), { start: 0, end: 999 });
  });

  it("parses bounded byte ranges", () => {
    assert.deepEqual(normalizeRange("bytes=100-199", 1000), { start: 100, end: 199 });
  });

  it("clamps open-ended ranges to file size", () => {
    assert.deepEqual(normalizeRange("bytes=900-", 1000), { start: 900, end: 999 });
  });

  it("parses suffix ranges", () => {
    assert.deepEqual(normalizeRange("bytes=-250", 1000), { start: 750, end: 999 });
  });

  it("rejects invalid ranges", () => {
    assert.throws(() => normalizeRange("items=1-2", 1000), /invalid range/);
    assert.throws(() => normalizeRange("bytes=200-100", 1000), /invalid range/);
    assert.throws(() => normalizeRange("bytes=1000-", 1000), /exceeds/);
  });
});
