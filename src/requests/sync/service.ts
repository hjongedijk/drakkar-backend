import type { MediaRequest, Prisma, RequestProvider } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { downloadNzb, refreshNzbhydraUpdateFeeds } from "../../indexers/nzbhydra/client.js";
import { refreshMediaLibrary } from "../../media-library/libraryService.js";
import { fetchSeasonEpisodes, fetchSeriesStructure } from "../../metadata/metadataService.js";
import { runSearch } from "../../search/searchService.js";
import { getSettings } from "../../settings/settingsStore.js";
import { addNzbFromPath, findReusableDownload } from "../../downloads/downloadService.js";
import { mediaIdentityKey, normalizeTitleForIdentity } from "../../media-library/identity.js";
import { scoreRelease } from "../../quality/scoring.js";
import { ensureDefaultProfiles } from "../../quality/profileService.js";
import { createBlocklistItem, isReleaseBlocklisted } from "../../policies/policyService.js";
import { createSeerrRequest, fetchSeerrRequests, testSeerrConnection, updateSeerrAvailable } from "../seerr/client.js";
import type { ExternalMediaRequest } from "../types.js";

const TV_ACTIVE_DOWNLOAD_STATUSES = ["queued", "fetching_nzb", "verifying", "prepared", "waiting_for_provider", "waiting_for_nzb", "downloading", "paused"];
const SEARCH_COOLDOWN_SECONDS = 300;
const REQUEST_RELEASE_CACHE_SECONDS = 6 * 60 * 60;
const MONITOR_QUEUE_SEED_STATUSES = ["queued", "fetching_nzb", "verifying", "waiting_for_provider", "waiting_for_nzb", "downloading", "paused"];
const TV_SEASONS_PER_MONITOR_PASS = 8;
const TV_EPISODE_DOWNLOADS_PER_REQUEST_PASS = 4;

function blockReasonFromFailure(message?: string | null) {
  const normalized = (message ?? "").toLowerCase();
  if (/duplicate|already exists/.test(normalized)) return "duplicate_nzb";
  if (/430 no such article|no such article|article.*not found|missing article|missing segment|segment download failed|required usenet articles|provider.*missing/.test(normalized)) return "missing_articles";
  if (/password|encrypted/.test(normalized)) return "passworded_archive";
  if (/unsupported archive|rar nzb would require|full disk materialization|archive.*refus|archive extraction|materialization/.test(normalized)) return "unsupported_archive";
  if (/no streamable video|no eligible files|no importable media|contains no streamable video/.test(normalized)) return "no_video_content";
  return "import_failed";
}

function isAiredDate(value?: string | null) {
  if (!value) return true;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp <= Date.now() + 12 * 60 * 60 * 1000;
}

function intersectEpisodes(left: Set<number>, right: Set<number>) {
  return new Set([...left].filter((episode) => right.has(episode)));
}

async function fetchProviderRequests(provider: RequestProvider) {
  return fetchSeerrRequests(provider);
}

type SyncRequestAction = "created" | "updated" | "skipped";

type SyncProviderResult = {
  providerId: string;
  providerName: string;
  fetched: number;
  imported: number;
  updated: number;
  skipped: number;
  ok: boolean;
  error?: string;
};

async function reuseExistingReleaseDownload(requestId: string, release: { guid?: unknown; title: string }) {
  const reusable = await findReusableDownload({
    guid: release.guid === undefined || release.guid === null ? undefined : String(release.guid),
    title: release.title
  });
  if (!reusable) return null;
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status: requestStatusForDownloadStatus(reusable.status),
      selectedRelease: jsonValue(release),
      downloadId: reusable.id
    }
  });
  await refreshMediaLibrary().catch(() => undefined);
  return reusable;
}

async function updateProviderAvailable(provider: RequestProvider, externalId: string) {
  return updateSeerrAvailable(provider, externalId);
}

