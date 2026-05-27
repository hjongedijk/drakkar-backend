import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { env } from "../../config/env.js";
import { redis } from "../../../repositories/db/redis.js";
import { parseNewznabResponse } from "../newznab/parser.js";
import type { AppSettings } from "../../settings/settingsStore.js";
import type { Release } from "../../releases/types.js";
import { parseNzbXml } from "../../nzb/parser.js";
import { classifyNzbImportPlan } from "../../usenet/importMode.js";
import { looksLikeArchiveRelease } from "../../releases/archiveHeuristics.js";
import { assertServiceAllowed, guardedExternalCall, recordServiceFailure, recordServiceSuccess } from "../../serviceGuard.js";
import { DRAKKAR_VERSION } from "../../../models/version.js";

export type SearchKind = "movie" | "tv" | "season" | "episode" | "manual" | "rss";

export type SearchParams = {
  kind: SearchKind;
  query?: string;
  imdbId?: string;
  tmdbId?: string;
  tvdbId?: string;
  season?: number;
  episode?: number;
  categories?: string[];
  limit?: number;
  offset?: number;
};

const inFlightSearches = new Map<string, Promise<Release[]>>();
const inFlightNzbFetches = new Map<string, Promise<Awaited<ReturnType<typeof fetchNzbForReleaseUncached>>>>();
const inFlightFeedRefreshes = new Map<string, Promise<Release[]>>();
const SEARCH_METRICS_KEY = "metrics:nzbhydra:search";
const MOVIE_CATEGORIES = ["2030", "2040", "2045", "2050", "2060"];
const TV_CATEGORIES = ["5030", "5040", "5045", "5080"];
const DEFAULT_SEARCH_PAGE_LIMIT = 100;
const MAX_TARGETED_SEARCH_RESULTS = 1000;
const FEED_PAGE_LIMIT = 200;
const MAX_FEED_RESULTS_BY_MEDIA_TYPE = {
  movie: 1000,
  tv: 1000
} as const;
const MIN_FEED_CACHE_TTL_SECONDS = 3600;
const FEED_STALE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_RESULTS_BY_KIND: Record<SearchKind, number> = {
  movie: 120,
  tv: 160,
  season: 120,
  episode: 40,
  manual: 200,
  rss: FEED_PAGE_LIMIT
};
const DEFAULT_TIMEOUT_BUDGET_MS_BY_KIND: Record<SearchKind, number> = {
  movie: 7_000,
  tv: 8_000,
  season: 7_000,
  episode: 6_000,
  manual: 10_000,
  rss: 15_000
};
const NZBHYDRA_SERVICE = "nzbhydra2";
const NZBHYDRA_GUARD_OPTIONS = { failureLimit: 10, cooldownSeconds: 60 };
const DRAKKAR_USER_AGENT = `Drakkar/${DRAKKAR_VERSION} (NZBHydra2 client; +https://wiki.drakkar.botcontrol.nl/)`;
const DRAKKAR_DOWNLOAD_USER_AGENT = `Drakkar/${DRAKKAR_VERSION}`;
const NZB_CACHE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
let lastNzbCacheCleanupAt = 0;

function defaultCategoriesForKind(kind: SearchKind) {
  if (kind === "movie") return MOVIE_CATEGORIES;
  if (["tv", "season", "episode"].includes(kind)) return TV_CATEGORIES;
  return null;
}

function defaultMaxResultsForKind(kind: SearchKind) {
  return DEFAULT_MAX_RESULTS_BY_KIND[kind] ?? MAX_TARGETED_SEARCH_RESULTS;
}

function searchBudgetMs(settings: AppSettings, params: SearchParams) {
  return Math.max(1_500, Math.min(settings.nzbhydraTimeoutMs, DEFAULT_TIMEOUT_BUDGET_MS_BY_KIND[params.kind] ?? settings.nzbhydraTimeoutMs));
}

