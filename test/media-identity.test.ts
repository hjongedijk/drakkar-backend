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

  it("detects TV episodes from 1x03 titles", () => {
    assert.deepEqual(inferMediaIdentity("Example.Show.1x03.1080p.WEB-DL-GROUP"), {
      mediaType: "tv",
      title: "Example Show",
      season: 1,
      episode: 3
    });
  });

  it("detects multi-episode titles using the first episode as identity anchor", () => {
    assert.deepEqual(inferMediaIdentity("Example.Show.S02E12E13.1080p.BluRay.x264-GROUP"), {
      mediaType: "tv",
      title: "Example Show",
      season: 2,
      episode: 12
    });
  });

  it("detects season packs without pretending they are one episode", () => {
    assert.deepEqual(inferMediaIdentity("Example.Show.S04.1080p.WEB-DL-GROUP"), {
      mediaType: "tv",
      title: "Example Show",
      season: 4
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
