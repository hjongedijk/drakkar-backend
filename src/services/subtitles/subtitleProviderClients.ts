import { redis } from "../../repositories/db/redis.js";
import { LocalTtlCache } from "../cache/localTtlCache.js";
import type { AppSettings } from "../settings/settingsStore.js";
import type { SubtitleLookup } from "../../state-machines/subtitleDownloadMachine.js";
import {
  DRAKKAR_OPENSUBTITLES_USER_AGENT,
  type EnabledSubtitleProvider,
  type OpenSubtitlesAuth,
  openSubtitlesAuthCacheKey,
  type SubtitleCandidate,
  normalizeProviderLanguage,
  type SubdlSubtitle,
  stripImdbId,
  subtitleProviderCooldownKey,
  SUBTITLE_PROVIDER_COOLDOWN_SECONDS,
  OPENSUBTITLES_AUTH_CACHE_SECONDS
} from "./subtitleUtils.js";

let openSubtitlesAuthPromise: Promise<OpenSubtitlesAuth> | null = null;
const subtitleProviderCooldownUntil = new Map<EnabledSubtitleProvider, number>();
const subtitleProviderCooldownCache = new LocalTtlCache<boolean>();
const openSubtitlesAuthLocalCache = new LocalTtlCache<OpenSubtitlesAuth>();
const LOCAL_PROVIDER_NEGATIVE_CACHE_MS = 30 * 1000;

async function fetchSubdlJson<T>(settings: AppSettings, path: string, params: Record<string, string>) {
  const url = new URL(path, "https://api.subdl.com/api/v1/");
  url.searchParams.set("api_key", settings.subtitleProviders.subdl.apiKey ?? "");
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      "user-agent": "Drakkar/0.3.0 (subtitle downloader; provider=SubDL)"
    }
  });
  if (!response.ok) {
    const message = `SubDL request failed with HTTP ${response.status}`;
    if (response.status === 429 || response.status === 403) {
      await markSubtitleProviderCooldown("subdl", message);
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function searchSubdlSubtitles(settings: AppSettings, lookup: SubtitleLookup, languages: string[]) {
  const params: Record<string, string> = {
    type: lookup.mediaType,
    subs_per_page: "30",
    languages: languages.join(","),
    unpack: "1"
  };
  if (lookup.tmdbId) params.tmdb_id = lookup.tmdbId;
  else if (lookup.imdbId) params.imdb_id = lookup.imdbId;
  else return [];
  if (lookup.mediaType === "tv" && lookup.season != null) params.season_number = String(lookup.season);
  if (lookup.mediaType === "tv" && lookup.episode != null) params.episode_number = String(lookup.episode);

  const payload = await fetchSubdlJson<{ status?: boolean; subtitles?: SubdlSubtitle[]; error?: string }>(settings, "subtitles", params);
  if (!payload.status) throw new Error(payload.error || "SubDL subtitle search failed");
  return Array.isArray(payload.subtitles) ? payload.subtitles : [];
}

export async function subtitleProviderCoolingDown(provider: EnabledSubtitleProvider) {
  const cacheKey = subtitleProviderCooldownKey(provider);
  const localCooldownUntil = subtitleProviderCooldownUntil.get(provider) ?? 0;
  if (localCooldownUntil > Date.now()) return true;
  const local = subtitleProviderCooldownCache.get(cacheKey);
  if (local !== undefined) return local;
  const remote = Boolean(await redis.get(cacheKey).catch(() => null));
  subtitleProviderCooldownCache.set(cacheKey, remote, remote ? SUBTITLE_PROVIDER_COOLDOWN_SECONDS * 1000 : LOCAL_PROVIDER_NEGATIVE_CACHE_MS);
  return remote;
}

export async function markSubtitleProviderCooldown(provider: EnabledSubtitleProvider, reason: string) {
  const cacheKey = subtitleProviderCooldownKey(provider);
  subtitleProviderCooldownUntil.set(provider, Date.now() + SUBTITLE_PROVIDER_COOLDOWN_SECONDS * 1000);
  subtitleProviderCooldownCache.set(cacheKey, true, SUBTITLE_PROVIDER_COOLDOWN_SECONDS * 1000);
  await redis.set(cacheKey, reason, "EX", SUBTITLE_PROVIDER_COOLDOWN_SECONDS).catch(() => undefined);
}

async function loginOpenSubtitlesRaw(settings: AppSettings): Promise<OpenSubtitlesAuth> {
  const response = await fetch("https://api.opensubtitles.com/api/v1/login", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "content-type": "application/json",
      "api-key": settings.subtitleProviders.opensubtitlescom.apiKey ?? "",
      "user-agent": DRAKKAR_OPENSUBTITLES_USER_AGENT,
      "accept": "application/json"
    },
    body: JSON.stringify({
      username: settings.subtitleProviders.opensubtitlescom.username ?? "",
      password: settings.subtitleProviders.opensubtitlescom.password ?? ""
    })
  });
  if (!response.ok) {
    const message = `OpenSubtitles login failed with HTTP ${response.status}`;
    if (response.status === 429 || response.status === 403) {
      await markSubtitleProviderCooldown("opensubtitlescom", message);
    }
    throw new Error(message);
  }
  const payload = await response.json() as { token?: string; base_url?: string };
  if (!payload.token || !payload.base_url) throw new Error("OpenSubtitles login response missing token/base_url");
  const host = payload.base_url.startsWith("http") ? payload.base_url : `https://${payload.base_url}`;
  return {
    token: payload.token,
    baseUrl: host.endsWith("/api/v1") ? host : `${host.replace(/\/+$/, "")}/api/v1`
  };
}

