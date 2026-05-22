import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchMediaMetadata, fetchSeasonEpisodes, fetchSeriesStructure } from "../src/metadata/metadataService.js";

const originalFetch = globalThis.fetch;

const settings = {
  tmdbApiKey: "tmdb-key",
  tvdbApiKey: "",
  metadataLanguage: "en-US",
  metadataCacheTtlHours: 168
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("metadataService cache", () => {
  it("reuses cached series structure and season episode lookups", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/search/tv")) {
        return json({ results: [{ id: 101, name: "Cached Show", first_air_date: "2025-01-01" }] });
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

    const lookup = { mediaType: "tv", title: "Cached Show", year: 2025 };
    const firstStructure = await fetchSeriesStructure(settings as never, lookup);
    const secondStructure = await fetchSeriesStructure(settings as never, lookup);
    const firstEpisodes = await fetchSeasonEpisodes(settings as never, "101", 1);
    const secondEpisodes = await fetchSeasonEpisodes(settings as never, "101", 1);

    assert.deepEqual(firstStructure, secondStructure);
    assert.deepEqual(firstEpisodes, secondEpisodes);
    assert.equal(calls.filter((url) => url.includes("/search/tv")).length, 1);
    assert.equal(calls.filter((url) => url.includes("/tv/101?")).length, 1);
    assert.equal(calls.filter((url) => url.includes("/tv/101/season/1")).length, 1);
  });

  it("reuses cached media metadata lookups", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/search/movie")) {
        return json({ results: [{ id: 301, title: "Cache Movie", release_date: "2026-01-01" }] });
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

    const lookup = { mediaType: "movie", title: "Cache Movie", year: 2026 };
    const first = await fetchMediaMetadata(settings as never, lookup);
    const second = await fetchMediaMetadata(settings as never, lookup);

    assert.deepEqual(first, second);
    assert.equal(calls.filter((url) => url.includes("/search/movie")).length, 1);
    assert.equal(calls.filter((url) => url.includes("/movie/301")).length, 1);
  });
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