function resolvedCategories(settings: AppSettings, params: SearchParams) {
  const configured = params.categories?.length ? params.categories : defaultCategoriesForKind(params.kind) ?? settings.nzbhydraCategories;
  return [...new Set(configured.map((value) => value.trim()).filter(Boolean))];
}

function isReleaseSpecificDownloadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /NZB download failed with HTTP (400|401|403|404|410|429)\b/i.test(message);
}

function nzbhydraFetch(input: URL | string, timeoutMs: number) {
  return fetch(input, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "user-agent": DRAKKAR_USER_AGENT
    }
  });
}

async function fetchWithRedirectAwareUserAgent(input: URL, timeoutMs: number, hydraBaseUrl: string) {
  const hydraOrigin = new URL(hydraBaseUrl).origin;
  let currentUrl = input;
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const userAgent = currentUrl.origin === hydraOrigin ? DRAKKAR_USER_AGENT : DRAKKAR_DOWNLOAD_USER_AGENT;
    const response = await fetch(currentUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      headers: {
        "user-agent": userAgent
      }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`NZB download redirect missing location (HTTP ${response.status})`);
      currentUrl = new URL(location, response.url);
      continue;
    }
    return response;
  }
  throw new Error("NZB download failed: too many redirects");
}

async function buildNzbDownloadError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  let detail = "";
  if (/xml|json|text/i.test(contentType)) {
    try {
      const text = (await response.text()).trim();
      const xmlDescription = text.match(/description="([^"]+)"/i)?.[1];
      const jsonMessage = text.match(/"message"\s*:\s*"([^"]+)"/i)?.[1];
      detail = xmlDescription ?? jsonMessage ?? text.slice(0, 160);
    } catch {
      detail = "";
    }
  }
  return detail
    ? new Error(`NZB download failed with HTTP ${response.status}: ${detail}`)
    : new Error(`NZB download failed with HTTP ${response.status}`);
}

export function isNzbhydraConfigured(settings: AppSettings) {
  return Boolean(settings.nzbhydraUrl && settings.nzbhydraApiKey);
}

async function requireHydra(settings: AppSettings) {
  await assertServiceAllowed(NZBHYDRA_SERVICE, isNzbhydraConfigured(settings), "NZBHydra2 is not configured; skipping indexer request");
}

async function buildSearchUrl(settings: AppSettings, params: SearchParams) {
  await requireHydra(settings);
  const url = new URL("/api", settings.nzbhydraUrl);
  url.searchParams.set("apikey", settings.nzbhydraApiKey ?? "");
  url.searchParams.set("o", "xml");
  url.searchParams.set("t", params.kind === "manual" || params.kind === "rss" ? "search" : ["tv", "season", "episode"].includes(params.kind) ? "tvsearch" : params.kind);
  if (params.query) url.searchParams.set("q", params.query);
  if (params.imdbId) url.searchParams.set("imdbid", params.imdbId.replace(/^tt/, ""));
  if (params.tmdbId) url.searchParams.set("tmdbid", params.tmdbId);
  if (params.tvdbId) url.searchParams.set("tvdbid", params.tvdbId);
  if (params.season) url.searchParams.set("season", String(params.season));
  if (params.episode) url.searchParams.set("ep", String(params.episode));
  url.searchParams.set("cat", resolvedCategories(settings, params).join(","));
  if (params.limit) url.searchParams.set("limit", String(params.limit));
  if (params.offset) url.searchParams.set("offset", String(params.offset));
  return url;
}

function normalizeSearchParams(settings: AppSettings, params: SearchParams) {
  return {
    kind: params.kind,
    query: params.query?.trim() || undefined,
    imdbId: params.imdbId?.trim() || undefined,
    tmdbId: params.tmdbId?.trim() || undefined,
    tvdbId: params.tvdbId?.trim() || undefined,
    season: params.season ?? undefined,
    episode: params.episode ?? undefined,
    categories: resolvedCategories(settings, params).sort(),
    limit: params.limit ?? undefined,
    offset: params.offset ?? undefined
  };
}

