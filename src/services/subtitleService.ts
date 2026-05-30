import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../repositories/db/prisma.js";
import { redis } from "../repositories/db/redis.js";
import { fetchMediaMetadata } from "../services/metadataService.js";
import { refreshPlexPath } from "../services/plexService.js";
import { getSettings, type AppSettings } from "../services/settings/settingsStore.js";
import { runTrackedTask, setTaskNextRun } from "../workers/tasks/taskRegistry.js";
import { SUBTITLE_BACKFILL_INTERVAL_MS, SUBTITLE_BACKFILL_TASK_ID } from "../workers/tasks/coreTasks.js";
import { runSubtitleDownloadMachine, type SubtitleLookup } from "../state-machines/subtitleDownloadMachine.js";
import { invalidateSubtitleLanguageCache, updateSubtitleLanguageCache } from "../services/media-library/subtitleLanguageCache.js";
import { LocalTtlCache } from "../services/cache/localTtlCache.js";
import { hydrateLegacyMediaFields } from "../services/media-library/normalizedMedia.js";
import { subtitleLanguagesForItem } from "../services/media-library/libraryQueries.js";
import {
  bestProviderCandidatesPerLanguage,
  bestSubtitlesPerLanguage,
  enabledSubtitleProviders,
  missingLanguagesForPath,
  normalizeProviderLanguage,
  normalizeSubtitleLanguages,
  sidecarPathFor,
  subtitleLog,
  subtitleProviderCacheKey,
  SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS
} from "../services/subtitles/subtitleUtils.js";
import {
  downloadOpenSubtitlesSubtitleText,
  downloadSubdlSubtitleText,
  searchOpenSubtitles,
  searchSubdlSubtitles,
  subtitleProviderCoolingDown
} from "../services/subtitles/subtitleProviderClients.js";

const subtitleRuns = new Map<string, Promise<{ downloaded: number; skipped: number }>>();
const subtitleProviderResultLocalCache = new LocalTtlCache<"hit" | "miss">();

const SUBTITLE_LIBRARY_RELATION_SELECT = {
  movie: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true, posterPath: true, backdropPath: true, releaseDate: true } },
  tvShow: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true, posterPath: true, backdropPath: true, firstAirDate: true } },
  seasonTarget: { select: { seasonNumber: true, title: true, overview: true, airDate: true, posterPath: true } },
  episodeTarget: { select: { seasonNumber: true, episodeNumber: true, title: true, overview: true, airDate: true, stillPath: true } }
} as const;

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
  return runSubtitleDownloadMachine({
    mediaPath,
    lookup: lookupInput,
    settingsOverride,
    handlers: {
      loadSettings: () => getSettings(),
      checkConfig: async (settings) => {
        const languages = normalizeSubtitleLanguages(settings.subtitleLanguages);
        if (!settings.subtitlesEnabled || languages.length === 0) {
          return { downloaded: 0, skipped: 0, reason: "not_configured" as const };
        }
        const providers = enabledSubtitleProviders(settings);
        if (providers.length === 0) {
          return { downloaded: 0, skipped: 0, reason: "not_configured" as const };
        }
        return null;
      },
      hydrateLookup: async (settings, lookup) => {
        const hydrated = await hydrateLookup(settings, lookup);
        return hydrated;
      },
      processProviders: async (settings, lookup) => {
        const languages = normalizeSubtitleLanguages(settings.subtitleLanguages);
        let missingLanguages = await missingLanguagesForPath(mediaPath, languages);
        if (missingLanguages.length === 0) return { downloaded: 0, skipped: languages.length, reason: "already_present" as const };
        const providers = enabledSubtitleProviders(settings);
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
            const cacheKey = subtitleProviderCacheKey(provider, lookup, language);
            const localCached = subtitleProviderResultLocalCache.get(cacheKey);
            const cached = localCached ?? await redis.get(cacheKey).catch(() => null);
            if (cached === "hit" || cached === "miss") {
              subtitleProviderResultLocalCache.set(cacheKey, cached, SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS * 1000);
            }
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
                const cacheKey = subtitleProviderCacheKey(provider, lookup, language);
                subtitleProviderResultLocalCache.set(cacheKey, "miss", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS * 1000);
                await redis.set(cacheKey, "miss", "EX", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS).catch(() => undefined);
                continue;
              }
              const subtitleText = await downloadSubdlSubtitleText(subtitle.url);
              const targetPath = sidecarPathFor(mediaPath, language);
              await mkdir(dirname(targetPath), { recursive: true });
              await writeFile(targetPath, subtitleText, "utf8");
              const cacheKey = subtitleProviderCacheKey(provider, lookup, language);
              subtitleProviderResultLocalCache.set(cacheKey, "hit", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS * 1000);
              await redis.set(cacheKey, "hit", "EX", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS).catch(() => undefined);
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
                const cacheKey = subtitleProviderCacheKey(provider, lookup, language);
                subtitleProviderResultLocalCache.set(cacheKey, "miss", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS * 1000);
                await redis.set(cacheKey, "miss", "EX", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS).catch(() => undefined);
                continue;
              }
              const subtitleText = await downloadOpenSubtitlesSubtitleText(settings, auth, subtitle.fileId);
              const targetPath = sidecarPathFor(mediaPath, language);
              await mkdir(dirname(targetPath), { recursive: true });
              await writeFile(targetPath, subtitleText, "utf8");
              const cacheKey = subtitleProviderCacheKey(provider, lookup, language);
              subtitleProviderResultLocalCache.set(cacheKey, "hit", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS * 1000);
              await redis.set(cacheKey, "hit", "EX", SUBTITLE_PROVIDER_RESULT_CACHE_SECONDS).catch(() => undefined);
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
    }
  });
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
        take: 500,
        select: {
          mediaType: true,
          title: true,
          year: true,
          tmdbId: true,
          tvdbId: true,
          imdbId: true,
          season: true,
          episode: true,
          symlinkPath: true,
          strmPath: true,
          updatedAt: true,
          ...SUBTITLE_LIBRARY_RELATION_SELECT
        }
      }).then((rows) => rows.map((row) => hydrateLegacyMediaFields(row) as typeof row & {
        title: string;
        year?: number | null;
        tmdbId?: string | null;
        tvdbId?: string | null;
        imdbId?: string | null;
        season?: number | null;
        episode?: number | null;
      }));
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
  const targetPath = sidecarPathFor(mediaPath, language);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  invalidateSubtitleLanguageCache(mediaPath);
  updateSubtitleLanguageCache(mediaPath, [language]);
  return targetPath;
}

