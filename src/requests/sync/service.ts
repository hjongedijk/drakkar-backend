import type { MediaRequest, Prisma, RequestProvider } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { downloadNzb } from "../../indexers/nzbhydra/client.js";
import { refreshMediaLibrary } from "../../media-library/libraryService.js";
import { fetchSeasonEpisodes, fetchSeriesStructure } from "../../metadata/metadataService.js";
import { runSearch } from "../../search/searchService.js";
import { getSettings } from "../../settings/settingsStore.js";
import { addNzbFromPath } from "../../downloads/downloadService.js";
import { mediaIdentityKey } from "../../media-library/identity.js";
import { scoreRelease } from "../../quality/scoring.js";
import { ensureDefaultProfiles } from "../../quality/profileService.js";
import { createBlocklistItem, isReleaseBlocklisted } from "../../policies/policyService.js";
import { fetchSeerrRequests, testSeerrConnection, updateSeerrAvailable } from "../seerr/client.js";
import type { ExternalMediaRequest } from "../types.js";

const TV_ACTIVE_DOWNLOAD_STATUSES = ["queued", "fetching_nzb", "verifying", "prepared", "waiting_for_provider", "waiting_for_nzb", "downloading", "paused"];
const SEARCH_COOLDOWN_SECONDS = 300;

async function fetchProviderRequests(provider: RequestProvider) {
  return fetchSeerrRequests(provider);
}

async function updateProviderAvailable(provider: RequestProvider, externalId: string) {
  return updateSeerrAvailable(provider, externalId);
}

function jsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function requestStatusForDownloadStatus(status: string) {
  if (status === "available" || status === "completed") return "available";
  return "grabbed";
}

export async function testRequestProvider(providerId: string) {
  const provider = await prisma.requestProvider.findUniqueOrThrow({ where: { id: providerId } });
  return testSeerrConnection(provider);
}

export function listProviders() {
  return prisma.requestProvider.findMany({ orderBy: { name: "asc" } });
}

export function createProvider(input: {
  type: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  syncIntervalMinutes?: number;
  defaultMovieProfile?: string;
  defaultTvProfile?: string;
}) {
  return prisma.requestProvider.create({ data: { ...input, type: "seerr" } });
}

export function updateProvider(
  id: string,
  input: Partial<{
    type: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    enabled: boolean;
    syncIntervalMinutes: number;
    defaultMovieProfile: string;
    defaultTvProfile: string;
  }>
) {
  return prisma.requestProvider.update({ where: { id }, data: input });
}

export function deleteProvider(id: string) {
  return prisma.requestProvider.delete({ where: { id } });
}

export async function syncRequests(providerId?: string) {
  const providers = await prisma.requestProvider.findMany({
    where: { enabled: true, ...(providerId ? { id: providerId } : {}) }
  });
  const imported: MediaRequest[] = [];
  const providerResults: { providerId: string; providerName: string; imported: number; ok: boolean; error?: string }[] = [];

  for (const provider of providers) {
    let importedForProvider = 0;
    try {
      const requests = await fetchProviderRequests(provider);
      for (const request of requests) {
        const synced = await upsertRequest(provider, request);
        imported.push(synced);
        importedForProvider += 1;
        if (shouldAutoGrabSyncedRequest(synced)) {
          try {
            if (synced.mediaType === "tv") await grabMissingTvForRequest(synced.id);
            else await grabBestForRequest(synced.id);
          } catch (error) {
            await prisma.mediaRequest.update({
              where: { id: synced.id },
              data: { status: "auto_grab_failed" }
            }).catch(() => undefined);
            await prisma.requestProvider.update({
              where: { id: provider.id },
              data: { lastError: error instanceof Error ? error.message : "automatic request grab failed" }
            }).catch(() => undefined);
          }
        }
      }
      await prisma.requestProvider.update({ where: { id: provider.id }, data: { lastSyncAt: new Date(), lastError: null } });
      providerResults.push({ providerId: provider.id, providerName: provider.name, imported: importedForProvider, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown sync error";
      await prisma.requestProvider.update({
        where: { id: provider.id },
        data: { lastError: message }
      });
      providerResults.push({ providerId: provider.id, providerName: provider.name, imported: importedForProvider, ok: false, error: message });
    }
  }

  await refreshMediaLibrary().catch(() => undefined);
  return {
    imported: imported.length,
    requests: imported,
    providerResults,
    failedProviders: providerResults.filter((item) => !item.ok).length
  };
}

export async function recoverFailedRequestDownloads() {
  const requests = await prisma.mediaRequest.findMany({
    where: {
      downloadId: { not: null },
      status: { not: "available" }
    }
  });
  const recovered = [];
  for (const request of requests) {
    const download = request.downloadId ? await prisma.download.findUnique({ where: { id: request.downloadId } }) : null;
    if (!download) {
      await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "release_failed", downloadId: null } });
      recovered.push(await grabBestForRequest(request.id));
      continue;
    }
    if (download.status !== "failed") continue;
    await blocklistSelectedRelease(request, download.error ?? "download failed", "request-recovery");
    await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "release_failed", downloadId: null } });
    recovered.push(await grabBestForRequest(request.id));
  }
  await refreshMediaLibrary().catch(() => undefined);
  return { recovered: recovered.length, results: recovered };
}

