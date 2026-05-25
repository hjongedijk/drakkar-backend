import test from "node:test";
import assert from "node:assert/strict";
import { requestDuplicateRank, requestMatchesIdentity } from "../src/requests/sync/requestIdentity.js";
import { titlesLikelyMatch } from "../src/media-library/identity.js";

test("requestMatchesIdentity matches requests by shared external IDs", () => {
  const existing = {
    mediaType: "movie",
    title: "Avatar: The Way of Water",
    year: 2022,
    tmdbId: "76600",
    tvdbId: null,
    imdbId: "tt1630029",
    downloadId: null,
    status: "approved",
    selectedRelease: null,
    requestedQuality: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z")
  };

  assert.equal(
    requestMatchesIdentity(existing, {
      externalId: "2",
      mediaType: "movie",
      title: "Avatar The Way of Water",
      year: 2022,
      tmdbId: "76600"
    }),
    true
  );
});

test("requestMatchesIdentity does not merge same-title shows with different IDs", () => {
  const existing = {
    mediaType: "tv",
    title: "ONE PIECE",
    year: 2023,
    tmdbId: "111110",
    tvdbId: "392276",
    imdbId: "tt11737520",
    downloadId: null,
    status: "approved",
    selectedRelease: null,
    requestedQuality: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z")
  };

  assert.equal(
    requestMatchesIdentity(existing, {
      externalId: "55",
      mediaType: "tv",
      title: "One Piece",
      year: 1999,
      tmdbId: "37854",
      tvdbId: "81797",
      imdbId: "tt0388629"
    }),
    false
  );
});

test("requestMatchesIdentity falls back to title and year only when neither side has IDs", () => {
  const existing = {
    mediaType: "movie",
    title: "Project Hail Mary",
    year: 2026,
    tmdbId: null,
    tvdbId: null,
    imdbId: null,
    downloadId: null,
    status: "pending",
    selectedRelease: null,
    requestedQuality: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z")
  };

  assert.equal(
    requestMatchesIdentity(existing, {
      externalId: "77",
      mediaType: "movie",
      title: "Project.Hail.Mary",
      year: 2026
    }),
    true
  );
});

test("requestDuplicateRank prefers rows with download links and imports", () => {
  const weak = {
    mediaType: "tv",
    title: "NCIS",
    year: 2003,
    tmdbId: null,
    tvdbId: "72108",
    imdbId: null,
    downloadId: null,
    status: "approved",
    selectedRelease: null,
    requestedQuality: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    imports: []
  };
  const strong = {
    ...weak,
    downloadId: "download-1",
    status: "grabbed",
    selectedRelease: { title: "NCIS.S12E01" },
    imports: [{ id: "import-1" }]
  };

  assert.ok(requestDuplicateRank(strong) > requestDuplicateRank(weak));
});

test("titlesLikelyMatch rejects unrelated numeric title collisions", () => {
  assert.equal(titlesLikelyMatch("Avatar 5", "The King's Avatar - For the Glory"), false);
});

test("titlesLikelyMatch rejects bait subtitle collisions", () => {
  assert.equal(titlesLikelyMatch("Arthur the King", "[HnY] Beyblade Burst GT 29 - Assault! Arthur, the King of HELL!! (1080p)"), false);
});

test("titlesLikelyMatch keeps close sequel-title variants", () => {
  assert.equal(titlesLikelyMatch("John Wick Chapter 4", "John Wick 4"), true);
});
