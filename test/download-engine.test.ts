import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";

const { filenameFromSubject } = await import("../src/usenet/filename.js");

describe("filenameFromSubject", () => {
  it("uses quoted media filenames from NZB subjects", () => {
    const filename = filenameFromSubject('"Movie.2026.1080p.WEB-DL.mkv" yEnc (1/42)', 0);

    assert.equal(filename, "Movie.2026.1080p.WEB-DL.mkv");
  });

  it("extracts unquoted media filenames before the yEnc marker", () => {
    const filename = filenameFromSubject("Show.S01E02.720p.HDTV.x264-GROUP.mkv yEnc (7/99)", 0);

    assert.equal(filename, "Show.S01E02.720p.HDTV.x264-GROUP.mkv");
  });

  it("falls back to a cleaned subject when no filename is present", () => {
    const filename = filenameFromSubject("release payload yEnc (1/1)", 4);

    assert.equal(filename, "release payload");
  });
});
