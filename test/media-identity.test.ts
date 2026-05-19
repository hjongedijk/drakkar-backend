import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferMediaIdentity } from "../src/media-library/identity.js";

describe("inferMediaIdentity", () => {
  it("detects TV episodes from release-style titles", () => {
    assert.deepEqual(inferMediaIdentity("Example.Show.S02E07.1080p.WEB-DL.x265-GROUP"), {
      mediaType: "tv",
      title: "Example Show",
      season: 2,
      episode: 7
    });
  });

  it("detects movies and release years", () => {
    assert.deepEqual(inferMediaIdentity("Example.Movie.2026.2160p.BluRay.x265-GROUP"), {
      mediaType: "movie",
      title: "Example Movie",
      year: 2026
    });
  });
});
