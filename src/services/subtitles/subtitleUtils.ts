import { access, readdir } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { AppSettings } from "../settings/settingsStore.js";
import type { SubtitleLookup } from "../../state-machines/subtitleDownloadMachine.js";

export type SubdlSubtitle = {
  url?: string;
  lang?: string;
  season?: number;
  episode?: number;
};

export type OpenSubtitlesAuth = {
  baseUrl: string;
  token: string;
};

export type SubtitleCandidate = {
  language: string;
  url?: string;
  fileId?: number;
  season?: number;
  episode?: number;
};

export type EnabledSubtitleProvider = "subdl" | "opensubtitlescom";

export const SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS = 12 * 60 * 60;
export const OPENSUBTITLES_AUTH_CACHE_SECONDS = 10 * 60;
export const SUBTITLE_PROVIDER_COOLDOWN_SECONDS = 15 * 60;
export const DRAKKAR_OPENSUBTITLES_USER_AGENT = "Drakkar v0.3.0";

export function subtitleLog(level: "info" | "warn", message: string, fields: Record<string, unknown>) {
  const color = level === "warn" ? "\x1b[33m" : "\x1b[36m";
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}="${String(value).replace(/\s+/g, " ").trim()}"`)
    .join(" ");
  console[level](`\x1b[2m${new Date().toISOString()}\x1b[0m ${color}${level.toUpperCase().padEnd(5)}\x1b[0m ${message}${suffix ? ` \x1b[2m${suffix}\x1b[0m` : ""}`);
}

export function normalizeSubtitleLanguages(languages: string[]) {
  return [...new Set(
    languages
      .flatMap((language) => language.split(/[,\s]+/))
      .map((language) => language.trim().toUpperCase())
      .filter(Boolean)
  )];
}

export function normalizeProviderLanguage(language: string) {
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

export function stripImdbId(imdbId?: string | null) {
  if (!imdbId) return undefined;
  const cleaned = imdbId.toLowerCase().replace(/^tt/, "").replace(/^0+/, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

export function enabledSubtitleProviders(settings: AppSettings): EnabledSubtitleProvider[] {
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

export function subtitleLookupKey(lookup: SubtitleLookup) {
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

export function subtitleProviderCacheKey(provider: EnabledSubtitleProvider, lookup: SubtitleLookup, language: string) {
  return `subtitle:provider:${provider}:${subtitleLookupKey(lookup)}:${normalizeProviderLanguage(language).toUpperCase()}`;
}

export function subtitleProviderCooldownKey(provider: EnabledSubtitleProvider) {
  return `subtitle:provider-cooldown:${provider}`;
}

export function openSubtitlesAuthCacheKey(settings: AppSettings) {
  const apiKey = settings.subtitleProviders.opensubtitlescom.apiKey ?? "";
  const username = settings.subtitleProviders.opensubtitlescom.username ?? "";
  return `subtitle:opensubtitles:auth:${username}:${apiKey}`;
}

export function sidecarPathFor(mediaPath: string, language: string) {
  const extension = extname(mediaPath);
  const base = extension ? mediaPath.slice(0, -extension.length) : mediaPath;
  return `${base}.${language.toLowerCase()}.srt`;
}

export async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listSubtitleLanguagesForPath(mediaPath: string) {
  const directory = dirname(mediaPath);
  const extension = extname(mediaPath);
  const stem = extension ? basename(mediaPath, extension) : basename(mediaPath);
  const entries = await readdir(directory, { withFileTypes: true });
  const languages = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .flatMap((name) => {
      const match = name.match(new RegExp(`^${escapeRegExp(stem)}\\.([a-z0-9-]+)\\.(srt|ass|ssa|vtt|sub)$`, "i"));
      return match?.[1] ? [match[1].toUpperCase()] : [];
    });
  return [...new Set(languages)].sort();
}

export async function missingLanguagesForPath(mediaPath: string, languages: string[]) {
  const missing: string[] = [];
  for (const language of languages) {
    const subtitlePath = sidecarPathFor(mediaPath, language);
    if (!(await pathExists(subtitlePath))) missing.push(language);
  }
  return missing;
}

export function bestSubtitlesPerLanguage(
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

export function bestProviderCandidatesPerLanguage(
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
