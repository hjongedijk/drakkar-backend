import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferMediaIdentity } from "../src/services/media-library/identity.js";

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

  it("detects long-running anime episode numbers", () => {
    assert.deepEqual(inferMediaIdentity("One.Piece.S01E1162.1080p.NF.WEB-DL.AAC2.0.H.264-VARYG"), {
      mediaType: "tv",
      title: "One Piece",
      season: 1,
      episode: 1162
    });
  });

  it("detects high-season-number TV episodes", () => {
    assert.deepEqual(inferMediaIdentity("House.Hunters.S194E08.Fast.and.Furious.in.Kansas.City.WEB.h264-CAFFEiNE"), {
      mediaType: "tv",
      title: "House Hunters",
      season: 194,
      episode: 8
    });
  });

  it("detects anime EP-style numbering without seasons", () => {
    assert.deepEqual(inferMediaIdentity("One.Piece.EP1163.I.Want.You.to.Praise.Me.The.Reunion.of.Robin.and.Saul.1080p.BILI.WEB-DL.JPN.AAC2.0.H.265.MSubs-ToonsHub"), {
      mediaType: "tv",
      title: "One Piece",
      episode: 1163
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