export async function ensureMonitoredRequests() {
  const requests = await prisma.mediaRequest.findMany({
    where: {
      mediaType: "tv",
      status: { in: ["approved", "grabbed", "available", "release_failed", "no_release_found"] }
    }
  });

  const retried = [];
  for (const request of requests) {
    const monitor = await getRequestMonitor(request.id).catch(() => null);
    if (!monitor?.seasons.some((season) => season.missingCount > 0)) continue;
    const result = await grabMissingTvForRequest(request.id).catch(() => null);
    if (result) retried.push({ requestId: request.id, result });
  }

  if (retried.length > 0) await refreshMediaLibrary().catch(() => undefined);
  return { retried: retried.length, results: retried };
}

function statusFromExternal(externalStatus?: string | null) {
  if (externalStatus === "2") return "approved";
  if (externalStatus === "3") return "rejected";
  if (externalStatus === "4" || externalStatus === "5") return "available";
  return "pending";
}

function shouldAutoGrabSyncedRequest(request: MediaRequest) {
  return request.externalStatus === "2" && (request.mediaType === "tv" || !request.downloadId) && ["pending", "approved", "grabbed", "available", "no_release_found", "auto_grab_failed"].includes(request.status);
}

async function upsertRequest(provider: RequestProvider, request: ExternalMediaRequest) {
  const existing = await prisma.mediaRequest.findUnique({
    where: { providerId_externalId: { providerId: provider.id, externalId: request.externalId } }
  });
  const linkedDownload = existing?.downloadId ? await prisma.download.findUnique({ where: { id: existing.downloadId } }) : null;
  const hasLiveLinkedDownload = Boolean(linkedDownload);
  const nextStatus =
    request.externalStatus === "2" && hasLiveLinkedDownload
      ? existing?.status ?? "approved"
      : request.externalStatus === "2"
        ? "approved"
        : existing?.status ?? statusFromExternal(request.externalStatus);

  return prisma.mediaRequest.upsert({
    where: { providerId_externalId: { providerId: provider.id, externalId: request.externalId } },
    update: {
      title: request.title,
      year: request.year,
      tmdbId: request.tmdbId,
      tvdbId: request.tvdbId,
      imdbId: request.imdbId,
      seasons: jsonValue(request.seasons),
      episodes: jsonValue(request.episodes),
      requestedBy: request.requestedBy,
      requestedQuality: request.requestedQuality,
      externalStatus: request.externalStatus,
      status: nextStatus,
      ...(existing?.downloadId && !hasLiveLinkedDownload ? { downloadId: null } : {})
    },
    create: {
      providerId: provider.id,
      externalId: request.externalId,
      mediaType: request.mediaType,
      title: request.title,
      year: request.year,
      tmdbId: request.tmdbId,
      tvdbId: request.tvdbId,
      imdbId: request.imdbId,
      seasons: jsonValue(request.seasons),
      episodes: jsonValue(request.episodes),
      requestedBy: request.requestedBy,
      requestedQuality: request.requestedQuality,
      externalStatus: request.externalStatus,
      status: statusFromExternal(request.externalStatus)
    }
  });
}

export function listRequests() {
  return prisma.mediaRequest.findMany({ orderBy: { createdAt: "desc" }, include: { provider: true } });
}

export function getRequest(id: string) {
  return prisma.mediaRequest.findUniqueOrThrow({ where: { id }, include: { provider: true } });
}

