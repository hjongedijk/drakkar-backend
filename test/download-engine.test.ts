import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";

const { filenameFromSubject } = await import("../src/usenet/filename.js");
const { classifyNzbImportMode } = await import("../src/usenet/importMode.js");

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

  it("preserves par2 filenames instead of truncating them to fake video names", () => {
    const filename = filenameFromSubject('[1/8] "The.Boys.S04E02.2024.1080p.Amazon.WEB-DL.AVC.DDP.5.1-DBTV.mkv.par2" yEnc (1/1)', 0);

    assert.equal(filename, "The.Boys.S04E02.2024.1080p.Amazon.WEB-DL.AVC.DDP.5.1-DBTV.mkv.par2");
  });

  it("extracts quoted multipart archive filenames cleanly", () => {
    const filename = filenameFromSubject('[2/67] "The.Rookie.S01E13.Caught.Stealing.REPACK.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.part01.rar" yEnc (1/68)', 0);

    assert.equal(filename, "The.Rookie.S01E13.Caught.Stealing.REPACK.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.part01.rar");
  });
});

describe("classifyNzbImportMode", () => {
  it("uses mounted mode for direct media payloads", () => {
    const mode = classifyNzbImportMode({
      files: [
        { subject: '"Show.S01E01.1080p.WEB-DL.mkv" yEnc (1/10)' },
        { subject: '"Show.S01E01.1080p.WEB-DL.srt" yEnc (1/1)' }
      ]
    });

    assert.equal(mode, "mounted");
  });

  it("rejects archive payloads instead of downloading them to disk", () => {
    const mode = classifyNzbImportMode({
      files: [
        { subject: '[1/57] "Movie.2026.part01.rar" yEnc (1/200)' },
        { subject: '[2/57] "Movie.2026.part02.rar" yEnc (1/200)' }
      ]
    });

    assert.equal(mode, "unsupported");
  });
});