async function enrichTvRequestWithStructure(request: ExternalMediaRequest) {
  if (request.mediaType !== "tv") return request;
  const settings = await getSettings();
  const structure = await fetchSeriesStructure(settings, {
    mediaType: "tv",
    title: request.title,
    year: request.year,
    tmdbId: request.tmdbId,
    tvdbId: request.tvdbId,
    imdbId: request.imdbId
  }).catch(() => undefined);
  if (!structure) return request;

  const requestedSeasonNumbers = requestedSeasons(request.seasons as Prisma.JsonValue | null | undefined);
  const enrichedSeasons =
    requestedSeasonNumbers.length > 0
      ? requestedSeasonNumbers.map((seasonNumber) => {
          const match = structure.seasons.find((season) => season.seasonNumber === seasonNumber);
          return {
            seasonNumber,
            name: match?.name ?? `Season ${String(seasonNumber).padStart(2, "0")}`,
            episodeCount: match?.episodeCount ?? 0,
            airDate: match?.airDate
          };
        })
      : structure.seasons
          .filter((season) => season.seasonNumber > 0)
          .map((season) => ({
            seasonNumber: season.seasonNumber,
            name: season.name ?? `Season ${String(season.seasonNumber).padStart(2, "0")}`,
            episodeCount: season.episodeCount,
            airDate: season.airDate
          }));

  return {
    ...request,
    seasons: enrichedSeasons,
    episodes: request.episodes ?? undefined
  };
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
  const providerResults: SyncProviderResult[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const provider of providers) {
    let fetchedForProvider = 0;
    let importedForProvider = 0;
    let updatedForProvider = 0;
    let skippedForProvider = 0;
    try {
      const requests = await fetchProviderRequests(provider);
      fetchedForProvider = requests.length;
      const syncedRequests: MediaRequest[] = [];
      for (const request of requests) {
        const hydrated = await enrichTvRequestWithStructure(request);
        const { request: synced, action } = await upsertRequest(provider, hydrated);
        imported.push(synced);
        syncedRequests.push(synced);
        if (action === "created") {
          importedForProvider += 1;
          createdCount += 1;
        } else if (action === "updated") {
          updatedForProvider += 1;
          updatedCount += 1;
        } else {
          skippedForProvider += 1;
          skippedCount += 1;
        }
      }
      await prisma.requestProvider.update({ where: { id: provider.id }, data: { lastSyncAt: new Date(), lastError: null } });
      providerResults.push({
        providerId: provider.id,
        providerName: provider.name,
        fetched: fetchedForProvider,
        imported: importedForProvider,
        updated: updatedForProvider,
        skipped: skippedForProvider,
        ok: true
      });

      const autoGrabCandidates = [];
      for (const synced of syncedRequests) {
        if (await shouldAutoGrabSyncedRequest(synced)) autoGrabCandidates.push(synced);
      }
      if (autoGrabCandidates.length > 0) {
        await refreshNzbhydraUpdateFeeds(await getSettings()).catch(() => undefined);
      }
      for (const synced of autoGrabCandidates) {
        try {
          if (synced.mediaType === "tv") await grabMissingTvForRequest(synced.id);
          else await grabBestForRequest(synced.id);
        } catch (error) {
          await prisma.mediaRequest.update({
            where: { id: synced.id },
            data: { status: "approved", downloadId: null }
          }).catch(() => undefined);
          await prisma.requestProvider.update({
            where: { id: provider.id },
            data: { lastError: error instanceof Error ? error.message : "automatic request grab failed" }
          }).catch(() => undefined);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown sync error";
      await prisma.requestProvider.update({
        where: { id: provider.id },
        data: { lastError: message }
      });
      providerResults.push({
        providerId: provider.id,
        providerName: provider.name,
        fetched: fetchedForProvider,
        imported: importedForProvider,
        updated: updatedForProvider,
        skipped: skippedForProvider,
        ok: false,
        error: message
      });
    }
  }

  await refreshMediaLibrary().catch(() => undefined);
  return {
    imported: createdCount,
    updated: updatedCount,
    skipped: skippedCount,
    fetched: createdCount + updatedCount + skippedCount,
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
      recovered.push(await grabForRequestMediaType(request.id, request.mediaType));
      continue;
    }
    if (download.status !== "failed") continue;
    await blocklistSelectedRelease(request, download.error ?? "download failed", "request-recovery");
    await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "release_failed", downloadId: null } });
    recovered.push(await grabForRequestMediaType(request.id, request.mediaType));
  }
  await refreshMediaLibrary().catch(() => undefined);
  return { recovered: recovered.length, results: recovered };
}

async function grabForRequestMediaType(id: string, mediaType: string) {
  return mediaType === "tv" ? grabMissingTvForRequest(id) : grabBestForRequest(id);
}

async function monitoredQueuePendingCount() {
  return prisma.download.count({
    where: {
      status: { in: MONITOR_QUEUE_SEED_STATUSES }
    }
  });
}

