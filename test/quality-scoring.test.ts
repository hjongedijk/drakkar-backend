import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { QualityProfile } from "@prisma/client";
import { scoreRelease } from "../src/quality/scoring.js";
import type { Release } from "../src/releases/types.js";

const baseProfile: QualityProfile = {
  id: "profile-1",
  name: "Movie Standard",
  allowedQualities: ["1080p"],
  cutoffQuality: "1080p",
  preferredWords: ["web-dl"],
  rejectedWords: ["cam"],
  requiredWords: [],
  minSize: null,
  maxSize: null,
  preferredLanguages: [],
  requiredLanguages: [],
  allowHDR: true,
  allowDV: true,
  allowRemux: true,
  allowBluRay: true,
  allowWebDL: true,
  allowWebRip: true,
  allowX264: true,
  allowX265: true,
  allowAV1: true,
  allowMultiAudio: true,
  rejectCam: true,
  rejectTelesync: true,
  rejectScreener: true,
  rejectPassworded: true,
  rejectSuspicious: true,
  preferProper: true,
  preferRepack: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z")
};

function release(title: string, overrides: Partial<Release> = {}): Release {
  return {
    title,
    guid: title,
    indexer: "test",
    hdr: false,
    dv: false,
    isRepack: false,
    isProper: false,
    isRemux: false,
    rawAttributes: {},
    ...overrides
  };
}

describe("scoreRelease", () => {
  it("accepts and scores a matching 1080p WEB-DL release", () => {
    const decision = scoreRelease(
      release("Movie.2026.1080p.WEB-DL.DDP5.1.H.265-GROUP", {
        resolution: "1080p",
        source: "webdl",
        codec: "h265"
      }),
      baseProfile
    );

    assert.equal(decision.accepted, true);
    assert.equal(decision.reasons.length, 0);
    assert.ok(decision.score > 100);
  });

  it("rejects disallowed qualities and rejected words", () => {
    const decision = scoreRelease(
      release("Movie.2026.2160p.CAM.H.265-GROUP", {
        resolution: "2160p",
        source: "cam",
        codec: "h265"
      }),
      baseProfile
    );

    assert.equal(decision.accepted, false);
    assert.ok(decision.reasons.some((reason) => reason.includes("quality 2160p")));
    assert.ok(decision.reasons.some((reason) => reason.includes("cam")));
    assert.ok(decision.score < 0);
  });

  it("enforces required languages when configured", () => {
    const profile = { ...baseProfile, requiredLanguages: ["english"] };
    const decision = scoreRelease(
      release("Movie.2026.1080p.WEB-DL.FRENCH.H.265-GROUP", {
        resolution: "1080p",
        source: "webdl",
        codec: "h265",
        language: "french"
      }),
      profile
    );

    assert.equal(decision.accepted, false);
    assert.ok(decision.reasons.includes("missing required language: english"));
  });
});
