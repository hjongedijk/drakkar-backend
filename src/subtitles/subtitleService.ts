import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { env } from "../config/env.js";
import { fetchMediaMetadata } from "../metadata/metadataService.js";
import { refreshPlexPath } from "../plex/plexService.js";
import { getSettings, type AppSettings } from "../settings/settingsStore.js";
import { runTrackedTask, setTaskNextRun } from "../tasks/taskRegistry.js";
import { SUBTITLE_BACKFILL_INTERVAL_MS, SUBTITLE_BACKFILL_TASK_ID } from "../tasks/coreTasks.js";

type SubtitleLookup = {
  mediaType: "movie" | "tv";
  title: string;
  year?: number | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
};

type SubdlSubtitle = {
  url?: string;
  lang?: string;
  season?: number;
  episode?: number;
};

type OpenSubtitlesAuth = {
  baseUrl: string;
  token: string;
};

type SubtitleCandidate = {
  language: string;
  url?: string;
  fileId?: number;
  season?: number;
  episode?: number;
};

const subtitleRuns = new Map<string, Promise<{ downloaded: number; skipped: number }>>();
const SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS = 12 * 60 * 60;
const OPENSUBTITLES_AUTH_CACHE_SECONDS = 10 * 60;
const SUBTITLE_PROVIDER_COOLDOWN_SECONDS = 15 * 60;
let openSubtitlesAuthPromise: Promise<OpenSubtitlesAuth> | null = null;
const subtitleProviderCooldownUntil = new Map<EnabledSubtitleProvider, number>();
const DRakkAR_OPENSUBTITLES_USER_AGENT = "Drakkar v0.3.0";

