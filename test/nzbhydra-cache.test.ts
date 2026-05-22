import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";

const originalFetch = globalThis.fetch;

const { redis } = await import("../src/db/redis.js");
const { searchNzbhydra, searchCacheKey } = await import("../src/indexers/nzbhydra/client.js");

const settings = {
  nzbhydraUrl: "http://hydra.local",
  nzbhydraApiKey: "key",
  nzbhydraCategories: ["5000", "2000"],
  nzbhydraTimeoutMs: 5000,
  nzbhydraCacheTtlSeconds: 300
};

const keysToDelete = new Set<string>();

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (keysToDelete.size > 0) {
    await redis.del(...keysToDelete);
    keysToDelete.clear();
  }
});

describe("searchNzbhydra", () => {
  it("reuses cached identical searches", async () => {
    let fetchCount = 0;
    const params = {
      kind: "movie" as const,
      query: `Cache Movie ${Date.now()}`,
      categories: ["2000", "5000", "2000"]
    };
    const key = searchCacheKey(settings as never, params);
    keysToDelete.add(key);
    await redis.del(key);

    globalThis.fetch = (async () => {
      fetchCount += 1;
      return xmlResponse("cached-guid", "Cached Movie");
    }) as typeof fetch;

    const first = await searchNzbhydra(settings as never, params);
    const second = await searchNzbhydra(settings as never, { ...params, categories: ["5000", "2000"] });

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(fetchCount, 1);
  });

  it("dedupes concurrent identical searches in flight", async () => {
    let fetchCount = 0;
    const params = {
      kind: "episode" as const,
      query: `Cache Show ${Date.now()}`,
      tvdbId: "1234",
      season: 1,
      episode: 2,
      categories: ["5000"]
    };
    const key = searchCacheKey(settings as never, params);
    keysToDelete.add(key);
    await redis.del(key);

    globalThis.fetch = (async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return xmlResponse("inflight-guid", "Cache Show S01E02");
    }) as typeof fetch;

    const [first, second] = await Promise.all([
      searchNzbhydra(settings as never, params),
      searchNzbhydra(settings as never, { ...params })
    ]);

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(fetchCount, 1);
  });
});

function xmlResponse(guid: string, title: string) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<rss>
  <channel>
    <item>
      <title>${title}</title>
      <guid>${guid}</guid>
      <link>http://hydra.local/details/${guid}</link>
      <enclosure url="http://hydra.local/getnzb/${guid}" length="12345" />
      <attr name="category" value="5000" />
    </item>
  </channel>
</rss>`,
    {
      status: 200,
      headers: { "content-type": "application/xml" }
    }
  );
}