export function searchCacheKey(settings: AppSettings, params: SearchParams) {
  const normalized = { version: 3, ...normalizeSearchParams(settings, params) };
  return `nzbhydra:search:${createHash("sha1").update(JSON.stringify(normalized)).digest("hex")}`;
}

async function incrementSearchMetric(field: string) {
  await redis.hincrby(SEARCH_METRICS_KEY, field, 1).catch(() => undefined);
}

export async function getNzbhydraSearchMetrics() {
  const raw = await redis.hgetall(SEARCH_METRICS_KEY).catch(() => ({} as Record<string, string>));
  return {
    cacheHits: Number(raw.cacheHits ?? 0),
    cacheMisses: Number(raw.cacheMisses ?? 0),
    inFlightShares: Number(raw.inFlightShares ?? 0),
    networkFetches: Number(raw.networkFetches ?? 0),
    nzbCacheHits: Number(raw.nzbCacheHits ?? 0),
    nzbCacheMisses: Number(raw.nzbCacheMisses ?? 0),
    nzbInFlightShares: Number(raw.nzbInFlightShares ?? 0),
    nzbNetworkFetches: Number(raw.nzbNetworkFetches ?? 0),
    feedCacheHits: Number(raw.feedCacheHits ?? 0),
    feedCacheMisses: Number(raw.feedCacheMisses ?? 0),
    feedNetworkFetches: Number(raw.feedNetworkFetches ?? 0),
    semanticCacheHits: Number(raw.semanticCacheHits ?? 0)
  };
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function feedCacheKey(settings: AppSettings, mediaType: "movie" | "tv") {
  const normalized = {
    version: 3,
    hydra: settings.nzbhydraUrl,
    mediaType,
    categories: mediaType === "tv" ? TV_CATEGORIES : MOVIE_CATEGORIES,
    maxResults: resolvedFeedMaxResults(settings, mediaType)
  };
  return `nzbhydra:feed:${createHash("sha1").update(JSON.stringify(normalized)).digest("hex")}`;
}

function staleFeedCacheKey(settings: AppSettings, mediaType: "movie" | "tv") {
  return `${feedCacheKey(settings, mediaType)}:stale`;
}

function resolvedFeedMaxResults(settings: AppSettings, mediaType: "movie" | "tv") {
  return Math.min(
    Math.max(1, settings.nzbhydraFeedMaxResults),
    MAX_FEED_RESULTS_BY_MEDIA_TYPE[mediaType]
  );
}

function titleMatches(releaseTitle: string, query?: string) {
  if (!query) return true;
  const haystack = normalizeTitle(releaseTitle);
  const needle = normalizeTitle(query);
  if (!needle) return true;
  const compactHaystack = haystack.replaceAll(" ", "");
  const compactNeedle = needle.replaceAll(" ", "");
  return haystack.includes(needle) || haystack.includes(compactNeedle) || compactHaystack.includes(compactNeedle);
}

function seasonTitlePattern(season: number) {
  return new RegExp(`(?:\\bS0?${season}(?:\\b|E\\d{1,3}\\b)|\\b0?${season}x\\d{1,3}\\b)`, "i");
}

function episodeTitlePattern(season: number | undefined, episode: number) {
  return season
    ? new RegExp(`(?:\\bS0?${season}E0?${episode}\\b|\\b0?${season}x0?${episode}\\b)`, "i")
    : new RegExp(`(?:\\bS\\d{1,2}E0?${episode}\\b|\\b\\d{1,2}x0?${episode}\\b)`, "i");
}

function releaseMatchesSearch(release: Release, params: SearchParams) {
  if (!titleMatches(release.title, params.query)) return false;
  if (params.imdbId && release.imdbId && release.imdbId.replace(/^tt/i, "") !== params.imdbId.replace(/^tt/i, "")) return false;
  if (params.tmdbId && release.tmdbId && release.tmdbId !== params.tmdbId) return false;
  if (params.tvdbId && release.tvdbId && release.tvdbId !== params.tvdbId) return false;

  if (["tv", "season", "episode"].includes(params.kind)) {
    const season = params.season;
    const episode = params.episode;
    if (season) {
      const hasSeasonToken = seasonTitlePattern(season).test(release.title);
      if (release.season && release.season !== season) return false;
      if (!release.season && !hasSeasonToken) return false;
    }
    if (episode) {
      if (release.episode && release.episode !== episode) return false;
      if (!release.episode && !episodeTitlePattern(season ?? 0, episode).test(release.title)) return false;
    }
  }

  return true;
}

async function cachedFeedResults(settings: AppSettings, mediaType: "movie" | "tv") {
  const cached = await redis.get(feedCacheKey(settings, mediaType)).catch(() => null);
  if (!cached) return null;
  await incrementSearchMetric("feedCacheHits");
  return JSON.parse(cached) as Release[];
}

async function staleFeedResults(settings: AppSettings, mediaType: "movie" | "tv") {
  const cached = await redis.get(staleFeedCacheKey(settings, mediaType)).catch(() => null);
  if (!cached) return null;
  await incrementSearchMetric("feedCacheHits");
  return JSON.parse(cached) as Release[];
}

async function searchFromFeeds(settings: AppSettings, params: SearchParams) {
  const mediaType = ["tv", "season", "episode"].includes(params.kind) ? "tv" : params.kind === "movie" ? "movie" : null;
  if (!mediaType) return null;
  const releases = await cachedFeedResults(settings, mediaType);
  if (!releases) return null;
  const matched = releases.filter((release) => releaseMatchesSearch(release, params));
  if (matched.length === 0) return null;
  await incrementSearchMetric("semanticCacheHits");
  return matched;
}

export async function searchNzbhydraCachedOnly(settings: AppSettings, params: SearchParams): Promise<Release[]> {
  await requireHydra(settings);
  const cacheKey = searchCacheKey(settings, params);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    await incrementSearchMetric("cacheHits");
    return JSON.parse(cached) as Release[];
  }
  const feedMatched = await searchFromFeeds(settings, params);
  if (feedMatched) {
    await redis.set(cacheKey, JSON.stringify(feedMatched), "EX", settings.nzbhydraCacheTtlSeconds).catch(() => undefined);
    return feedMatched;
  }
  return [];
}

