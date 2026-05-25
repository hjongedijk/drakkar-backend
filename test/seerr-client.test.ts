import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RequestProvider } from "@prisma/client";
import { fetchSeerrRequests, updateSeerrAvailable } from "../src/requests/seerr/client.js";

const originalFetch = globalThis.fetch;

function provider(): RequestProvider {
  return {
    id: "provider-1",
    type: "seerr",
    name: "Seerr",
    baseUrl: "http://seerr.local",
    apiKey: "test-key",
    enabled: true,
    syncIntervalMinutes: 30,
    defaultMovieProfile: null,
    defaultTvProfile: null,
    lastSyncAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchSeerrRequests", () => {
  it("paginates beyond the first 100 requests", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url);
      const skip = Number(parsed.searchParams.get("skip") ?? "0");
      const take = Number(parsed.searchParams.get("take") ?? "100");
      const page = Math.floor(skip / take);
      const total = 205;
      const pageResults = Array.from({ length: Math.max(0, Math.min(take, total - skip)) }, (_, index) => {
        const id = skip + index + 1;
        return {
          id,
          type: id % 2 === 0 ? "movie" : "tv",
          media: {
            mediaType: id % 2 === 0 ? "movie" : "tv",
            tmdbId: id + 1000,
            tvdbId: id % 2 === 0 ? undefined : id + 2000
          },
          movie: { title: `Movie ${id}`, releaseDate: "2026-01-01" },
          tv: { name: `Show ${id}`, firstAirDate: "2026-01-01" }
        };
      });
      return new Response(JSON.stringify({
        pageInfo: {
          pages: Math.ceil(total / take),
          pageSize: take,
          results: total,
          page
        },
        results: pageResults
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const results = await fetchSeerrRequests(provider());

    const listCalls = calls.filter((url) => url.includes("/api/v1/request?"));

    assert.equal(results.length, 205);
    assert.equal(listCalls.length, 3);
    assert.match(listCalls[0] ?? "", /skip=0/);
    assert.match(listCalls[1] ?? "", /skip=100/);
    assert.match(listCalls[2] ?? "", /skip=200/);
  });

  it("normalizes requested seasons and episodes for tv requests", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      pageInfo: { pages: 1, pageSize: 100, results: 1, page: 0 },
      results: [{
        id: 10,
        type: "tv",
        media: { mediaType: "tv", tmdbId: 55, tvdbId: 66 },
        tv: { name: "Example Show", firstAirDate: "2024-04-01" },
        seasons: [
          {
            seasonNumber: 2,
            episodes: [{ episodeNumber: 3 }, { episodeNumber: 4 }]
          },
          { seasonNumber: 1 }
        ]
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

    const [request] = await fetchSeerrRequests(provider());

    assert.deepEqual(request?.seasons, [{ seasonNumber: 1 }, { seasonNumber: 2 }]);
    assert.deepEqual(request?.episodes, [
      { seasonNumber: 2, episodeNumber: 3 },
      { seasonNumber: 2, episodeNumber: 4 }
    ]);
  });
});

describe("updateSeerrAvailable", () => {
  it("updates the Seerr media status endpoint documented for availability", async () => {
    const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body });
      if (String(input).endsWith("/api/v1/request/42")) {
        return new Response(JSON.stringify({ id: 42, is4k: false, media: { id: 77, mediaType: "movie" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 77, status: 5 }), { status: 200 });
    }) as typeof fetch;

    const result = await updateSeerrAvailable(provider(), "42");

    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, "http://seerr.local/api/v1/request/42");
    assert.equal(calls[1]?.url, "http://seerr.local/api/v1/media/77/available");
    assert.equal(calls[1]?.method, "POST");
    assert.equal(calls[1]?.body, JSON.stringify({ is4k: false }));
  });
});
