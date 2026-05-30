import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingArticleCooldownPlan, rotateMonitoredSeasonSlice } from "../src/services/requests/sync/mediaRequestService.js";

describe("rotateMonitoredSeasonSlice", () => {
  it("starts from the saved next season and advances the cursor", () => {
    const seasons = [{ season: 1 }, { season: 2 }, { season: 3 }, { season: 4 }];
    const result = rotateMonitoredSeasonSlice(seasons, 3, 1);
    assert.deepEqual(result.slice, [{ season: 3 }]);
    assert.equal(result.nextCursor, 4);
  });

  it("wraps back to the beginning after the tail", () => {
    const seasons = [{ season: 1 }, { season: 2 }, { season: 3 }];
    const result = rotateMonitoredSeasonSlice(seasons, 4, 1);
    assert.deepEqual(result.slice, [{ season: 1 }]);
    assert.equal(result.nextCursor, 2);
  });

  it("returns the whole list when it fits in one pass", () => {
    const seasons = [{ season: 2 }];
    const result = rotateMonitoredSeasonSlice(seasons, 2, 1);
    assert.deepEqual(result.slice, [{ season: 2 }]);
    assert.equal(result.nextCursor, 2);
  });
});

describe("missingArticleCooldownPlan", () => {
  it("keeps movie requests on a longer request-level cooldown", () => {
    const result = missingArticleCooldownPlan({ mediaType: "movie" });
    assert.equal(result.wantedTtlSeconds, 8 * 60 * 60);
    assert.equal(result.season, null);
    assert.equal(result.seasonTtlSeconds, null);
  });

  it("uses a short request cooldown but long season cooldown for targeted TV failures", () => {
    const result = missingArticleCooldownPlan({
      mediaType: "tv",
      seasonTarget: { seasonNumber: 5 }
    });
    assert.equal(result.wantedTtlSeconds, 15 * 60);
    assert.equal(result.season, 5);
    assert.equal(result.seasonTtlSeconds, 8 * 60 * 60);
  });

  it("falls back to a request-level TV cooldown when no season hint exists", () => {
    const result = missingArticleCooldownPlan({ mediaType: "tv" });
    assert.equal(result.wantedTtlSeconds, 2 * 60 * 60);
    assert.equal(result.season, null);
    assert.equal(result.seasonTtlSeconds, null);
  });
});