async function refreshFeed(settings: AppSettings, mediaType: "movie" | "tv") {
  const cacheKey = feedCacheKey(settings, mediaType);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    const parsed = JSON.parse(cached) as Release[];
    if (parsed.length > 0) {
      await incrementSearchMetric("feedCacheHits");
      return parsed;
    }
  }
  const existing = inFlightFeedRefreshes.get(cacheKey);
  if (existing) return existing;
  const stale = await staleFeedResults(settings, mediaType);
  if (stale) {
    void (async () => {
      try {
        await refreshFeedUncached(settings, mediaType, cacheKey);
      } catch {
        // Stale feed is intentionally kept serving while background refresh retries later.
      }
    })();
    return stale;
  }
  return refreshFeedUncached(settings, mediaType, cacheKey);
}

async function refreshFeedUncached(settings: AppSettings, mediaType: "movie" | "tv", cacheKey: string) {
  const existing = inFlightFeedRefreshes.get(cacheKey);
  if (existing) return existing;
  const promise = (async () => {
    await incrementSearchMetric("feedCacheMisses");
    await incrementSearchMetric("feedNetworkFetches");
    const deadlineAt = Date.now() + searchBudgetMs(settings, { kind: "rss", categories: mediaType === "tv" ? TV_CATEGORIES : MOVIE_CATEGORIES });
    const maxResults = resolvedFeedMaxResults(settings, mediaType);
    const releases = await fetchPagedSearch(settings, {
      kind: "rss",
      categories: mediaType === "tv" ? TV_CATEGORIES : MOVIE_CATEGORIES
    }, Math.min(FEED_PAGE_LIMIT, maxResults), maxResults, deadlineAt);
    await redis.set(cacheKey, JSON.stringify(releases), "EX", Math.max(settings.nzbhydraFeedCacheTtlSeconds, MIN_FEED_CACHE_TTL_SECONDS));
    await redis.set(staleFeedCacheKey(settings, mediaType), JSON.stringify(releases), "EX", FEED_STALE_CACHE_TTL_SECONDS).catch(() => undefined);
    return releases;
  })();
  inFlightFeedRefreshes.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightFeedRefreshes.delete(cacheKey);
  }
}

