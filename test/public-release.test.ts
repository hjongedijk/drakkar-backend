import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPublicRelease, toPublicReleases } from "../src/releases/public.js";
import type { Release } from "../src/releases/types.js";

function release(downloadUrl?: string): Release {
  return {
    title: "Movie.2026.1080p.WEB-DL-GROUP",
    guid: "guid-1",
    indexer: "NZBHydra2",
    downloadUrl,
    hdr: false,
    dv: false,
    isRepack: false,
    isProper: false,
    isRemux: false,
    rawAttributes: {}
  };
}

describe("toPublicRelease", () => {
  it("removes NZBHydra API keys from download URLs", () => {
    const result = toPublicRelease(release("http://hydra/getnzb/api/123?apikey=secret&foo=bar"));

    assert.equal(result.downloadUrl, "http://hydra/getnzb/api/123?foo=bar");
  });

  it("leaves releases without valid URLs unchanged", () => {
    const input = release("not a url");
    const result = toPublicRelease(input);

    assert.equal(result.downloadUrl, "not a url");
  });

  it("sanitizes release arrays", () => {
    const result = toPublicReleases([
      release("http://hydra/getnzb/api/1?apikey=secret"),
      release("http://hydra/getnzb/api/2?apikey=secret&x=1")
    ]);

    assert.equal(result[0]?.downloadUrl, "http://hydra/getnzb/api/1");
    assert.equal(result[1]?.downloadUrl, "http://hydra/getnzb/api/2?x=1");
  });
});