export async function getRequestMonitor(id: string) {
  const request = await getRequest(id);
  const availableImports = await prisma.importItem.findMany({
    where: {
      mediaType: request.mediaType,
      symlinks: { some: { status: { not: "broken" } } }
    },
    include: { symlinks: true }
  });

  if (request.mediaType !== "tv") {
    return {
      request,
      structure: null,
      seasons: [],
      available: availableImports.length > 0
    };
  }

  const settings = await getSettings();
  const structure = await fetchSeriesStructure(settings, {
    mediaType: "tv",
    title: request.title,
    year: request.year,
    tmdbId: request.tmdbId,
    tvdbId: request.tvdbId,
    imdbId: request.imdbId
  });

  const requestedSeasonNumbers = requestedSeasons(request.seasons);
  const requestedEpisodes = requestedEpisodesBySeason(request.episodes);
  const activeDownloads = await prisma.download.findMany({
    where: {
      status: { in: TV_ACTIVE_DOWNLOAD_STATUSES },
      OR: titleSearchClauses(request.title)
    },
    select: { title: true }
  });

  const availableBySeason = new Map<number, Set<number>>();
  for (const item of availableImports) {
    const sameRequest = item.requestId === request.id;
    const sameTitle = mediaIdentityKey({
      mediaType: "tv",
      title: item.title,
      year: item.year,
      season: item.season,
      episode: item.episode
    }) === mediaIdentityKey({
      mediaType: "tv",
      title: request.title,
      year: request.year,
      season: item.season,
      episode: item.episode,
      tmdbId: request.tmdbId,
      tvdbId: request.tvdbId,
      imdbId: request.imdbId
    });
    if ((!sameRequest && !sameTitle) || item.season == null || item.episode == null) continue;
    const set = availableBySeason.get(item.season) ?? new Set<number>();
    set.add(item.episode);
    availableBySeason.set(item.season, set);
  }

  const downloadingBySeason = new Map<number, Set<number>>();
  for (const download of activeDownloads) {
    const seasonMatch = download.title.match(/\bS(\d{1,2})\b/i);
    if (!seasonMatch) continue;
    const seasonNumber = Number(seasonMatch[1]);
    const seasonEpisodes = downloadingBySeason.get(seasonNumber) ?? new Set<number>();
    const episode = episodeNumberFromTitle(download.title, seasonNumber);
    if (episode) seasonEpisodes.add(episode);
    downloadingBySeason.set(seasonNumber, seasonEpisodes);
  }

  const seasonDefs = structure?.seasons.length
    ? structure.seasons
    : requestedSeasonNumbers.map((seasonNumber) => ({
        seasonNumber,
        name: `Season ${String(seasonNumber).padStart(2, "0")}`,
        episodeCount: Math.max(...[...(requestedEpisodes.get(seasonNumber) ?? new Set<number>())], 0),
        airDate: undefined
      }));

  const seasons = await Promise.all(seasonDefs
    .filter((season) => season.seasonNumber > 0)
    .map(async (season) => {
      const monitoredEpisodes = requestedEpisodes.get(season.seasonNumber);
      const monitorWholeSeason = requestedSeasonNumbers.length === 0 || requestedSeasonNumbers.includes(season.seasonNumber);
      const episodeCount =
        season.episodeCount > 0
          ? season.episodeCount
          : monitoredEpisodes?.size ?? availableBySeason.get(season.seasonNumber)?.size ?? 0;
      const episodeMetadata = structure?.tmdbId
        ? await fetchSeasonEpisodes(settings, structure.tmdbId, season.seasonNumber).catch(() => [])
        : [];
      const episodeNameByNumber = new Map(episodeMetadata.map((episode) => [episode.episodeNumber, episode.name]));
      const episodes = Array.from({ length: episodeCount }, (_, index) => index + 1).map((episodeNumber) => {
        const monitored = monitorWholeSeason || monitoredEpisodes?.has(episodeNumber) || false;
        const available = availableBySeason.get(season.seasonNumber)?.has(episodeNumber) ?? false;
        const downloading = downloadingBySeason.get(season.seasonNumber)?.has(episodeNumber) ?? false;
        const status = available ? "available" : downloading ? "downloading" : monitored ? "missing_monitored" : "missing_unmonitored";
        return {
          episodeNumber,
          title: episodeNameByNumber.get(episodeNumber),
          monitored,
          available,
          downloading,
          status
        };
      });

      return {
        seasonNumber: season.seasonNumber,
        name: season.name,
        episodeCount,
        monitored: monitorWholeSeason || Boolean(monitoredEpisodes?.size),
        availableCount: episodes.filter((episode) => episode.available).length,
        missingCount: episodes.filter((episode) => episode.status === "missing_monitored").length,
        downloadingCount: episodes.filter((episode) => episode.downloading).length,
        episodes
      };
    }));

  return {
    request,
    structure,
    seasons
  };
}

export function setRequestStatus(id: string, status: string) {
  return prisma.mediaRequest.update({ where: { id }, data: { status } });
}

export async function searchForRequest(id: string) {
  const request = await getRequest(id);
  const season = firstRequestedSeason(request.seasons);
  const releases = await runSearch({
    kind: request.mediaType === "tv" && season ? "season" : request.mediaType === "tv" ? "tv" : "movie",
    query: request.title,
    imdbId: request.imdbId ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined,
    season
  });
  return { request, releases };
}