async function forceRefreshFeed(settings: AppSettings, mediaType: "movie" | "tv") {
  const cacheKey = feedCacheKey(settings, mediaType);
  return refreshFeedUncached(settings, mediaType, cacheKey);
}

export async function refreshNzbhydraUpdateFeeds(settings: AppSettings) {
  if (!isNzbhydraConfigured(settings)) {
    return { movies: 0, tv: 0, errors: ["NZBHydra2 is not configured; update feed skipped"] };
  }
  const movies = await Promise.resolve(forceRefreshFeed(settings, "movie")).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason })
  );
  const tv = await Promise.resolve(forceRefreshFeed(settings, "tv")).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason })
  );
  return {
    movies: movies.status === "fulfilled" ? movies.value.length : 0,
    tv: tv.status === "fulfilled" ? tv.value.length : 0,
    errors: [movies, tv].flatMap((item) => item.status === "rejected" ? [item.reason instanceof Error ? item.reason.message : "feed refresh failed"] : [])
  };
}

async function releaseDownloadUrl(settings: AppSettings, release: Release) {
  await requireHydra(settings);
  if (!release.downloadUrl) throw new Error("release has no download URL");

  const url = new URL(release.downloadUrl, settings.nzbhydraUrl);
  if (!url.searchParams.has("apikey")) url.searchParams.set("apikey", settings.nzbhydraApiKey ?? "");
  return url;
}

function safeNzbFilename(release: Release, fallback: string) {
  const rawName = String(release.guid || release.title || fallback || "release");
  const safeName = rawName.replace(/[^a-z0-9._-]+/gi, "_").replace(/_+/g, "_").slice(0, 180) || "release";
  return safeName.toLowerCase().endsWith(".nzb") ? safeName : `${safeName}.nzb`;
}

function nzbFetchCacheKey(settings: AppSettings, release: Release) {
  const normalized = {
    hydra: settings.nzbhydraUrl,
    guid: release.guid ? String(release.guid) : undefined,
    downloadUrl: release.downloadUrl ? String(release.downloadUrl) : undefined,
    title: release.title
  };
  return `nzbhydra:nzb:${createHash("sha1").update(JSON.stringify(normalized)).digest("hex")}`;
}

async function pruneExpiredNzbCacheFiles(settings: AppSettings) {
  const now = Date.now();
  if (now - lastNzbCacheCleanupAt < NZB_CACHE_CLEANUP_INTERVAL_MS) return;
  lastNzbCacheCleanupAt = now;

  const ttlMs = Math.max(60, settings.nzbhydraCacheTtlSeconds) * 1000;
  const cutoff = now - ttlMs;
  const entries = await readdir(env.VFS_NZB_DIR, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^hydra-cache-.*\.nzb$/i.test(entry.name))
    .map(async (entry) => {
      const path = join(env.VFS_NZB_DIR, entry.name);
      const stats = await stat(path).catch(() => null);
      if (stats && stats.mtimeMs < cutoff) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }));
}

export async function testNzbhydraConnection(settings: AppSettings) {
  await requireHydra(settings);
  const url = new URL("/api", settings.nzbhydraUrl);
  url.searchParams.set("apikey", settings.nzbhydraApiKey ?? "");
  url.searchParams.set("t", "caps");
  url.searchParams.set("o", "xml");
  return guardedExternalCall(NZBHYDRA_SERVICE, isNzbhydraConfigured(settings), "NZBHydra2 is not configured; connection test skipped", async () => {
    const response = await nzbhydraFetch(url, settings.nzbhydraTimeoutMs);
    return { ok: response.ok, status: response.status };
  }, NZBHYDRA_GUARD_OPTIONS);
}

