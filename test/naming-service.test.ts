import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MEDIA_SYMLINKS_DIR ??= "/mnt/media";

const { applyNamingTemplate, cleanPathPart, completedPathFor, DEFAULT_NAMING_SETTINGS, libraryPathFor } = await import("../src/naming/namingService.js");

describe("naming service", () => {
  it("applies tokens and zero padding", () => {
    const name = applyNamingTemplate("{title} - S{season:00}E{episode:00}", {
      mediaType: "tv",
      title: "Example Show",
      season: 2,
      episode: 3
    });

    assert.equal(name, "Example Show - S02E03");
  });

  it("cleans illegal path characters", () => {
    assert.equal(cleanPathPart('Bad: Movie / Name? '), "Bad - Movie + Name!");
  });

  it("builds completed and STRM library paths", () => {
    const media = { mediaType: "movie", title: "Example Movie", year: 2026 };
    const completedPath = completedPathFor({ media, sourcePath: "/tmp/source.mkv", naming: DEFAULT_NAMING_SETTINGS });
    const libraryPath = libraryPathFor({ media, completedPath, naming: DEFAULT_NAMING_SETTINGS, strategy: "strm" });

    assert.match(completedPath, /Example Movie \(2026\)\.mkv$/);
    assert.match(libraryPath, new RegExp(`^${process.env.MEDIA_SYMLINKS_DIR?.replace(/\//g, "\\/")}\\/movies\\/`));
    assert.match(libraryPath, /Example Movie \(2026\)\.strm$/);
  });
});