function firstRequestedSeason(value: Prisma.JsonValue | null | undefined) {
  return requestedSeasons(value)[0];
}

function requestedSeasons(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return [];
  const seasons = new Set<number>();
  for (const item of value) {
    if (typeof item === "number" && Number.isFinite(item)) {
      seasons.add(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const season = record.seasonNumber ?? record.season ?? record.number;
    if (typeof season === "number" && Number.isFinite(season)) seasons.add(season);
    if (typeof season === "string" && Number.isFinite(Number(season))) seasons.add(Number(season));
  }
  return [...seasons].sort((a, b) => a - b);
}

export async function rankReleasesForRequest(id: string) {
  const request = await getRequest(id);
  const settings = await getSettings();
  const configuredProfileId =
    request.selectedProfileId ??
    (request.mediaType === "tv" ? request.provider?.defaultTvProfile ?? settings.defaultTvProfile : request.provider?.defaultMovieProfile ?? settings.defaultMovieProfile);
  const profile = await resolveProfile(configuredProfileId, request.mediaType);
  const { releases } = await searchForRequest(id);
  const ranked = await Promise.all(
    releases.map(async (release) => ({
      release,
      decision: (await isReleaseBlocklisted(release))
        ? { ...scoreRelease(release, profile), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
        : scoreRelease(release, profile)
    }))
  );
  ranked.sort((a, b) => b.decision.score - a.decision.score);
  return { request, profile, releases: ranked };
}

export async function grabBestForRequest(id: string) {
  const request = await getRequest(id);
  const workingImport = await findWorkingImportForRequest(request);
  if (workingImport) {
    await prisma.mediaRequest.update({ where: { id }, data: { status: "available", downloadId: workingImport.downloadId } });
    await refreshMediaLibrary().catch(() => undefined);
    return { grabbed: false, reason: "a working library item already exists", import: workingImport };
  }
  const existingDownload = await existingActiveDownload(request.downloadId);
  if (existingDownload) return { grabbed: true, reason: "request already has an active download", download: existingDownload };
  const settings = await getSettings();
  const configuredProfileId =
    request.selectedProfileId ??
    (request.mediaType === "tv" ? request.provider?.defaultTvProfile ?? settings.defaultTvProfile : request.provider?.defaultMovieProfile ?? settings.defaultMovieProfile);
  const profile = await resolveProfile(configuredProfileId, request.mediaType);
  const { releases } = await searchForRequest(id);
  const scored = await Promise.all(
    releases.map(async (release) => ({
      release,
      decision: (await isReleaseBlocklisted(release))
        ? { ...scoreRelease(release, profile), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
        : scoreRelease(release, profile)
    }))
  );
  const ranked = scored.filter((item) => item.decision.accepted).sort((a, b) => b.decision.score - a.decision.score);

  if (ranked.length === 0) {
    await prisma.mediaRequest.update({ where: { id }, data: { status: "no_release_found" } });
    await refreshMediaLibrary().catch(() => undefined);
    return { grabbed: false, reason: "no acceptable release found", releases: ranked };
  }

  const rejected: string[] = [];
  for (const candidate of ranked) {
    let download: Awaited<ReturnType<typeof addNzbFromPath>>;
    try {
      const nzb = await downloadNzb(settings, candidate.release);
      download = await addNzbFromPath(nzb.primaryPath, candidate.release.title, {
        guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
        requestId: id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to fetch or import NZB";
      rejected.push(`${candidate.release.title}: ${message}`);
      await createBlocklistItem({
        guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
        title: candidate.release.title,
        reason: /duplicate/i.test(message) ? "duplicate_nzb" : "import_failed",
        source: "grab-validation",
        release: candidate.release
      }).catch(() => undefined);
      continue;
    }
    if (download.status === "failed") {
      rejected.push(`${candidate.release.title}: ${download.error ?? "failed before queueing"}`);
      await createBlocklistItem({
        guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
        title: candidate.release.title,
        reason: /duplicate/i.test(download.error ?? "") ? "duplicate_nzb" : "import_failed",
        source: "grab-validation",
        release: candidate.release
      }).catch(() => undefined);
      continue;
    }
    await prisma.mediaRequest.update({
      where: { id },
      data: { status: requestStatusForDownloadStatus(download.status), selectedRelease: jsonValue(candidate.release), downloadId: download.id }
    });
    await refreshMediaLibrary().catch(() => undefined);
    return { grabbed: true, release: candidate.release, decision: candidate.decision, download };
  }

  await prisma.mediaRequest.update({ where: { id }, data: { status: "no_release_found", downloadId: null } });
  await refreshMediaLibrary().catch(() => undefined);
  return { grabbed: false, reason: "all acceptable releases failed before queueing", rejected };
}

export async function grabMissingTvForRequest(id: string) {
  const request = await getRequest(id);
  if (request.mediaType !== "tv") return grabBestForRequest(id);
  const seasons = requestedSeasons(request.seasons);
  if (seasons.length === 0) return grabBestForRequest(id);
  const requestedEpisodes = requestedEpisodesBySeason(request.episodes);

  const results = [];
  for (const season of seasons) {
    if (await hasActiveSeasonPackDownload(request.title, season)) continue;
    const existingEpisodes = await existingEpisodesForSeason(request.id, request.title, season);
    const requestedSeasonEpisodes = requestedEpisodes.get(season);
    if (requestedSeasonEpisodes && requestedSeasonEpisodes.size > 0 && [...requestedSeasonEpisodes].every((episode) => existingEpisodes.has(episode))) continue;
    const result = await grabBestTvSeasonForRequest(request, season, existingEpisodes, requestedSeasonEpisodes);
    results.push({ season, result });
  }

  const availableCount = await prisma.importItem.count({ where: { requestId: request.id } });
  const activeCount = await prisma.download.count({
    where: {
      title: { contains: request.title.split(":")[0], mode: "insensitive" },
      status: { in: TV_ACTIVE_DOWNLOAD_STATUSES }
    }
  });
  await prisma.mediaRequest.update({
    where: { id: request.id },
    data: { status: availableCount > 0 ? "available" : activeCount > 0 ? "grabbed" : results.length > 0 ? "grabbed" : "no_release_found" }
  });
  await refreshMediaLibrary().catch(() => undefined);
  return { grabbed: results.some((item) => item.result.grabbed), seasons: results };
}

async function hasActiveSeasonPackDownload(title: string, season: number) {
  const seasonToken = `S${String(season).padStart(2, "0")}`;
  const downloads = await prisma.download.findMany({
    where: {
      title: { contains: seasonToken, mode: "insensitive" },
      status: { in: TV_ACTIVE_DOWNLOAD_STATUSES },
      OR: titleSearchClauses(title)
    },
    select: { title: true }
  });
  return downloads.some((download) => isSeasonPackTitle(download.title, season));
}

async function existingEpisodesForSeason(requestId: string, title: string, season: number) {
  const [imports, downloads] = await Promise.all([
    prisma.importItem.findMany({
      where: {
        mediaType: "tv",
        season,
        episode: { not: null },
        symlinks: { some: { status: { not: "broken" } } }
      },
      select: { requestId: true, title: true, year: true, season: true, episode: true, mediaType: true }
    }),
    prisma.download.findMany({
      where: {
        status: { in: TV_ACTIVE_DOWNLOAD_STATUSES },
        OR: titleSearchClauses(title)
      },
      select: { title: true }
    })
  ]);

  const episodes = new Set<number>();
  for (const item of imports) {
    const sameRequest = item.requestId === requestId;
    const sameTitle = mediaIdentityKey(item) === mediaIdentityKey({ mediaType: "tv", title, year: item.year, season, episode: item.episode });
    if ((sameRequest || sameTitle) && typeof item.episode === "number") episodes.add(item.episode);
  }
  for (const download of downloads) {
    const episode = episodeNumberFromTitle(download.title, season);
    if (episode) episodes.add(episode);
  }
  return episodes;
}

async function findWorkingImportForRequest(request: MediaRequest) {
  const candidates = await prisma.importItem.findMany({
    where: {
      mediaType: request.mediaType,
      year: request.year ?? undefined,
      season: null,
      episode: null,
      symlinks: { some: { status: { not: "broken" } } }
    },
    include: { symlinks: { orderBy: { updatedAt: "desc" } } }
  });
  const key = mediaIdentityKey({
    mediaType: request.mediaType,
    title: request.title,
    year: request.year,
    tmdbId: request.tmdbId,
    tvdbId: request.tvdbId,
    imdbId: request.imdbId
  });
  return candidates.find((item) => mediaIdentityKey(item) === key) ?? null;
}

async function grabBestTvSeasonForRequest(
  request: MediaRequest & { provider?: RequestProvider | null },
  season: number,
  existingEpisodes = new Set<number>(),
  requestedEpisodes?: Set<number>
) {
  if (await seasonSearchCoolingDown(request.id, season)) {
    return { grabbed: false, reason: "season search cooling down after recent unsuccessful attempt", queued: [], rejected: [] };
  }
  const settings = await getSettings();
  const configuredProfileId = request.selectedProfileId ?? request.provider?.defaultTvProfile ?? settings.defaultTvProfile;
  const profile = await resolveProfile(configuredProfileId, request.mediaType);
  const seriesStructure = await fetchSeriesStructure(settings, {
    mediaType: "tv",
    title: request.title,
    year: request.year,
    tmdbId: request.tmdbId,
    tvdbId: request.tvdbId,
    imdbId: request.imdbId
  }).catch(() => undefined);
  const seasonEpisodeCount = seriesStructure?.seasons.find((item) => item.seasonNumber === season)?.episodeCount;
  const releases = await runSearch({
    kind: "season",
    query: request.title,
    imdbId: request.imdbId ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined,
    season
  });
  const scored = await Promise.all(
    releases.map(async (release) => ({
      release,
      decision: (await isReleaseBlocklisted(release))
        ? { ...scoreRelease(release, profile), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
        : scoreRelease(release, profile)
    }))
  );
  const seasonToken = `S${String(season).padStart(2, "0")}`;
  const accepted = scored.filter((item) => item.decision.accepted).sort((a, b) => b.decision.score - a.decision.score);
  const seasonPacks = existingEpisodes.size === 0 && (!requestedEpisodes || requestedEpisodes.size === 0)
    ? accepted.filter((item) => new RegExp(`\\b${seasonToken}\\b`, "i").test(item.release.title) && isSeasonPackTitle(item.release.title, season))
    : [];
  const queued = [];
  const rejected: string[] = [];

  for (const candidate of seasonPacks) {
    const result = await queueReleaseForRequest(request.id, candidate);
    if (result.grabbed) {
      queued.push(result);
      return { grabbed: true, mode: "season_pack", queued, rejected };
    }
    rejected.push(`${candidate.release.title}: ${result.reason ?? "failed before queueing"}`);
  }

  const episodeCandidates = bestEpisodeCandidates(accepted, season, existingEpisodes, requestedEpisodes);
  const separatelySearchedEpisodes = episodeCandidates.length > 0 ? [] : await searchEpisodesForSeason(request, season, profile, existingEpisodes, requestedEpisodes, seasonEpisodeCount);
  const fallbackEpisodeCandidates = episodeCandidates.length > 0 ? episodeCandidates : separatelySearchedEpisodes;
  for (const candidate of fallbackEpisodeCandidates) {
    const result = await queueReleaseForRequest(request.id, candidate);
    if (result.grabbed) queued.push(result);
    else rejected.push(`${candidate.release.title}: ${result.reason ?? "failed before queueing"}`);
  }

  if (queued.length > 0) return { grabbed: true, mode: seasonPacks.length > 0 ? "episodes_after_season_pack_failure" : "episodes", queued, rejected };
  await markSeasonSearchCooldown(request.id, season);
  return {
    grabbed: false,
    reason: seasonPacks.length > 0
      ? "all season packs and episode releases failed before queueing"
      : "no acceptable season or episode release found",
    queued,
    rejected
  };
}

function bestEpisodeCandidates<T extends { release: { title: string }; decision: { score: number } }>(
  items: T[],
  season: number,
  existingEpisodes = new Set<number>(),
  requestedEpisodes?: Set<number>
) {
  const byEpisode = new Map<number, T>();
  const seasonPart = String(season).padStart(2, "0");
  for (const item of items) {
    const match = item.release.title.match(new RegExp(`\\bS${seasonPart}E(\\d{1,3})\\b`, "i"));
    if (!match) continue;
    const episode = Number(match[1]);
    if (existingEpisodes.has(episode)) continue;
    if (requestedEpisodes && requestedEpisodes.size > 0 && !requestedEpisodes.has(episode)) continue;
    const existing = byEpisode.get(episode);
    if (!existing || item.decision.score > existing.decision.score) byEpisode.set(episode, item);
  }
  return [...byEpisode.entries()]
    .sort(([episodeA], [episodeB]) => episodeA - episodeB)
    .map(([, item]) => item);
}

async function searchEpisodesForSeason(
  request: MediaRequest & { provider?: RequestProvider | null },
  season: number,
  profile: Awaited<ReturnType<typeof resolveProfile>>,
  existingEpisodes = new Set<number>(),
  requestedEpisodes?: Set<number>,
  seasonEpisodeCount?: number
) {
  const targets = requestedEpisodes && requestedEpisodes.size > 0
    ? [...requestedEpisodes].filter((episode) => !existingEpisodes.has(episode))
    : Array.from({ length: Math.max(0, seasonEpisodeCount ?? 0) }, (_, index) => index + 1).filter((episode) => !existingEpisodes.has(episode));
  if (targets.length === 0) return [];

  const perEpisode = await Promise.all(
    targets.map(async (episode) => {
      const releases = await runSearch({
        kind: "episode",
        query: request.title,
        imdbId: request.imdbId ?? undefined,
        tmdbId: request.tmdbId ?? undefined,
        tvdbId: request.tvdbId ?? undefined,
        season,
        episode
      });
      const scored = await Promise.all(
        releases.map(async (release) => ({
          release,
          decision: (await isReleaseBlocklisted(release))
            ? { ...scoreRelease(release, profile), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
            : scoreRelease(release, profile)
        }))
      );
      return scored
        .filter((item) => item.decision.accepted)
        .sort((a, b) => b.decision.score - a.decision.score)[0];
    })
  );

  return perEpisode.filter((item): item is NonNullable<(typeof perEpisode)[number]> => Boolean(item));
}

function requestedEpisodesBySeason(value: Prisma.JsonValue | null | undefined) {
  const bySeason = new Map<number, Set<number>>();
  if (!Array.isArray(value)) return bySeason;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const season = numberField(record.seasonNumber ?? record.season ?? record.season_number);
    const episode = numberField(record.episodeNumber ?? record.episode ?? record.episode_number);
    if (!season || !episode) continue;
    const episodes = bySeason.get(season) ?? new Set<number>();
    episodes.add(episode);
    bySeason.set(season, episodes);
  }
  return bySeason;
}

function numberField(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function titleSearchClauses(title: string) {
  const baseTitle = title.split(":")[0] ?? title;
  return [
    { title: { contains: baseTitle, mode: "insensitive" as const } },
    { title: { contains: baseTitle.replaceAll(" ", "."), mode: "insensitive" as const } }
  ];
}

function isSeasonPackTitle(title: string, season: number) {
  const seasonToken = `S${String(season).padStart(2, "0")}`;
  return new RegExp(`\\b${seasonToken}\\b`, "i").test(title) && !/\bS\d{1,2}E\d{1,3}\b/i.test(title);
}

function episodeNumberFromTitle(title: string, season: number) {
  const seasonPart = String(season).padStart(2, "0");
  const match = title.match(new RegExp(`\\bS${seasonPart}E(\\d{1,3})\\b`, "i"));
  return match ? Number(match[1]) : undefined;
}

function seasonCooldownKey(requestId: string, season: number) {
  return `request:season-search-cooldown:${requestId}:${season}`;
}

async function seasonSearchCoolingDown(requestId: string, season: number) {
  return Boolean(await redis.get(seasonCooldownKey(requestId, season)));
}

async function markSeasonSearchCooldown(requestId: string, season: number) {
  await redis.set(seasonCooldownKey(requestId, season), "1", "EX", SEARCH_COOLDOWN_SECONDS);
}

async function queueReleaseForRequest(
  requestId: string,
  candidate: { release: Parameters<typeof scoreRelease>[0]; decision: ReturnType<typeof scoreRelease> }
) {
  const settings = await getSettings();
  let download: Awaited<ReturnType<typeof addNzbFromPath>>;
  try {
    const nzb = await downloadNzb(settings, candidate.release);
    download = await addNzbFromPath(nzb.primaryPath, candidate.release.title, {
      guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
      requestId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to fetch or import NZB";
    await createBlocklistItem({
      guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
      title: candidate.release.title,
      reason: /duplicate/i.test(message) ? "duplicate_nzb" : "import_failed",
      source: "grab-validation",
      release: candidate.release
    }).catch(() => undefined);
    return { grabbed: false, reason: message };
  }
  if (download.status === "failed") {
    await createBlocklistItem({
      guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
      title: candidate.release.title,
      reason: /duplicate/i.test(download.error ?? "") ? "duplicate_nzb" : "import_failed",
      source: "grab-validation",
      release: candidate.release
    }).catch(() => undefined);
    return { grabbed: false, reason: download.error ?? "failed before queueing", download };
  }
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: { status: requestStatusForDownloadStatus(download.status), selectedRelease: jsonValue(candidate.release), downloadId: download.id }
  });
  await refreshMediaLibrary().catch(() => undefined);
  return { grabbed: true, release: candidate.release, decision: candidate.decision, download };
}

export async function grabReleaseForRequest(id: string, release: unknown) {
  const request = await getRequest(id);
  const existingDownload = await existingActiveDownload(request.downloadId);
  if (existingDownload) return { grabbed: true, reason: "request already has an active download", download: existingDownload };
  const settings = await getSettings();
  const configuredProfileId =
    request.selectedProfileId ??
    (request.mediaType === "tv" ? request.provider?.defaultTvProfile ?? settings.defaultTvProfile : request.provider?.defaultMovieProfile ?? settings.defaultMovieProfile);
  const profile = await resolveProfile(configuredProfileId, request.mediaType);
  const typedRelease = release as Parameters<typeof scoreRelease>[0];
  if (await isReleaseBlocklisted(typedRelease)) {
    await prisma.mediaRequest.update({
      where: { id },
      data: { status: "blocklisted_release", selectedRelease: jsonValue(typedRelease) }
    });
    return { grabbed: false, reason: "release is blocklisted", release: typedRelease };
  }
  const decision = scoreRelease(typedRelease, profile);
  if (!decision.accepted) {
    await prisma.mediaRequest.update({
      where: { id },
      data: { status: "rejected_release", selectedRelease: jsonValue(typedRelease) }
    });
    return { grabbed: false, reason: "release rejected by quality profile", decision, release: typedRelease };
  }

  const nzb = await downloadNzb(settings, typedRelease);
  const download = await addNzbFromPath(nzb.primaryPath, typedRelease.title, {
    guid: typedRelease.guid ? String(typedRelease.guid) : undefined,
    requestId: id
  });
  if (download.status === "failed") {
    await createBlocklistItem({
      guid: typedRelease.guid ? String(typedRelease.guid) : undefined,
      title: typedRelease.title,
      reason: /duplicate/i.test(download.error ?? "") ? "duplicate_nzb" : "import_failed",
      source: "manual-grab-validation",
      release: typedRelease
    }).catch(() => undefined);
    await prisma.mediaRequest.update({
      where: { id },
      data: { status: "release_failed", selectedRelease: jsonValue(typedRelease), downloadId: null }
    });
    const next = await grabBestForRequest(id);
    return {
      grabbed: next.grabbed,
      reason: "selected release failed before queueing; blocklisted and searched for a replacement",
      release: typedRelease,
      replacement: next
    };
  }
  await prisma.mediaRequest.update({
    where: { id },
    data: { status: requestStatusForDownloadStatus(download.status), selectedRelease: jsonValue(typedRelease), downloadId: download.id }
  });
  await refreshMediaLibrary().catch(() => undefined);
  return { grabbed: true, release: typedRelease, decision, download };
}

async function blocklistSelectedRelease(request: MediaRequest, reason: string, source: string) {
  if (!request.selectedRelease || typeof request.selectedRelease !== "object") return;
  const release = request.selectedRelease as Record<string, unknown>;
  const title = typeof release.title === "string" ? release.title : request.title;
  const guid = release.guid === undefined || release.guid === null ? undefined : String(release.guid);
  await createBlocklistItem({
    guid,
    title,
    reason: /duplicate/i.test(reason) ? "duplicate_nzb" : /missing|article|stat/i.test(reason) ? "missing_articles" : "import_failed",
    source,
    release: request.selectedRelease
  }).catch(() => undefined);
}

async function existingActiveDownload(downloadId?: string | null) {
  if (!downloadId) return null;
  const download = await prisma.download.findUnique({ where: { id: downloadId } });
  if (!download) return null;
  return ["queued", "fetching_nzb", "verifying", "prepared", "waiting_for_provider", "waiting_for_nzb", "downloading", "paused"].includes(download.status)
    ? download
    : null;
}

export async function refreshRequest(id: string) {
  const request = await getRequest(id);
  if (!request.provider) return request;
  const requests = await fetchProviderRequests(request.provider);
  const matched = requests.find((item) => item.externalId === request.externalId);
  if (!matched) return request;
  const refreshed = await upsertRequest(request.provider, matched);
  await refreshMediaLibrary().catch(() => undefined);
  return refreshed;
}

export async function markRequestAvailable(id: string) {
  const request = await getRequest(id);
  if (!request.provider) throw new Error("request has no provider");
  return updateProviderAvailable(request.provider, request.externalId);
}

async function resolveProfile(profileId: string | null | undefined, mediaType: string) {
  await ensureDefaultProfiles();
  if (profileId) {
    const direct = await prisma.qualityProfile.findUnique({ where: { id: profileId } });
    if (direct) return direct;

    const byName = await prisma.qualityProfile.findFirst({ where: { name: { equals: profileId, mode: "insensitive" } } });
    if (byName) return byName;
  }

  const fallbackNames = mediaType === "tv" ? ["TV Standard", "HD 1080p", "Any"] : ["Movie Standard", "HD 1080p", "Any"];
  for (const name of fallbackNames) {
    const profile = await prisma.qualityProfile.findUnique({ where: { name } });
    if (profile) return profile;
  }
  throw new Error("request has no usable quality profile");
}