function lookupFromLibraryItem(item: Awaited<ReturnType<typeof prisma.mediaLibraryItem.findUniqueOrThrow>>): SubtitleLookup {
  const hydrated = hydrateLegacyMediaFields(item);
  return {
    mediaType: hydrated.mediaType === "tv" ? "tv" : "movie",
    title: hydrated.title,
    year: hydrated.year,
    tmdbId: hydrated.tmdbId,
    tvdbId: hydrated.tvdbId,
    imdbId: hydrated.imdbId,
    season: hydrated.season,
    episode: hydrated.episode
  };
}

async function getSubtitleLibraryItem(id: string) {
  return prisma.mediaLibraryItem.findUniqueOrThrow({
    where: { id },
    include: SUBTITLE_LIBRARY_RELATION_SELECT
  });
}

export async function deleteLibraryItemSubtitle(id: string, language: string) {
  const item = await getSubtitleLibraryItem(id);
  const mediaPath = item.symlinkPath ?? item.strmPath ?? item.filePath;
  if (!mediaPath) throw new Error("library item has no media path");
  const normalized = language.trim().toUpperCase();
  if (!normalized) throw new Error("language is required");
  await rm(sidecarPathFor(mediaPath, normalized), { force: true });
  invalidateSubtitleLanguageCache(mediaPath);
  return {
    deleted: true,
    subtitleLanguages: await subtitleLanguagesForItem(item).catch(() => [])
  };
}

export async function refreshLibraryItemSubtitle(id: string, language?: string) {
  const item = await getSubtitleLibraryItem(id);
  const mediaPath = item.symlinkPath ?? item.strmPath ?? item.filePath;
  if (!mediaPath) throw new Error("library item has no media path");
  if (language?.trim()) {
    await rm(sidecarPathFor(mediaPath, language.trim().toUpperCase()), { force: true });
  }
  invalidateSubtitleLanguageCache(mediaPath);
  const result = await ensureSubtitlesForMediaPath(mediaPath, lookupFromLibraryItem(item));
  return {
    ...result,
    subtitleLanguages: await subtitleLanguagesForItem(item).catch(() => [])
  };
}
