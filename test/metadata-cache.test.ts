import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchMediaMetadata, fetchSeasonEpisodes, fetchSeriesStructure } from "../src/services/metadataService.js";
import { redis } from "../src/repositories/db/redis.js";

const originalFetch = globalThis.fetch;
const originalRedisGet = redis.get.bind(redis);
const originalRedisSet = redis.set.bind(redis);
const redisCache = new Map<string, string>();

const settings = {
  tmdbApiKey: "tmdb-key",
  tvdbApiKey: "",
  metadataLanguage: "en-US",
  metadataCacheTtlHours: 168
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  redisCache.clear();
  redis.get = originalRedisGet as typeof redis.get;
  redis.set = originalRedisSet as typeof redis.set;
});

describe("metadataService cache", () => {
  it("reuses cached series structure and season episode lookups", async () => {
    redis.get = (async (key: string) => redisCache.get(key) ?? null) as typeof redis.get;
    redis.set = (async (key: string, value: string) => {
      redisCache.set(key, value);
      return "OK";
    }) as typeof redis.set;
    const uniqueTitle = `Cached Show ${Date.now()}`;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/search/tv")) {
        return json({ results: [{ id: 101, name: uniqueTitle, first_air_date: "2025-01-01" }] });
      }
      if (url.includes("/tv/101/season/1")) {
        return json({ episodes: [{ episode_number: 1, name: "Pilot" }] });
      }
      if (url.includes("/tv/101")) {
        return json({
          id: 101,
          name: "Cached Show",
          status: "Returning Series",
          number_of_seasons: 1,
          number_of_episodes: 1,
          seasons: [{ season_number: 1, name: "Season 1", episode_count: 1, air_date: "2025-01-01" }],
          external_ids: { tvdb_id: 202 }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const lookup = { mediaType: "tv", title: uniqueTitle, year: 2025 };
    const firstStructure = await fetchSeriesStructure(settings as never, lookup);
    const secondStructure = await fetchSeriesStructure(settings as never, lookup);
    const firstEpisodes = await fetchSeasonEpisodes(settings as never, "101", 1);
    const secondEpisodes = await fetchSeasonEpisodes(settings as never, "101", 1);

    assert.deepEqual(firstStructure, secondStructure);
    assert.deepEqual(firstEpisodes, secondEpisodes);
    assert.equal(calls.filter((url) => url.includes("/search/tv")).length, 1);
    assert.ok(calls.filter((url) => url.includes("/tv/101?")).length <= 1);
    assert.ok(calls.filter((url) => url.includes("/tv/101/season/1")).length <= 1);
  });

  it("reuses cached media metadata lookups", async () => {
    redis.get = (async (key: string) => redisCache.get(key) ?? null) as typeof redis.get;
    redis.set = (async (key: string, value: string) => {
      redisCache.set(key, value);
      return "OK";
    }) as typeof redis.set;
    const uniqueTitle = `Cache Movie ${Date.now()}`;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/search/movie")) {
        return json({ results: [{ id: 301, title: uniqueTitle, release_date: "2026-01-01" }] });
      }
      if (url.includes("/movie/301")) {
        return json({
          id: 301,
          title: "Cache Movie",
          release_date: "2026-01-01",
          imdb_id: "tt1234567",
          overview: "cached"
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const lookup = { mediaType: "movie", title: uniqueTitle, year: 2026 };
    const first = await fetchMediaMetadata(settings as never, lookup);
    const second = await fetchMediaMetadata(settings as never, lookup);

    assert.deepEqual(first, second);
    assert.equal(calls.filter((url) => url.includes("/search/movie")).length, 1);
    assert.ok(calls.filter((url) => url.includes("/movie/301")).length <= 1);
  });
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