export async function ensureMonitoredRequests() {
  const settings = await getSettings();
  const queueSeedTarget = Math.max(1, settings.monitorQueueSeedTarget);
  let pendingQueueItems = await monitoredQueuePendingCount();
  const requests = await prisma.mediaRequest.findMany({
    where: {
      status: { in: ["approved", "grabbed", "available", "release_failed", "no_release_found", "auto_grab_failed"] }
    },
    orderBy: [{ status: "asc" }, { updatedAt: "asc" }]
  });

  const retried = [];
  let skippedBecauseQueueFull = 0;
  for (const request of requests) {
    if (request.mediaType === "tv") {
      const availability = await tvRequestAvailabilitySummary(request).catch(() => null);
      if (!availability) continue;
      const hasMissingEpisodes = availability.hasMissingEpisodes;
      const hasAvailableEpisodes = availability.hasAvailableEpisodes;
      const activeDownload = await existingActiveDownload(request.downloadId).catch(() => null);
      const linkedDownload = request.downloadId
        ? await prisma.download.findUnique({ where: { id: request.downloadId }, select: { status: true } }).catch(() => null)
        : null;
      const clearDeadDownloadId = Boolean(linkedDownload && ["failed", "cancelled", "replaced"].includes(linkedDownload.status));
      const desiredStatus = hasMissingEpisodes
        ? activeDownload
          ? "grabbed"
          : "approved"
        : hasAvailableEpisodes
          ? "available"
          : request.status;
      if (desiredStatus !== request.status || clearDeadDownloadId) {
        await prisma.mediaRequest.update({
          where: { id: request.id },
          data: {
            status: desiredStatus,
            ...(activeDownload ? {} : { downloadId: hasMissingEpisodes || clearDeadDownloadId ? null : request.downloadId })
          }
        }).catch(() => undefined);
      }
      if (!hasMissingEpisodes) continue;
      if (pendingQueueItems >= queueSeedTarget) {
        skippedBecauseQueueFull += 1;
        continue;
      }
      const result = await grabMissingTvForRequest(request.id).catch(() => null);
      if (result) {
        retried.push({ requestId: request.id, result });
        await prisma.mediaRequest.update({ where: { id: request.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
      }
      pendingQueueItems = await monitoredQueuePendingCount();
      continue;
    }

    const workingImport = await findWorkingImportForRequest(request).catch(() => null);
    const activeDownload = await existingActiveDownload(request.downloadId).catch(() => null);
    if (workingImport || activeDownload) continue;
    if (pendingQueueItems >= queueSeedTarget) {
      skippedBecauseQueueFull += 1;
      continue;
    }
    const result = await grabBestForRequest(request.id).catch(() => null);
    if (result) {
      retried.push({ requestId: request.id, result });
      await prisma.mediaRequest.update({ where: { id: request.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
    }
    pendingQueueItems = await monitoredQueuePendingCount();
  }

  if (retried.length > 0) await refreshMediaLibrary().catch(() => undefined);
  return { retried: retried.length, queueSeedTarget, pendingQueueItems, skippedBecauseQueueFull, results: retried };
}

async function tvRequestAvailabilitySummary(request: MediaRequest) {
  const seasons = requestedSeasons(request.seasons);
  if (seasons.length === 0) {
    const available = await prisma.importItem.count({ where: { requestId: request.id, mediaType: "tv" } });
    return { hasMissingEpisodes: available === 0, hasAvailableEpisodes: available > 0 };
  }
  const requestedEpisodes = requestedEpisodesBySeason(request.episodes);
  const seasonEpisodeCounts = new Map(
    Array.isArray(request.seasons)
      ? request.seasons.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const record = item as Record<string, unknown>;
          const seasonNumber = numberField(record.seasonNumber ?? record.season ?? record.number);
          const episodeCount = numberField(record.episodeCount ?? record.episodesCount ?? record.totalEpisodes);
          return seasonNumber ? [[seasonNumber, episodeCount ?? 0] as const] : [];
        })
      : []
  );

  let hasMissingEpisodes = false;
  let hasAvailableEpisodes = false;
  for (const season of seasons) {
    const existingEpisodes = await existingEpisodesForSeason(request.id, request.title, season);
    hasAvailableEpisodes ||= existingEpisodes.size > 0;
    const requestedSeasonEpisodes = requestedEpisodes.get(season);
    if (requestedSeasonEpisodes && requestedSeasonEpisodes.size > 0) {
      if ([...requestedSeasonEpisodes].some((episode) => !existingEpisodes.has(episode))) hasMissingEpisodes = true;
      continue;
    }
    const knownEpisodeCount = seasonEpisodeCounts.get(season) ?? 0;
    if (knownEpisodeCount === 0 || existingEpisodes.size < knownEpisodeCount) hasMissingEpisodes = true;
  }
  return { hasMissingEpisodes, hasAvailableEpisodes };
}

function statusFromExternal(externalStatus?: string | null, mediaType?: string) {
  if (externalStatus === "2") return "approved";
  if (externalStatus === "3") return "rejected";
  if (externalStatus === "4" || externalStatus === "5") return mediaType === "tv" ? "approved" : "available";
  return "pending";
}

async function shouldAutoGrabSyncedRequest(request: MediaRequest) {
  if (request.externalStatus !== "2") return false;
  if (!["pending", "approved", "grabbed", "no_release_found", "auto_grab_failed", "release_failed"].includes(request.status)) return false;
  const activeDownload = await existingActiveDownload(request.downloadId).catch(() => null);
  if (activeDownload) return false;
  if (request.mediaType !== "tv") {
    return !(await findWorkingImportForRequest(request).catch(() => null));
  }
  const monitor = await getRequestMonitor(request.id).catch(() => null);
  if (!monitor) return true;
  return monitor.seasons.some((season) => season.missingCount > 0);
}

function normalizeJson(value: unknown) {
  return value === undefined ? undefined : JSON.stringify(value);
}

function requestNeedsUpdate(existing: MediaRequest, next: ExternalMediaRequest, nextStatus: string, clearDownloadId: boolean) {
  return (
    existing.title !== next.title ||
    existing.year !== next.year ||
    existing.tmdbId !== next.tmdbId ||
    existing.tvdbId !== next.tvdbId ||
    existing.imdbId !== next.imdbId ||
    existing.requestedBy !== next.requestedBy ||
    existing.requestedQuality !== next.requestedQuality ||
    existing.externalStatus !== next.externalStatus ||
    existing.status !== nextStatus ||
    normalizeJson(existing.seasons) !== normalizeJson(next.seasons) ||
    normalizeJson(existing.episodes) !== normalizeJson(next.episodes) ||
    clearDownloadId
  );
}

async function upsertRequest(provider: RequestProvider, request: ExternalMediaRequest): Promise<{ request: MediaRequest; action: SyncRequestAction }> {
  const existing = await prisma.mediaRequest.findUnique({
    where: { providerId_externalId: { providerId: provider.id, externalId: request.externalId } }
  });
  const linkedDownload = existing?.downloadId ? await prisma.download.findUnique({ where: { id: existing.downloadId } }) : null;
  const hasLiveLinkedDownload = Boolean(linkedDownload);
  const clearDownloadId = Boolean(existing?.downloadId && !hasLiveLinkedDownload);
  const nextStatus =
    request.externalStatus === "2" && hasLiveLinkedDownload
      ? existing?.status ?? "approved"
      : request.externalStatus === "2"
        ? "approved"
        : existing?.status ?? statusFromExternal(request.externalStatus, request.mediaType);

  if (existing && !requestNeedsUpdate(existing, request, nextStatus, clearDownloadId)) {
    return { request: existing, action: "skipped" };
  }

  const synced = await prisma.mediaRequest.upsert({
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
      ...(clearDownloadId ? { downloadId: null } : {})
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
      status: statusFromExternal(request.externalStatus, request.mediaType)
    }
  });

  return { request: synced, action: existing ? "updated" : "created" };
}

export async function listRequests() {
  const requests = await prisma.mediaRequest.findMany({ orderBy: { createdAt: "desc" }, include: { provider: true } });
  const downloadIds = [...new Set(requests.map((request) => request.downloadId).filter((id): id is string => Boolean(id)))];
  const downloads = downloadIds.length > 0
    ? await prisma.download.findMany({ where: { id: { in: downloadIds } }, select: { id: true, status: true } })
    : [];
  const byId = new Map(downloads.map((download) => [download.id, download]));
  return requests.map((request) => ({
    ...request,
    download: request.downloadId ? byId.get(request.downloadId) ?? null : null
  }));
}

export function getRequest(id: string) {
  return prisma.mediaRequest.findUniqueOrThrow({ where: { id }, include: { provider: true } });
}

export async function createManualRequest(input: {
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
}) {
  const provider = await prisma.requestProvider.findFirst({ where: { type: "seerr", enabled: true }, orderBy: { createdAt: "asc" } });
  const externalResult = provider && input.tmdbId
    ? await createSeerrRequest(provider, { mediaType: input.mediaType, tmdbId: input.tmdbId }).catch((error) => ({ ok: false, status: 0, body: { message: error instanceof Error ? error.message : "Seerr request failed" } }))
    : null;
  const externalId = externalResult?.ok && externalResult.body && typeof externalResult.body === "object" && "id" in externalResult.body
    ? String((externalResult.body as { id: unknown }).id)
    : `manual:${input.mediaType}:${input.tmdbId ?? input.tvdbId ?? input.imdbId ?? mediaIdentityKey(input)}`;
  const profileId = input.mediaType === "tv" ? provider?.defaultTvProfile : provider?.defaultMovieProfile;
  const manualRequest: ExternalMediaRequest = {
    ...input,
    externalId,
    requestedBy: "Drakkar",
    externalStatus: externalResult?.ok ? "2" : "manual"
  };
  const enriched = input.mediaType === "tv"
    ? await enrichTvRequestWithStructure(manualRequest).catch(() => manualRequest)
    : manualRequest;

  const existing = provider
    ? await prisma.mediaRequest.findUnique({ where: { providerId_externalId: { providerId: provider.id, externalId } } })
    : await prisma.mediaRequest.findFirst({ where: { providerId: null, externalId } });
  const data = {
    providerId: provider?.id,
    externalId,
    mediaType: input.mediaType,
    title: enriched.title,
    year: enriched.year,
    tmdbId: enriched.tmdbId,
    tvdbId: enriched.tvdbId,
    imdbId: enriched.imdbId,
    seasons: jsonValue(enriched.seasons),
    episodes: jsonValue(enriched.episodes),
    requestedBy: enriched.requestedBy,
    externalStatus: enriched.externalStatus,
    status: "approved",
    selectedProfileId: profileId
  };

  const request = existing
    ? await prisma.mediaRequest.update({
      where: { id: existing.id },
      data: {
      title: enriched.title,
      year: enriched.year,
      tmdbId: enriched.tmdbId,
      tvdbId: enriched.tvdbId,
      imdbId: enriched.imdbId,
      seasons: jsonValue(enriched.seasons),
      episodes: jsonValue(enriched.episodes),
      requestedBy: enriched.requestedBy,
      externalStatus: enriched.externalStatus,
      status: "approved",
      selectedProfileId: profileId
      }
    })
    : await prisma.mediaRequest.create({ data });
  return { request, seerr: externalResult };
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
    const sameTitle = normalizeTitleForIdentity(item.title) === normalizeTitleForIdentity(request.title);
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
      const episodeAirDateByNumber = new Map(episodeMetadata.map((episode) => [episode.episodeNumber, episode.airDate]));
      const episodes = Array.from({ length: episodeCount }, (_, index) => index + 1).map((episodeNumber) => {
        const aired = isAiredDate(episodeAirDateByNumber.get(episodeNumber));
        const monitored = aired && (monitorWholeSeason || monitoredEpisodes?.has(episodeNumber) || false);
        const available = availableBySeason.get(season.seasonNumber)?.has(episodeNumber) ?? false;
        const downloading = downloadingBySeason.get(season.seasonNumber)?.has(episodeNumber) ?? false;
        const status = available ? "available" : downloading ? "downloading" : monitored ? "missing_monitored" : "missing_unmonitored";
        return {
          episodeNumber,
          title: episodeNameByNumber.get(episodeNumber),
          airDate: episodeAirDateByNumber.get(episodeNumber),
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
  const cached = await cachedRequestReleases(request);
  if (cached) return { request, releases: cached };
  const season = firstRequestedSeason(request.seasons);
  const releases = await runSearch({
    kind: request.mediaType === "tv" && season ? "season" : request.mediaType === "tv" ? "tv" : "movie",
    query: request.title,
    imdbId: request.imdbId ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined,
    season
  });
  await cacheRequestReleases(request, releases);
  return { request, releases };
}

function requestReleaseCacheKey(request: MediaRequest) {
  return `request:release-cache:${request.id}:${Buffer.from(JSON.stringify({
    mediaType: request.mediaType,
    title: request.title,
    imdbId: request.imdbId,
    tmdbId: request.tmdbId,
    tvdbId: request.tvdbId,
    seasons: request.seasons,
    episodes: request.episodes
  })).toString("base64url")}`;
}

async function cachedRequestReleases(request: MediaRequest) {
  const cached = await redis.get(requestReleaseCacheKey(request)).catch(() => null);
  if (!cached) return null;
  return JSON.parse(cached) as Awaited<ReturnType<typeof runSearch>>;
}

async function cacheRequestReleases(request: MediaRequest, releases: Awaited<ReturnType<typeof runSearch>>) {
  if (releases.length === 0) return;
  await redis.set(requestReleaseCacheKey(request), JSON.stringify(releases), "EX", REQUEST_RELEASE_CACHE_SECONDS).catch(() => undefined);
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

export async function rankTvEpisodeForRequest(id: string, season: number, episode: number) {
  const request = await getRequest(id);
  if (request.mediaType !== "tv") throw new Error("request is not a TV request");
  const settings = await getSettings();
  const configuredProfileId = request.selectedProfileId ?? request.provider?.defaultTvProfile ?? settings.defaultTvProfile;
  const profile = await resolveProfile(configuredProfileId, request.mediaType);
  const releases = await runSearch({
    kind: "episode",
    query: request.title,
    imdbId: request.imdbId ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined,
    season,
    episode
  });
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

export async function grabTvEpisodeForRequest(id: string, season: number, episode: number) {
  const request = await getRequest(id);
  if (request.mediaType !== "tv") throw new Error("request is not a TV request");
  const existingEpisodes = await existingEpisodesForSeason(request.id, request.title, season);
  if (existingEpisodes.has(episode)) {
    return { grabbed: false, reason: "episode already available or downloading", season, episode };
  }
  const result = await grabBestTvSeasonForRequest(request, season, existingEpisodes, new Set([episode]));
  await refreshMediaLibrary().catch(() => undefined);
  return { season, episode, ...result };
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
    const reusable = await reuseExistingReleaseDownload(id, candidate.release);
    if (reusable) return { grabbed: true, release: candidate.release, decision: candidate.decision, download: reusable, reused: true };
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
        reason: blockReasonFromFailure(message),
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
        reason: blockReasonFromFailure(download.error),
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
  const seasonEpisodeCounts = new Map(
    Array.isArray(request.seasons)
      ? request.seasons.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const record = item as Record<string, unknown>;
          const seasonNumber = numberField(record.seasonNumber ?? record.season ?? record.number);
          const episodeCount = numberField(record.episodeCount ?? record.episodesCount ?? record.totalEpisodes);
          return seasonNumber ? [[seasonNumber, episodeCount ?? 0] as const] : [];
        })
      : []
  );

  const seasonsNeedingSearch: Array<{ season: number; existingEpisodes: Set<number>; requestedSeasonEpisodes?: Set<number> }> = [];
  for (const season of seasons) {
    if (await hasActiveSeasonPackDownload(request.title, season)) continue;
    const existingEpisodes = await existingEpisodesForSeason(request.id, request.title, season);
    const requestedSeasonEpisodes = requestedEpisodes.get(season);
    const knownEpisodeCount = seasonEpisodeCounts.get(season) ?? 0;
    if (requestedSeasonEpisodes && requestedSeasonEpisodes.size > 0 && [...requestedSeasonEpisodes].every((episode) => existingEpisodes.has(episode))) continue;
    if ((!requestedSeasonEpisodes || requestedSeasonEpisodes.size === 0) && knownEpisodeCount > 0 && existingEpisodes.size >= knownEpisodeCount) continue;
    seasonsNeedingSearch.push({ season, existingEpisodes, requestedSeasonEpisodes });
  }
  if (seasonsNeedingSearch.length === 0) {
    await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "available" } }).catch(() => undefined);
    await refreshMediaLibrary().catch(() => undefined);
    return { grabbed: false, reason: "all requested episodes already available", seasons: [] };
  }
  const seasonsForThisPass = seasonsNeedingSearch.slice(0, TV_SEASONS_PER_MONITOR_PASS);
  const broadReleases = await runSearch({
    kind: "tv",
    query: request.title,
    imdbId: request.imdbId ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined
  }).catch(() => []);
  const results = [];
  for (const { season, existingEpisodes, requestedSeasonEpisodes } of seasonsForThisPass) {
    const result = await grabBestTvSeasonForRequest(request, season, existingEpisodes, requestedSeasonEpisodes, broadReleases);
    results.push({ season, result });
  }

  const grabbedResults = results.filter((item) => item.result.grabbed);
  const grabbedDownloadId = downloadIdFromTvGrabResults(grabbedResults);
  const availableCount = await prisma.importItem.count({ where: { requestId: request.id } });
  const activeDownloads = await prisma.download.findMany({
    where: {
      title: { contains: request.title.split(":")[0], mode: "insensitive" },
      status: { in: TV_ACTIVE_DOWNLOAD_STATUSES }
    },
    select: { id: true },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 1
  });
  const activeDownloadId = activeDownloads[0]?.id ?? grabbedDownloadId ?? null;
  const refreshedMonitor = await getRequestMonitor(request.id).catch(() => null);
  const hasMissingEpisodes = refreshedMonitor?.seasons.some((season) => season.missingCount > 0) ?? false;
  await prisma.mediaRequest.update({
    where: { id: request.id },
    data: {
      status: hasMissingEpisodes
        ? activeDownloadId
          ? "grabbed"
          : "approved"
        : availableCount > 0
          ? "available"
          : activeDownloadId
            ? "grabbed"
            : grabbedResults.length > 0
              ? "grabbed"
              : "no_release_found",
      downloadId: activeDownloadId
    }
  });
  await refreshMediaLibrary().catch(() => undefined);
  return {
    grabbed: grabbedResults.length > 0,
    seasons: results,
    remainingSeasonSearches: Math.max(0, seasonsNeedingSearch.length - seasonsForThisPass.length)
  };
}

function downloadIdFromTvGrabResults(results: Array<{ result: { queued?: Array<{ download?: { id?: string } }>; download?: { id?: string } } }>) {
  for (const item of results) {
    if (item.result.download?.id) return item.result.download.id;
    for (const queued of item.result.queued ?? []) {
      if (queued.download?.id) return queued.download.id;
    }
  }
  return null;
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
    const sameTitle = normalizeTitleForIdentity(item.title) === normalizeTitleForIdentity(title);
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
  requestedEpisodes?: Set<number>,
  releasePool?: Parameters<typeof scoreRelease>[0][]
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
  const episodeMetadata = seriesStructure?.tmdbId
    ? await fetchSeasonEpisodes(settings, seriesStructure.tmdbId, season).catch(() => [])
    : [];
  const airedEpisodes = new Set(episodeMetadata.filter((episode) => isAiredDate(episode.airDate)).map((episode) => episode.episodeNumber).filter((episode) => episode > 0));
  const eligibleRequestedEpisodes = requestedEpisodes && requestedEpisodes.size > 0
    ? airedEpisodes.size > 0 ? intersectEpisodes(requestedEpisodes, airedEpisodes) : requestedEpisodes
    : airedEpisodes.size > 0 ? airedEpisodes : undefined;
  if (eligibleRequestedEpisodes && eligibleRequestedEpisodes.size === 0) {
    return { grabbed: false, reason: "no aired monitored episodes need search", queued: [], rejected: [] };
  }
  const seasonEpisodeCount = eligibleRequestedEpisodes?.size ?? seriesStructure?.seasons.find((item) => item.seasonNumber === season)?.episodeCount;
  const pooledSeasonReleases = releasePool?.length
    ? releasePool.filter((release) => releaseBelongsToSeason(release.title, season))
    : [];
  const releases = pooledSeasonReleases.length > 0
    ? pooledSeasonReleases
    : await runSearch({
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
  const accepted = scored.filter((item) => item.decision.accepted).sort((a, b) => b.decision.score - a.decision.score);
  const seasonPacks = accepted.filter((item) => isSeasonPackTitle(item.release.title, season));
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

  const episodeCandidates = bestEpisodeCandidates(accepted, season, existingEpisodes, eligibleRequestedEpisodes);
  const coveredEpisodes = episodesFromCandidates(episodeCandidates, season);
  const remainingExistingEpisodes = new Set([...existingEpisodes, ...coveredEpisodes]);
  const separatelySearchedEpisodes = await searchEpisodesForSeason(
    request,
    season,
    profile,
    remainingExistingEpisodes,
    eligibleRequestedEpisodes,
    seasonEpisodeCount,
    releases
  );
  const fallbackEpisodeCandidates = [...episodeCandidates, ...separatelySearchedEpisodes];
  for (const candidate of fallbackEpisodeCandidates) {
    if (queued.length >= TV_EPISODE_DOWNLOADS_PER_REQUEST_PASS) {
      rejected.push(`stopped after ${TV_EPISODE_DOWNLOADS_PER_REQUEST_PASS} queued episode candidates; remaining episodes rotate next monitor pass`);
      break;
    }
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
  for (const item of items) {
    const episode = episodeNumberFromTitle(item.release.title, season);
    if (!episode) continue;
    if (existingEpisodes.has(episode)) continue;
    if (requestedEpisodes && requestedEpisodes.size > 0 && !requestedEpisodes.has(episode)) continue;
    const existing = byEpisode.get(episode);
    if (!existing || item.decision.score > existing.decision.score) byEpisode.set(episode, item);
  }
  return [...byEpisode.entries()]
    .sort(([episodeA], [episodeB]) => episodeA - episodeB)
    .map(([, item]) => item);
}

function episodesFromCandidates<T extends { release: { title: string } }>(items: T[], season: number) {
  const episodes = new Set<number>();
  for (const item of items) {
    const episode = episodeNumberFromTitle(item.release.title, season);
    if (episode) episodes.add(episode);
  }
  return episodes;
}

async function searchEpisodesForSeason(
  request: MediaRequest & { provider?: RequestProvider | null },
  season: number,
  profile: Awaited<ReturnType<typeof resolveProfile>>,
  existingEpisodes = new Set<number>(),
  requestedEpisodes?: Set<number>,
  seasonEpisodeCount?: number,
  releasePool?: Parameters<typeof scoreRelease>[0][]
) {
  const targets = requestedEpisodes && requestedEpisodes.size > 0
    ? [...requestedEpisodes].filter((episode) => !existingEpisodes.has(episode))
    : Array.from({ length: Math.max(0, seasonEpisodeCount ?? 0) }, (_, index) => index + 1).filter((episode) => !existingEpisodes.has(episode));
  if (targets.length === 0) return [];

  let networkSearches = 0;
  let cacheHits = 0;
  const hasReleasePool = Array.isArray(releasePool);
  const perEpisode: Array<{
    release: Parameters<typeof scoreRelease>[0];
    decision: ReturnType<typeof scoreRelease>;
  } | undefined> = [];
  const batchSize = 4;
  for (let index = 0; index < targets.length; index += batchSize) {
    const batch = targets.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map(async (episode) => {
      const cachedEpisodeReleases = hasReleasePool
        ? releasePool.filter((release) => releaseBelongsToEpisode(release.title, season, episode))
        : [];
      if (cachedEpisodeReleases.length > 0) cacheHits += 1;
      else networkSearches += 1;
      const releases = cachedEpisodeReleases.length > 0
        ? cachedEpisodeReleases
        : await runSearch({
            kind: "episode",
            query: request.title,
            imdbId: request.imdbId ?? undefined,
            tmdbId: request.tmdbId ?? undefined,
            tvdbId: request.tvdbId ?? undefined,
            season,
            episode,
            recordHistory: false
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
    }));
    perEpisode.push(...batchResults);
  }

  const found = perEpisode.filter((item): item is NonNullable<(typeof perEpisode)[number]> => Boolean(item));
  if (found.length > 0 || networkSearches > 0) {
    await prisma.searchHistory.create({
      data: {
        type: "episode-grab",
        query: { requestId: request.id, title: request.title, season, targets: targets.length, cacheHits, networkSearches },
        resultCount: found.length,
        status: "ok",
        message: found.length > 0 ? "episode candidates found" : "no episode candidates after network search"
      }
    }).catch(() => undefined);
  }

  return found;
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
  return titleCoversSeason(title, season) && !episodePattern(season).test(title);
}

function releaseBelongsToSeason(title: string, season: number) {
  return titleCoversSeason(title, season) || episodePattern(season).test(title);
}

function releaseBelongsToEpisode(title: string, season: number, episode: number) {
  return episodesCoveredByTitle(title, season).has(episode);
}

function episodeNumberFromTitle(title: string, season: number) {
  return [...episodesCoveredByTitle(title, season)].sort((a, b) => a - b)[0];
}

function seasonPattern(season: number) {
  return new RegExp(`\\bS0?${season}\\b`, "i");
}

function titleCoversSeason(title: string, season: number) {
  if (seasonPattern(season).test(title)) return true;
  const range = title.match(/\bS(?<start>\d{1,2})(?:-|to|–)(?<end>\d{1,2})\b/i);
  if (!range?.groups) return false;
  const start = Number(range.groups.start);
  const end = Number(range.groups.end);
  return Number.isFinite(start) && Number.isFinite(end) && season >= Math.min(start, end) && season <= Math.max(start, end);
}

function episodePattern(season: number, episode?: number) {
  const episodePart = episode ? `0?${episode}` : "\\d{1,3}";
  return new RegExp(`(?:\\bS0?${season}E(?<episode>${episodePart})(?:\\b|E\\d{1,3}|[- .]?E?\\d{1,3}\\b)|\\b0?${season}x(?<episode_x>${episodePart})\\b)`, "i");
}

function episodesCoveredByTitle(title: string, season: number) {
  const episodes = new Set<number>();
  const single = title.match(new RegExp(`\\bS0?${season}E(?<episode>\\d{1,3})\\b`, "i"));
  if (single?.groups?.episode) episodes.add(Number(single.groups.episode));

  const oneBy = title.match(new RegExp(`\\b0?${season}x(?<episode>\\d{1,3})\\b`, "i"));
  if (oneBy?.groups?.episode) episodes.add(Number(oneBy.groups.episode));

  const multi = title.match(new RegExp(`\\bS0?${season}E(?<first>\\d{1,3})(?<rest>(?:E\\d{1,3})+)\\b`, "i"));
  if (multi?.groups?.first && multi.groups.rest) {
    episodes.add(Number(multi.groups.first));
    for (const match of multi.groups.rest.matchAll(/E(\d{1,3})/gi)) episodes.add(Number(match[1]));
  }

  const range = title.match(new RegExp(`\\bS0?${season}E(?<start>\\d{1,3})[- .]?E?(?<end>\\d{1,3})\\b`, "i"));
  if (range?.groups?.start && range.groups.end) {
    const start = Number(range.groups.start);
    const end = Number(range.groups.end);
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    for (let episode = low; episode <= high && episode - low <= 50; episode += 1) episodes.add(episode);
  }

  return episodes;
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
  const reusable = await reuseExistingReleaseDownload(requestId, candidate.release);
  if (reusable) return { grabbed: true, release: candidate.release, decision: candidate.decision, download: reusable, reused: true };
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
      reason: blockReasonFromFailure(message),
      source: "grab-validation",
      release: candidate.release
    }).catch(() => undefined);
    return { grabbed: false, reason: message };
  }
  if (download.status === "failed") {
    await createBlocklistItem({
      guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
      title: candidate.release.title,
      reason: blockReasonFromFailure(download.error),
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

  const reusable = await reuseExistingReleaseDownload(id, typedRelease);
  if (reusable) return { grabbed: true, release: typedRelease, decision, download: reusable, reused: true };

  const nzb = await downloadNzb(settings, typedRelease);
  const download = await addNzbFromPath(nzb.primaryPath, typedRelease.title, {
    guid: typedRelease.guid ? String(typedRelease.guid) : undefined,
    requestId: id
  });
  if (download.status === "failed") {
    await createBlocklistItem({
      guid: typedRelease.guid ? String(typedRelease.guid) : undefined,
      title: typedRelease.title,
      reason: blockReasonFromFailure(download.error),
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
    reason: blockReasonFromFailure(reason),
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