function subtitleLog(level: "info" | "warn", message: string, fields: Record<string, unknown>) {
  const color = level === "warn" ? "\x1b[33m" : "\x1b[36m";
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}="${String(value).replace(/\s+/g, " ").trim()}"`)
    .join(" ");
  console[level](`\x1b[2m${new Date().toISOString()}\x1b[0m ${color}${level.toUpperCase().padEnd(5)}\x1b[0m ${message}${suffix ? ` \x1b[2m${suffix}\x1b[0m` : ""}`);
}

function normalizeSubtitleLanguages(languages: string[]) {
  return [...new Set(
    languages
      .flatMap((language) => language.split(/[,\s]+/))
      .map((language) => language.trim().toUpperCase())
      .filter(Boolean)
  )];
}

type EnabledSubtitleProvider = "subdl" | "opensubtitlescom";

function normalizeProviderLanguage(language: string) {
  const normalized = language.trim().toLowerCase();
  const map = new Map<string, string>([
    ["en", "en"],
    ["nl", "nl"],
    ["pt", "pt-PT"],
    ["pt-pt", "pt-PT"],
    ["pt-br", "pt-BR"],
    ["zh", "zh-CN"],
    ["zh-cn", "zh-CN"],
    ["es-mx", "ea"]
  ]);
  return map.get(normalized) ?? normalized;
}

function stripImdbId(imdbId?: string | null) {
  if (!imdbId) return undefined;
  const cleaned = imdbId.toLowerCase().replace(/^tt/, "").replace(/^0+/, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

function enabledSubtitleProviders(settings: AppSettings): EnabledSubtitleProvider[] {
  const ordered = settings.subtitleProviderOrder?.length ? settings.subtitleProviderOrder : ["subdl", "opensubtitlescom"];
  return ordered.filter((provider, index, array): provider is EnabledSubtitleProvider => {
    if (array.indexOf(provider) !== index) return false;
    if (provider === "subdl") return Boolean(settings.subtitleProviders.subdl.enabled && settings.subtitleProviders.subdl.apiKey);
    return Boolean(
      settings.subtitleProviders.opensubtitlescom.enabled
      && settings.subtitleProviders.opensubtitlescom.apiKey
      && settings.subtitleProviders.opensubtitlescom.username
      && settings.subtitleProviders.opensubtitlescom.password
    );
  });
}

function subtitleLookupKey(lookup: SubtitleLookup) {
  return [
    lookup.mediaType,
    lookup.tmdbId ?? "",
    lookup.tvdbId ?? "",
    lookup.imdbId ?? "",
    lookup.title.toLowerCase(),
    lookup.year ?? "",
    lookup.season ?? "",
    lookup.episode ?? ""
  ].join(":");
}

function subtitleProviderCacheKey(provider: EnabledSubtitleProvider, lookup: SubtitleLookup, language: string) {
  return `subtitle:provider:${provider}:${subtitleLookupKey(lookup)}:${normalizeProviderLanguage(language).toUpperCase()}`;
}

function subtitleProviderCooldownKey(provider: EnabledSubtitleProvider) {
  return `subtitle:provider-cooldown:${provider}`;
}

function openSubtitlesAuthCacheKey(settings: AppSettings) {
  const apiKey = settings.subtitleProviders.opensubtitlescom.apiKey ?? "";
  const username = settings.subtitleProviders.opensubtitlescom.username ?? "";
  return `subtitle:opensubtitles:auth:${username}:${apiKey}`;
}

function sidecarPathFor(mediaPath: string, language: string) {
  const extension = extname(mediaPath);
  const base = extension ? mediaPath.slice(0, -extension.length) : mediaPath;
  return `${base}.${language.toLowerCase()}.srt`;
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function missingLanguagesForPath(mediaPath: string, languages: string[]) {
  const missing: string[] = [];
  for (const language of languages) {
    const subtitlePath = sidecarPathFor(mediaPath, language);
    if (!(await pathExists(subtitlePath))) missing.push(language);
  }
  return missing;
}

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

async function searchSubdlSubtitles(settings: AppSettings, lookup: SubtitleLookup, languages: string[]) {
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

async function subtitleProviderCoolingDown(provider: EnabledSubtitleProvider) {
  const localCooldownUntil = subtitleProviderCooldownUntil.get(provider) ?? 0;
  if (localCooldownUntil > Date.now()) return true;
  return Boolean(await redis.get(subtitleProviderCooldownKey(provider)).catch(() => null));
}

async function markSubtitleProviderCooldown(provider: EnabledSubtitleProvider, reason: string) {
  subtitleProviderCooldownUntil.set(provider, Date.now() + SUBTITLE_PROVIDER_COOLDOWN_SECONDS * 1000);
  await redis.set(subtitleProviderCooldownKey(provider), reason, "EX", SUBTITLE_PROVIDER_COOLDOWN_SECONDS).catch(() => undefined);
}

async function loginOpenSubtitlesRaw(settings: AppSettings): Promise<OpenSubtitlesAuth> {
  const response = await fetch("https://api.opensubtitles.com/api/v1/login", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "content-type": "application/json",
      "api-key": settings.subtitleProviders.opensubtitlescom.apiKey ?? "",
      "user-agent": DRakkAR_OPENSUBTITLES_USER_AGENT,
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
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    return JSON.parse(cached) as OpenSubtitlesAuth;
  }
  if (!openSubtitlesAuthPromise) {
    openSubtitlesAuthPromise = loginOpenSubtitlesRaw(settings)
      .then(async (auth) => {
        await redis.set(cacheKey, JSON.stringify(auth), "EX", OPENSUBTITLES_AUTH_CACHE_SECONDS).catch(() => undefined);
        return auth;
      })
      .finally(() => {
        openSubtitlesAuthPromise = null;
      });
  }
  return openSubtitlesAuthPromise;
}

async function searchOpenSubtitles(settings: AppSettings, lookup: SubtitleLookup, languages: string[]) {
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
      "user-agent": DRakkAR_OPENSUBTITLES_USER_AGENT,
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

async function downloadSubdlSubtitleText(url: string) {
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

async function downloadOpenSubtitlesSubtitleText(settings: AppSettings, auth: OpenSubtitlesAuth, fileId: number) {
  const response = await fetch(`${auth.baseUrl}/download`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      "api-key": settings.subtitleProviders.opensubtitlescom.apiKey ?? "",
      "authorization": `Bearer ${auth.token}`,
      "user-agent": DRakkAR_OPENSUBTITLES_USER_AGENT,
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
      "user-agent": DRakkAR_OPENSUBTITLES_USER_AGENT,
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

function bestSubtitlesPerLanguage(
  subtitles: SubdlSubtitle[],
  lookup: SubtitleLookup,
  languages: string[]
) {
  const wanted = new Set(languages.map((language) => language.toUpperCase()));
  const best = new Map<string, SubdlSubtitle>();
  for (const subtitle of subtitles) {
    const language = subtitle.lang?.trim().toUpperCase();
    if (!language || !wanted.has(language) || !subtitle.url) continue;
    if (
      lookup.mediaType === "tv"
      && lookup.season != null
      && lookup.episode != null
      && ((subtitle.season != null && subtitle.season !== lookup.season) || (subtitle.episode != null && subtitle.episode !== lookup.episode))
    ) {
      continue;
    }
    if (!best.has(language)) best.set(language, subtitle);
  }
  return best;
}

function bestProviderCandidatesPerLanguage(
  subtitles: SubtitleCandidate[],
  lookup: SubtitleLookup,
  languages: string[]
) {
  const wanted = new Set(languages.map((language) => normalizeProviderLanguage(language).toUpperCase()));
  const best = new Map<string, SubtitleCandidate>();
  for (const subtitle of subtitles) {
    const language = normalizeProviderLanguage(subtitle.language).toUpperCase();
    if (!wanted.has(language)) continue;
    if (
      lookup.mediaType === "tv"
      && lookup.season != null
      && lookup.episode != null
      && ((subtitle.season != null && subtitle.season !== lookup.season) || (subtitle.episode != null && subtitle.episode !== lookup.episode))
    ) {
      continue;
    }
    if (!best.has(language)) best.set(language, subtitle);
  }
  return best;
}

async function hydrateLookup(settings: AppSettings, lookup: SubtitleLookup): Promise<SubtitleLookup | null> {
  if (lookup.tmdbId || lookup.imdbId) return lookup;
  const metadata = await fetchMediaMetadata(settings, {
    mediaType: lookup.mediaType,
    title: lookup.title,
    year: lookup.year,
    tmdbId: lookup.tmdbId,
    tvdbId: lookup.tvdbId,
    imdbId: lookup.imdbId,
    season: lookup.season,
    episode: lookup.episode
  }).catch(() => undefined);
  if (!metadata?.tmdbId && !metadata?.imdbId) return null;
  return {
    ...lookup,
    tmdbId: lookup.tmdbId ?? metadata?.tmdbId,
    tvdbId: lookup.tvdbId ?? metadata?.tvdbId,
    imdbId: lookup.imdbId ?? metadata?.imdbId,
    title: metadata?.title ?? lookup.title,
    year: metadata?.year ?? lookup.year
  };
}

export async function ensureSubtitlesForMediaPath(
  mediaPath: string,
  lookupInput: SubtitleLookup,
  settingsOverride?: AppSettings
) {
  const settings = settingsOverride ?? await getSettings();
  const languages = normalizeSubtitleLanguages(settings.subtitleLanguages);
  if (!settings.subtitlesEnabled || languages.length === 0) {
    return { downloaded: 0, skipped: 0, reason: "not_configured" as const };
  }
  const providers = enabledSubtitleProviders(settings);
  if (providers.length === 0) {
    return { downloaded: 0, skipped: 0, reason: "not_configured" as const };
  }
  const lookup = await hydrateLookup(settings, lookupInput);
  if (!lookup) return { downloaded: 0, skipped: languages.length, reason: "missing_ids" as const };
  let missingLanguages = await missingLanguagesForPath(mediaPath, languages);
  if (missingLanguages.length === 0) return { downloaded: 0, skipped: languages.length, reason: "already_present" as const };

  let downloaded = 0;
  let skipped = 0;
  for (const provider of providers) {
    if (missingLanguages.length === 0) break;
    if (await subtitleProviderCoolingDown(provider)) {
      skipped += missingLanguages.length;
      continue;
    }
    const providerEligible: string[] = [];
    for (const language of missingLanguages) {
      const cached = await redis.get(subtitleProviderCacheKey(provider, lookup, language)).catch(() => null);
      if (cached === "miss") continue;
      providerEligible.push(language);
    }
    if (providerEligible.length === 0) continue;

    if (provider === "subdl") {
      const results = await searchSubdlSubtitles(settings, lookup, providerEligible);
      const best = bestSubtitlesPerLanguage(results, lookup, providerEligible);
      for (const language of providerEligible) {
        const subtitle = best.get(language);
        if (!subtitle?.url) {
          await redis.set(subtitleProviderCacheKey(provider, lookup, language), "miss", "EX", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS).catch(() => undefined);
          continue;
        }
        const subtitleText = await downloadSubdlSubtitleText(subtitle.url);
        const targetPath = sidecarPathFor(mediaPath, language);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, subtitleText, "utf8");
        await redis.set(subtitleProviderCacheKey(provider, lookup, language), "hit", "EX", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS).catch(() => undefined);
        downloaded += 1;
        subtitleLog("info", "subtitle downloaded", {
          provider: "SubDL",
          title: lookup.title,
          language,
          mediaPath: basename(targetPath)
        });
      }
    } else {
      const { auth, subtitles } = await searchOpenSubtitles(settings, lookup, providerEligible);
      const best = bestProviderCandidatesPerLanguage(subtitles, lookup, providerEligible);
      for (const language of providerEligible) {
        const key = normalizeProviderLanguage(language).toUpperCase();
        const subtitle = best.get(key);
        if (!subtitle?.fileId) {
          await redis.set(subtitleProviderCacheKey(provider, lookup, language), "miss", "EX", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS).catch(() => undefined);
          continue;
        }
        const subtitleText = await downloadOpenSubtitlesSubtitleText(settings, auth, subtitle.fileId);
        const targetPath = sidecarPathFor(mediaPath, language);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, subtitleText, "utf8");
        await redis.set(subtitleProviderCacheKey(provider, lookup, language), "hit", "EX", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS).catch(() => undefined);
        downloaded += 1;
        subtitleLog("info", "subtitle downloaded", {
          provider: "OpenSubtitles.com",
          title: lookup.title,
          language,
          mediaPath: basename(targetPath)
        });
      }
    }
    missingLanguages = await missingLanguagesForPath(mediaPath, missingLanguages);
  }
  skipped = missingLanguages.length;
  if (downloaded > 0) {
    void refreshPlexPath(mediaPath).catch((error) => {
      subtitleLog("warn", "subtitle plex refresh failed", {
        title: lookup.title,
        mediaPath: basename(mediaPath),
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return { downloaded, skipped };
}

export function scheduleSubtitleSyncForLibraryPath(mediaPath: string, lookup: SubtitleLookup) {
  const key = `${mediaPath}:${lookup.mediaType}:${lookup.tmdbId ?? lookup.imdbId ?? lookup.tvdbId ?? lookup.title}:${lookup.season ?? ""}:${lookup.episode ?? ""}`;
  const existing = subtitleRuns.get(key);
  if (existing) return existing;
  const task = ensureSubtitlesForMediaPath(mediaPath, lookup)
    .catch((error) => {
      subtitleLog("warn", "subtitle download failed", {
        title: lookup.title,
        mediaPath: basename(mediaPath),
        error: error instanceof Error ? error.message : String(error)
      });
      return { downloaded: 0, skipped: 0 };
    })
    .finally(() => {
      subtitleRuns.delete(key);
    });
  subtitleRuns.set(key, task);
  return task;
}

export async function runSubtitleBackfill(logger: FastifyBaseLogger) {
  try {
    const result = await runTrackedTask(SUBTITLE_BACKFILL_TASK_ID, async () => {
      const settings = await getSettings();
      if (!settings.subtitlesEnabled || enabledSubtitleProviders(settings).length === 0) return { checked: 0, downloaded: 0, skipped: 0, reason: "not_configured" as const };
      const items = await prisma.mediaLibraryItem.findMany({
        where: {
          libraryStatus: "available",
          OR: [{ symlinkPath: { not: null } }, { strmPath: { not: null } }]
        },
        orderBy: { updatedAt: "desc" },
        take: 500
      });
      let checked = 0;
      let downloaded = 0;
      let skipped = 0;
      for (const item of items) {
        const mediaPath = item.symlinkPath ?? item.strmPath;
        if (!mediaPath) continue;
        checked += 1;
        const lookup: SubtitleLookup = {
          mediaType: item.mediaType === "tv" ? "tv" : "movie",
          title: item.title,
          year: item.year,
          tmdbId: item.tmdbId,
          tvdbId: item.tvdbId,
          imdbId: item.imdbId,
          season: item.season,
          episode: item.episode
        };
        try {
          const outcome = await ensureSubtitlesForMediaPath(mediaPath, lookup, settings);
          downloaded += outcome.downloaded;
          skipped += outcome.skipped;
        } catch (error) {
          skipped += 1;
          subtitleLog("warn", "subtitle backfill failed", {
            title: item.title,
            mediaPath: basename(mediaPath),
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return { checked, downloaded, skipped };
    });
    if (result) logger.info(result, "subtitle backfill completed");
    return result;
  } finally {
    setTaskNextRun(SUBTITLE_BACKFILL_TASK_ID, new Date(Date.now() + SUBTITLE_BACKFILL_INTERVAL_MS));
  }
}

export async function writeSubtitleFromText(mediaPath: string, language: string, content: string) {
  const tempPath = join(env.VFS_TMP_DIR, `subtitle-${randomUUID()}.tmp`);
  const targetPath = sidecarPathFor(mediaPath, language);
  await mkdir(dirname(targetPath), { recursive: true });
  await mkdir(dirname(tempPath), { recursive: true });
  await writeFile(tempPath, content, "utf8");
  const data = await readFile(tempPath, "utf8");
  await writeFile(targetPath, data, "utf8");
  await rm(tempPath, { force: true }).catch(() => undefined);
  return targetPath;
}