export async function searchNzbhydra(settings: AppSettings, params: SearchParams): Promise<Release[]> {
  await requireHydra(settings);
  const cacheKey = searchCacheKey(settings, params);
  const cached = await redis.get(cacheKey);
  if (cached) {
    await incrementSearchMetric("cacheHits");
    return JSON.parse(cached) as Release[];
  }
  const feedMatched = await searchFromFeeds(settings, params);
  if (feedMatched) {
    await redis.set(cacheKey, JSON.stringify(feedMatched), "EX", settings.nzbhydraCacheTtlSeconds);
    return feedMatched;
  }
  const existing = inFlightSearches.get(cacheKey);
  if (existing) {
    await incrementSearchMetric("inFlightShares");
    return existing;
  }

  const fetchPromise = (async () => {
    await incrementSearchMetric("cacheMisses");
    await incrementSearchMetric("networkFetches");
    const hardCap = defaultMaxResultsForKind(params.kind);
    const pageLimit = Math.max(1, Math.min(params.limit ?? DEFAULT_SEARCH_PAGE_LIMIT, hardCap));
    const maxResults = params.limit ? Math.min(Math.max(params.limit, pageLimit), hardCap) : hardCap;
    const deadlineAt = Date.now() + searchBudgetMs(settings, params);
    const releases = await guardedExternalCall(
      NZBHYDRA_SERVICE,
      isNzbhydraConfigured(settings),
      "NZBHydra2 is not configured; search skipped",
      () => fetchPagedSearch(settings, params, pageLimit, maxResults, deadlineAt),
      NZBHYDRA_GUARD_OPTIONS
    );
    await redis.set(cacheKey, JSON.stringify(releases), "EX", settings.nzbhydraCacheTtlSeconds);
    return releases;
  })();

  inFlightSearches.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightSearches.delete(cacheKey);
  }
}