async function loginOpenSubtitles(settings: AppSettings): Promise<OpenSubtitlesAuth> {
  if (await subtitleProviderCoolingDown("opensubtitlescom")) {
    throw new Error("OpenSubtitles provider cooling down after recent auth failure");
  }
  const cacheKey = openSubtitlesAuthCacheKey(settings);
  const local = openSubtitlesAuthLocalCache.get(cacheKey);
  if (local) return local;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    const parsed = JSON.parse(cached) as OpenSubtitlesAuth;
    openSubtitlesAuthLocalCache.set(cacheKey, parsed, OPENSUBTITLES_AUTH_CACHE_SECONDS * 1000);
    return parsed;
  }
  if (!openSubtitlesAuthPromise) {
    openSubtitlesAuthPromise = loginOpenSubtitlesRaw(settings)
      .then(async (auth) => {
        openSubtitlesAuthLocalCache.set(cacheKey, auth, OPENSUBTITLES_AUTH_CACHE_SECONDS * 1000);
        await redis.set(cacheKey, JSON.stringify(auth), "EX", OPENSUBTITLES_AUTH_CACHE_SECONDS).catch(() => undefined);
        return auth;
      })
      .finally(() => {
        openSubtitlesAuthPromise = null;
      });
  }
  return openSubtitlesAuthPromise;
}

export async function searchOpenSubtitles(settings: AppSettings, lookup: SubtitleLookup, languages: string[]) {
  const auth = await loginOpenSubtitles(settings);
  const url = new URL(`${auth.baseUrl}/subtitles`);
  url.searchParams.set("languages", [...new Set(languages.map(normalizeProviderLanguage))].sort().join(","));
  url.searchParams.set("ai_translated", "exclude");
  const imdbId = stripImdbId(lookup.imdbId);
  if (lookup.mediaType === "movie") {
    if (!imdbId) return { auth, subtitles: [] as SubtitleCandidate[] };
    url.searchParams.set("imdb_id", imdbId);
  } else {
    if (!imdbId) return { auth, subtitles: [] as SubtitleCandidate[] };
    url.searchParams.set("parent_imdb_id", imdbId);
    if (lookup.season != null) url.searchParams.set("season_number", String(lookup.season));
    if (lookup.episode != null) url.searchParams.set("episode_number", String(lookup.episode));
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      "api-key": settings.subtitleProviders.opensubtitlescom.apiKey ?? "",
      "authorization": `Bearer ${auth.token}`,
      "user-agent": DRAKKAR_OPENSUBTITLES_USER_AGENT,
      "accept": "application/json"
    }
  });
  if (!response.ok) {
    const message = `OpenSubtitles subtitle search failed with HTTP ${response.status}`;
    if (response.status === 429 || response.status === 403) {
      await markSubtitleProviderCooldown("opensubtitlescom", message);
    }
    throw new Error(message);
  }
  const payload = await response.json() as {
    data?: Array<{
      attributes?: {
        language?: string;
        ai_translated?: boolean;
        files?: Array<{ file_id?: number }>;
        feature_details?: { season_number?: number; episode_number?: number };
      };
    }>;
  };
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return {
    auth,
    subtitles: rows
      .map((row): SubtitleCandidate | null => {
        const language = row.attributes?.language?.trim();
        const fileId = row.attributes?.files?.[0]?.file_id;
        if (!language || !fileId || row.attributes?.ai_translated) return null;
        return {
          language: language.toUpperCase(),
          fileId,
          season: row.attributes?.feature_details?.season_number,
          episode: row.attributes?.feature_details?.episode_number
        };
      })
      .filter((row): row is SubtitleCandidate => Boolean(row))
  };
}

export async function downloadSubdlSubtitleText(url: string) {
  const response = await fetch(url.startsWith("http") ? url : new URL(url, "https://dl.subdl.com").toString(), {
    signal: AbortSignal.timeout(60_000),
    headers: {
      "user-agent": "Drakkar/0.3.0 (subtitle downloader; provider=SubDL)"
    }
  });
  if (!response.ok) throw new Error(`SubDL download failed with HTTP ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length >= 2 && raw[0] === 0x50 && raw[1] === 0x4b) {
    throw new Error("SubDL returned ZIP data instead of unpacked subtitle text");
  }
  return raw.toString("utf8");
}

export async function downloadOpenSubtitlesSubtitleText(settings: AppSettings, auth: OpenSubtitlesAuth, fileId: number) {
  const response = await fetch(`${auth.baseUrl}/download`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      "api-key": settings.subtitleProviders.opensubtitlescom.apiKey ?? "",
      "authorization": `Bearer ${auth.token}`,
      "user-agent": DRAKKAR_OPENSUBTITLES_USER_AGENT,
      "accept": "application/json"
    },
    body: JSON.stringify({
      file_id: fileId,
      sub_format: "srt"
    })
  });
  if (!response.ok) {
    const message = `OpenSubtitles download metadata failed with HTTP ${response.status}`;
    if (response.status === 429 || response.status === 403) {
      await markSubtitleProviderCooldown("opensubtitlescom", message);
    }
    throw new Error(message);
  }
  const payload = await response.json() as { link?: string };
  if (!payload.link) throw new Error("OpenSubtitles download response missing link");
  const download = await fetch(payload.link, {
    signal: AbortSignal.timeout(60_000),
    headers: {
      "user-agent": DRAKKAR_OPENSUBTITLES_USER_AGENT,
      "accept": "application/json"
    }
  });
  if (!download.ok) {
    const message = `OpenSubtitles subtitle download failed with HTTP ${download.status}`;
    if (download.status === 429 || download.status === 403) {
      await markSubtitleProviderCooldown("opensubtitlescom", message);
    }
    throw new Error(message);
  }
  return Buffer.from(await download.arrayBuffer()).toString("utf8");
}