async function fetchPagedSearch(settings: AppSettings, params: SearchParams, pageLimit: number, maxResults: number, deadlineAt: number) {
  const releases: Release[] = [];
  const seen = new Set<string>();
  let offset = params.offset ?? 0;
  let total: number | undefined;

  while (releases.length < maxResults) {
    const remainingBudgetMs = deadlineAt - Date.now();
    if (remainingBudgetMs <= 0) break;
    const url = await buildSearchUrl(settings, { ...params, limit: pageLimit, offset });
    const response = await nzbhydraFetch(url, Math.max(1_000, Math.min(settings.nzbhydraTimeoutMs, remainingBudgetMs)));
    if (!response.ok) {
      const mediaType = params.kind === "rss" ? `${params.categories?.join(",") ?? "feed"} update feed` : "search";
      throw new Error(`NZBHydra2 ${mediaType} failed with HTTP ${response.status}`);
    }
    const parsed = parseNewznabResponse(await response.text());
    total = parsed.total ?? total;
    for (const release of parsed.releases) {
      const key = release.guid ? String(release.guid) : `${release.title}:${release.size ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      releases.push(release);
      if (releases.length >= maxResults) break;
    }
    if (parsed.releases.length === 0) break;
    offset += parsed.releases.length;
    if (total !== undefined && offset >= total) break;
    if (parsed.releases.length < pageLimit) break;
  }

  return releases;
}

export async function downloadNzb(settings: AppSettings, release: Release) {
  if (looksLikeArchiveRelease(release)) {
    throw new Error("Indexer metadata indicates archive/RAR release; skipping NZB fetch and searching for direct streamable release");
  }
  const { bytes, filename } = await fetchNzbForRelease(settings, release);
  const parsed = parseNzbXml(bytes.toString("utf8"), release.title);
  const plan = classifyNzbImportPlan(parsed);
  if (plan.mode === "unsupported") {
    const reason = plan.reason === "archive_payload"
      ? "Archive/RAR NZB would require full disk materialization; refusing and searching for a direct streamable release"
      : "NZB contains no direct streamable video file";
    throw new Error(reason);
  }
  await mkdir(env.VFS_NZB_DIR, { recursive: true });
  const primaryPath = join(env.VFS_NZB_DIR, filename);
  const backupPath = join(env.NZB_BACKUPS_DIR, filename);
  await writeFile(primaryPath, bytes);
  let finalBackupPath = "";
  if (settings.backupNzbFiles) {
    await mkdir(env.NZB_BACKUPS_DIR, { recursive: true });
    await writeFile(backupPath, bytes);
    finalBackupPath = backupPath;
  }
  return { primaryPath, backupPath: finalBackupPath, bytes: bytes.length };
}

export async function fetchNzbForRelease(settings: AppSettings, release: Release) {
  const cacheKey = nzbFetchCacheKey(settings, release);
  const existing = inFlightNzbFetches.get(cacheKey);
  if (existing) {
    await incrementSearchMetric("nzbInFlightShares");
    return existing;
  }

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { path: string; filename: string; contentType: string };
      const bytes = await readFile(parsed.path);
      await incrementSearchMetric("nzbCacheHits");
      return { bytes, filename: parsed.filename, contentType: parsed.contentType };
    } catch {
      await redis.del(cacheKey).catch(() => undefined);
    }
  }

  const promise = (async () => {
    await incrementSearchMetric("nzbCacheMisses");
    return fetchNzbForReleaseUncached(settings, release, cacheKey);
  })();
  inFlightNzbFetches.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightNzbFetches.delete(cacheKey);
  }
}

async function fetchNzbForReleaseUncached(settings: AppSettings, release: Release, cacheKey: string) {
  const url = await releaseDownloadUrl(settings, release);
  await incrementSearchMetric("nzbNetworkFetches");
  try {
    const response = await fetchWithRedirectAwareUserAgent(url, settings.nzbhydraTimeoutMs, settings.nzbhydraUrl ?? "");
    if (!response.ok) throw await buildNzbDownloadError(response);

    const bytes = Buffer.from(await response.arrayBuffer());
    const disposition = response.headers.get("content-disposition");
    const filenameMatch = disposition?.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    const filename = safeNzbFilename(release, filenameMatch?.[1] ? decodeURIComponent(filenameMatch[1]) : basename(url.pathname));
    await mkdir(env.VFS_NZB_DIR, { recursive: true });
    await pruneExpiredNzbCacheFiles(settings);
    const cachePath = join(env.VFS_NZB_DIR, `hydra-cache-${cacheKey.split(":").at(-1)}.nzb`);
    const contentType = response.headers.get("content-type") ?? "application/x-nzb";
    await writeFile(cachePath, bytes);
    await redis.set(cacheKey, JSON.stringify({ path: cachePath, filename, contentType }), "EX", settings.nzbhydraCacheTtlSeconds).catch(() => undefined);
    await recordServiceSuccess(NZBHYDRA_SERVICE);
    return {
      bytes,
      filename,
      contentType
    };
  } catch (error) {
    if (isReleaseSpecificDownloadError(error)) {
      await recordServiceSuccess(NZBHYDRA_SERVICE);
    } else {
      await recordServiceFailure(NZBHYDRA_SERVICE, error, NZBHYDRA_GUARD_OPTIONS);
    }
    throw error;
  }
}

export async function testDownloadNzb(settings: AppSettings, release: Release) {
  const result = await downloadNzb(settings, release);
  const content = await readFile(result.primaryPath, "utf8");
  const parsed = parseNzbXml(content, release.title);
  return {
    ok: parsed.valid,
    bytes: result.bytes,
    primaryPath: result.primaryPath,
    backupPath: result.backupPath,
    title: parsed.title,
    fileCount: parsed.files.length,
    segmentCount: parsed.segmentCount,
    totalSize: parsed.totalSize,
    errors: parsed.errors
  };
}
