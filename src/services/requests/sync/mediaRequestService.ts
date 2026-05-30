import { prisma, Prisma, type MediaRequest, type RequestProvider } from "../../../repositories/db/prisma.js";
import { redis } from "../../../repositories/db/redis.js";
import { LocalTtlCache } from "../../cache/localTtlCache.js";
import { downloadNzb } from "../../indexers/nzbhydra/client.js";
import { refreshMediaLibrary } from "../../libraryService.js";
import { refreshLibraryRequestRows } from "../../media-library/libraryRefresh.js";
import { fetchMediaDetails as fetchMetadataDetails, fetchSeasonEpisodes, fetchSeriesStructure } from "../../metadataService.js";
import { runSearch } from "../../searchService.js";
import { getSettings } from "../../settings/settingsStore.js";
import { addNzbFromPath, findReusableDownload, promoteDownloadPriority } from "../../downloadService.js";
import { mediaIdentityKey, normalizeTitleForIdentity, titlesLikelyMatch } from "../../media-library/identity.js";
import { upsertMovie, upsertTvEpisode, upsertTvSeason, upsertTvShow } from "../../media-library/normalizedMedia.js";
import { mapWithConcurrency } from "../../media-library/libraryShared.js";
import { subtitleLanguagesForItem } from "../../media-library/libraryQueries.js";
import { parseReleaseTitle } from "../../quality/parser.js";
import { scoreRelease } from "../../quality/scoring.js";
import { ensureDefaultProfiles } from "../../quality/profileService.js";
import { createBlocklistItem, isReleaseBlocklisted } from "../../policyService.js";
import { fetchSeerrRequests } from "../seerr/client.js";
import type { ExternalMediaRequest } from "../types.js";
import { runRequestGrabPipeline, type RequestPipelineCandidate, runTvRequestGrabPipeline, runTvSeasonGrabPipeline, type TvSeasonGrabResult } from "../pipeline/index.js";
import { requestDuplicateRank, requestMatchesIdentity } from "./requestIdentity.js";
import { hydrateLegacyRequestFields } from "../../media-library/normalizedMedia.js";

const TV_ACTIVE_DOWNLOAD_STATUSES = ["queued", "fetching_nzb", "verifying", "prepared", "waiting_for_provider", "waiting_for_nzb", "downloading", "paused"];
const SEARCH_COOLDOWN_SECONDS = 300;
const REQUEST_MISSING_ARTICLE_TV_COOLDOWN_SECONDS = 2 * 60 * 60;
const REQUEST_MISSING_ARTICLE_TV_SEASON_COOLDOWN_SECONDS = 8 * 60 * 60;
const REQUEST_MISSING_ARTICLE_MOVIE_COOLDOWN_SECONDS = 8 * 60 * 60;
const REQUEST_MISSING_ARTICLE_FOLLOWUP_COOLDOWN_SECONDS = 15 * 60;
const REQUEST_RELEASE_CACHE_SECONDS = 6 * 60 * 60;
const TV_SEASONS_PER_MONITOR_PASS = 1;
const TV_EPISODE_DOWNLOADS_PER_REQUEST_PASS = 6;
const MOVIE_NZB_FETCH_ATTEMPTS_PER_PASS = 1;
const TV_NZB_FETCH_ATTEMPTS_PER_SEASON_PASS = 2;
const REQUEST_GRAB_COOLDOWN_SECONDS = 30 * 60;
const REQUEST_WANTED_SEARCH_COOLDOWN_SECONDS = 6 * 60 * 60;
const REQUEST_WANTED_SEARCH_TIMEOUT_COOLDOWN_SECONDS = 5 * 60;
const LOCAL_REDIS_NEGATIVE_CACHE_MS = 30 * 1000;
const localRequestCooldownCache = new LocalTtlCache<boolean>();
const tvMonitorCursorCache = new LocalTtlCache<number | null>();

const REQUEST_RELATION_SELECT = {
  movie: {
    select: {
      tmdbId: true,
      imdbId: true,
      tvdbId: true,
      title: true,
      overview: true,
      year: true
    }
  },
  tvShow: {
    select: {
      tmdbId: true,
      imdbId: true,
      tvdbId: true,
      title: true,
      overview: true,
      year: true
    }
  },
  seasonTarget: {
    select: {
      seasonNumber: true,
      title: true,
      overview: true
    }
  },
  episodeTarget: {
    select: {
      seasonNumber: true,
      episodeNumber: true,
      title: true,
      overview: true,
      airDate: true
    }
  }
} as const;

async function fetchProviderRequests(
  provider: RequestProvider,
  options: { full?: boolean; skip?: number; maxRequests?: number; pageSize?: number } = {}
) {
  return fetchSeerrRequests(provider, {
    maxRequests: options.maxRequests ?? (options.full ? undefined : 200),
    includeDetails: false,
    skip: options.skip,
    pageSize: options.pageSize
  });
}

function blockReasonFromFailure(message?: string | null) {
  const normalized = (message ?? "").toLowerCase();
  if (/duplicate|already exists/.test(normalized)) return "duplicate_nzb";
  if (/430 no such article|no such article|article.*not found|missing article|missing segment|segment download failed|required usenet articles|provider.*missing/.test(normalized)) return "missing_articles";
  if (/password|encrypted/.test(normalized)) return "passworded_archive";
  if (/unsupported archive|rar nzb would require|full disk materialization|archive.*refus|archive extraction|materialization/.test(normalized)) return "unsupported_archive";
  if (/no direct streamable video|no streamable video|no eligible files|no importable media|contains no streamable video/.test(normalized)) return "no_video_content";
  return "grab_failed";
}

function isRetryableGrabFailure(message?: string | null) {
  const normalized = (message ?? "").toLowerCase();
  return /nzb download failed with http \d+\b/.test(normalized)
    || /timed out|timeout|aborted|fetch failed|socket hang up|econnreset|ehostunreach|service unavailable|temporarily disabled/.test(normalized);
}

async function maybeBlocklistGrabFailure(input: {
  guid?: string | null;
  title: string;
  reason?: string | null;
  source: string;
  release?: unknown;
}) {
  if (isRetryableGrabFailure(input.reason)) return false;
  await createBlocklistItem({
    guid: input.guid === undefined || input.guid === null ? undefined : String(input.guid),
    title: input.title,
    reason: blockReasonFromFailure(input.reason),
    source: input.source,
    release: input.release
  }).catch(() => undefined);
  return true;
}

function scoreReleaseForRequest(
  request: Pick<MediaRequest, "mediaType" | "title" | "year">,
  release: Parameters<typeof scoreRelease>[0],
  profile: Awaited<ReturnType<typeof resolveProfile>>,
  options?: { rejectAmbiguousAnime?: boolean }
) {
  const decision = scoreRelease(release, profile);
  const reasons = [...decision.reasons];
  const parsedTitleMatches = !decision.parsed.title || titlesLikelyMatch(request.title, decision.parsed.title);
  if (
    request.mediaType === "movie"
    && (
      decision.parsed.mediaHint === "tv"
      || decision.parsed.season
      || decision.parsed.episode
      || decision.parsed.isSeasonPack
      || decision.parsed.isDaily
      || /\bTV\b/i.test(release.category ?? "")
    )
  ) {
    reasons.push("TV episode or season release rejected for movie request");
  }
  if (!parsedTitleMatches) {
    reasons.push(`parsed release title "${decision.parsed.title}" does not match requested title "${request.title}"`);
  }
  if (request.mediaType === "movie" && request.year && decision.parsed.year && decision.parsed.year !== request.year) {
    reasons.push(`movie year ${decision.parsed.year} does not match requested year ${request.year}`);
  }
  if (
    options?.rejectAmbiguousAnime &&
    request.mediaType === "tv" &&
    /\banime\b/i.test(release.category ?? "") &&
    request.year &&
    !new RegExp(`\\b${request.year}\\b`).test(release.title) &&
    !release.imdbId &&
    !release.tmdbId &&
    !release.tvdbId
  ) {
    reasons.push("ambiguous anime-category release rejected for year-specific TV request");
  }
  const accepted = reasons.length === 0;
  return {
    ...decision,
    accepted,
    score: accepted ? decision.score : Math.min(decision.score, -1000),
    reasons
  };
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

type SyncRequestAction = "created" | "updated" | "skipped";

function statusFromExternal(externalStatus?: string | null, mediaType?: string) {
  if (externalStatus === "2") return "approved";
  if (externalStatus === "3") return "rejected";
  if (externalStatus === "4" || externalStatus === "5") return mediaType === "tv" ? "approved" : "available";
  return "pending";
}

function normalizeJson(value: unknown) {
  return value === undefined ? undefined : JSON.stringify(value);
}

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
  await refreshLibraryRequestRows([requestId]).catch(() => undefined);
  return reusable;
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

  const explicitRequestedEpisodes = requestedEpisodesBySeason(request.episodes as Prisma.JsonValue | null | undefined);
  const explicitRequestedSeasons = requestedSeasons(request.seasons as Prisma.JsonValue | null | undefined);
  const requestedSeasonNumbers = explicitRequestedSeasons.length > 0
    ? explicitRequestedSeasons
    : explicitRequestedEpisodes.size > 0
      ? [...explicitRequestedEpisodes.keys()].sort((left, right) => left - right)
      : [];
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

function isPlaceholderRequestTitle(value?: string | null) {
  return Boolean(value && /^Request \d+$/i.test(value.trim()));
}

async function enrichRequestMetadataFallback(request: ExternalMediaRequest) {
  if (!request.tmdbId && !request.tvdbId && !request.imdbId) return request;
  const needsMetadata = !request.title || isPlaceholderRequestTitle(request.title) || !request.year;
  if (!needsMetadata) return request;
  const settings = await getSettings();
  const details = await fetchMetadataDetails(settings, {
    mediaType: request.mediaType,
    title: request.title,
    year: request.year,
    tmdbId: request.tmdbId,
    tvdbId: request.tvdbId,
    imdbId: request.imdbId
  }).catch(() => undefined);
  if (!details) return request;
  return {
    ...request,
    title: isPlaceholderRequestTitle(request.title) || !request.title ? details.title ?? request.title : request.title,
    year: request.year ?? details.year,
    tmdbId: request.tmdbId ?? details.tmdbId,
    tvdbId: request.tvdbId ?? details.tvdbId,
    imdbId: request.imdbId ?? details.imdbId
  };
}

function jsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function resolveNormalizedRequestTargets(request: ExternalMediaRequest) {
  const normalizedRequest = await enrichRequestMetadataFallback(request).catch(() => request);
  if (request.mediaType === "movie") {
    if (!normalizedRequest.tmdbId) return { movieId: undefined, tvShowId: undefined, seasonId: undefined, episodeId: undefined };
    const movie = await upsertMovie(prisma, {
      tmdbId: normalizedRequest.tmdbId,
      imdbId: normalizedRequest.imdbId,
      tvdbId: normalizedRequest.tvdbId,
      title: normalizedRequest.title,
      year: normalizedRequest.year
    });
    return { movieId: movie.id, tvShowId: undefined, seasonId: undefined, episodeId: undefined };
  }

  if (!normalizedRequest.tmdbId) return { movieId: undefined, tvShowId: undefined, seasonId: undefined, episodeId: undefined };

  const show = await upsertTvShow(prisma, {
    tmdbId: normalizedRequest.tmdbId,
    imdbId: normalizedRequest.imdbId,
    tvdbId: normalizedRequest.tvdbId,
    title: normalizedRequest.title,
    year: normalizedRequest.year
  });

  const requestedSeasonNumbers = requestedSeasons(jsonValue(normalizedRequest.seasons) as Prisma.JsonValue | null | undefined);
  const explicitEpisodes = requestedEpisodesBySeason(jsonValue(normalizedRequest.episodes) as Prisma.JsonValue | null | undefined);
  const singleEpisode =
    explicitEpisodes.size === 1
      ? [...explicitEpisodes.entries()].flatMap(([seasonNumber, episodes]) =>
          episodes.size === 1 ? [{ seasonNumber, episodeNumber: [...episodes][0]! }] : []
        )[0]
      : undefined;
  const singleSeasonNumber =
    requestedSeasonNumbers.length === 1
      ? requestedSeasonNumbers[0]
      : explicitEpisodes.size === 1
        ? [...explicitEpisodes.keys()][0]
        : undefined;

  if (!singleSeasonNumber) {
    return { movieId: undefined, tvShowId: show.id, seasonId: undefined, episodeId: undefined };
  }

  const settings = await getSettings();
  const structure = await fetchSeriesStructure(settings, {
    mediaType: "tv",
    title: normalizedRequest.title,
    year: normalizedRequest.year,
    tmdbId: normalizedRequest.tmdbId,
    tvdbId: normalizedRequest.tvdbId,
    imdbId: normalizedRequest.imdbId
  }).catch(() => undefined);
  const structureSeason = structure?.seasons.find((season) => season.seasonNumber === singleSeasonNumber);
  const season = await upsertTvSeason(prisma, {
    tvShowId: show.id,
    seasonNumber: singleSeasonNumber,
    title: structureSeason?.name ?? `Season ${String(singleSeasonNumber).padStart(2, "0")}`,
    airDate: structureSeason?.airDate ? new Date(structureSeason.airDate) : undefined,
    episodeCount: structureSeason?.episodeCount
  });

  if (!singleEpisode) {
    return { movieId: undefined, tvShowId: show.id, seasonId: season.id, episodeId: undefined };
  }

  const seasonEpisodes = await fetchSeasonEpisodes(settings, normalizedRequest.tmdbId, singleEpisode.seasonNumber).catch(() => []);
  const seasonEpisode = seasonEpisodes.find((episode) => episode.episodeNumber === singleEpisode.episodeNumber);
  const episode = await upsertTvEpisode(prisma, {
    tvShowId: show.id,
    seasonId: season.id,
    seasonNumber: singleEpisode.seasonNumber,
    episodeNumber: singleEpisode.episodeNumber,
    title: seasonEpisode?.name ?? `Episode ${singleEpisode.episodeNumber}`,
    overview: seasonEpisode?.overview,
    airDate: seasonEpisode?.airDate ? new Date(seasonEpisode.airDate) : undefined,
    stillPath: seasonEpisode?.stillUrl
  });

  return { movieId: undefined, tvShowId: show.id, seasonId: season.id, episodeId: episode.id };
}

function requestRawRequestValue(providerId: string | null | undefined, request: ExternalMediaRequest, extra?: Record<string, unknown>) {
  return jsonValue({
    providerId: providerId ?? null,
    externalId: request.externalId,
    requestedBy: request.requestedBy,
    requestedQuality: request.requestedQuality,
    externalStatus: request.externalStatus,
    seasons: request.seasons,
    episodes: request.episodes,
    ...extra
  });
}

function requestRawMediaValue(request: ExternalMediaRequest) {
  return jsonValue({
    mediaType: request.mediaType,
    title: request.title,
    year: request.year,
    tmdbId: request.tmdbId,
    tvdbId: request.tvdbId,
    imdbId: request.imdbId
  });
}

function requestStatusForDownloadStatus(status: string) {
  if (status === "available" || status === "completed") return "available";
  return "grabbed";
}

function isFailedLinkedDownloadStatus(status?: string | null) {
  return Boolean(status && ["failed", "cancelled", "replaced"].includes(status));
}

export function effectiveRequestStatus(input: {
  request: Pick<MediaRequest, "mediaType" | "status">;
  downloadStatus?: string | null;
  monitorSummary?: { hasMissingEpisodes?: boolean; downloadingCount?: number } | null;
}) {
  const currentStatus = input.request.status;
  const linkedDownloadStatus = input.downloadStatus ?? null;
  if (linkedDownloadStatus === "available" || linkedDownloadStatus === "completed") {
    if (input.request.mediaType === "tv") {
      return input.monitorSummary?.hasMissingEpisodes ? "approved" : "available";
    }
    return "available";
  }
  if (isFailedLinkedDownloadStatus(linkedDownloadStatus)) {
    if (input.request.mediaType === "tv") {
      return input.monitorSummary?.hasMissingEpisodes ? "approved" : "available";
    }
    return currentStatus === "no_release_found" ? "no_release_found" : "approved";
  }
  if (currentStatus !== "grabbed") return currentStatus;
  if (input.request.mediaType === "tv") {
    if ((input.monitorSummary?.downloadingCount ?? 0) > 0) return "grabbed";
    return input.monitorSummary?.hasMissingEpisodes ? "approved" : "available";
  }
  return linkedDownloadStatus ? currentStatus : "approved";
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
    (next.mediaType === "movie" && !existing.movieId && Boolean(next.tmdbId)) ||
    (next.mediaType === "tv" && !existing.tvShowId && Boolean(next.tmdbId)) ||
    clearDownloadId
  );
}

function requestCandidateFilters(request: ExternalMediaRequest) {
  const filters: Prisma.MediaRequestWhereInput[] = [{ externalId: request.externalId }];
  if (request.imdbId) filters.push({ imdbId: request.imdbId });
  if (request.tmdbId) filters.push({ tmdbId: request.tmdbId });
  if (request.tvdbId) filters.push({ tvdbId: request.tvdbId });
  if (!request.imdbId && !request.tmdbId && !request.tvdbId && request.year) filters.push({ year: request.year });
  return filters;
}

async function findDuplicateRequestCandidates(provider: RequestProvider, request: ExternalMediaRequest) {
  const candidates = await prisma.mediaRequest.findMany({
    where: {
      providerId: provider.id,
      mediaType: request.mediaType,
      OR: requestCandidateFilters(request)
    },
    include: {
      imports: { select: { id: true } }
    },
    orderBy: { createdAt: "asc" }
  });
  return candidates.filter((candidate) => candidate.externalId === request.externalId || requestMatchesIdentity(candidate, request));
}

function chooseCanonicalRequest(
  candidates: Array<MediaRequest & { imports: { id: string }[] }>,
  externalId: string
) {
  const exact = candidates.find((candidate) => candidate.externalId === externalId);
  if (exact) return exact;
  return [...candidates].sort((left, right) => {
    const scoreDelta = requestDuplicateRank(right) - requestDuplicateRank(left);
    if (scoreDelta !== 0) return scoreDelta;
    return left.createdAt.getTime() - right.createdAt.getTime();
  })[0] ?? null;
}

async function consolidateDuplicateRequests(
  canonical: MediaRequest & { imports: { id: string }[] },
  duplicates: Array<MediaRequest & { imports: { id: string }[] }>
) {
  if (duplicates.length === 0) return canonical;
  const duplicateIds = duplicates.map((item) => item.id);
  const carryDownloadId = canonical.downloadId ?? duplicates.find((item) => item.downloadId)?.downloadId ?? null;
  const carrySelectedRelease = canonical.selectedRelease ?? duplicates.find((item) => item.selectedRelease)?.selectedRelease ?? undefined;
  const carryRequestedQuality = canonical.requestedQuality ?? duplicates.find((item) => item.requestedQuality)?.requestedQuality ?? undefined;
  const carryRequestedBy = canonical.requestedBy ?? duplicates.find((item) => item.requestedBy)?.requestedBy ?? undefined;
  const carryExternalStatus = canonical.externalStatus ?? duplicates.find((item) => item.externalStatus)?.externalStatus ?? undefined;
  const carrySeasons = canonical.seasons ?? duplicates.find((item) => item.seasons)?.seasons ?? undefined;
  const carryEpisodes = canonical.episodes ?? duplicates.find((item) => item.episodes)?.episodes ?? undefined;

  await prisma.$transaction(async (tx) => {
    await tx.importItem.updateMany({
      where: { requestId: { in: duplicateIds } },
      data: { requestId: canonical.id }
    });
    await tx.mediaLibraryItem.updateMany({
      where: { requestId: { in: duplicateIds } },
      data: { requestId: canonical.id }
    });
    await tx.mediaLibraryItem.deleteMany({
      where: { sourceKey: { in: duplicateIds.map((id) => `request:${id}`) } }
    });
    await tx.mediaRequest.update({
      where: { id: canonical.id },
      data: {
        ...(carryDownloadId ? { downloadId: carryDownloadId } : {}),
        ...(carrySelectedRelease ? { selectedRelease: carrySelectedRelease as Prisma.InputJsonValue } : {}),
        ...(carryRequestedQuality ? { requestedQuality: carryRequestedQuality } : {}),
        ...(carryRequestedBy ? { requestedBy: carryRequestedBy } : {}),
        ...(carryExternalStatus ? { externalStatus: carryExternalStatus } : {}),
        ...(carrySeasons ? { seasons: carrySeasons as Prisma.InputJsonValue } : {}),
        ...(carryEpisodes ? { episodes: carryEpisodes as Prisma.InputJsonValue } : {})
      }
    });
    await tx.mediaRequest.deleteMany({
      where: { id: { in: duplicateIds } }
    });
  });

  return prisma.mediaRequest.findUniqueOrThrow({
    where: { id: canonical.id },
    include: { imports: { select: { id: true } } }
  });
}

export async function upsertRequest(provider: RequestProvider, request: ExternalMediaRequest): Promise<{ request: MediaRequest; action: SyncRequestAction }> {
  const candidates = await findDuplicateRequestCandidates(provider, request);
  const canonical = chooseCanonicalRequest(candidates, request.externalId);
  const existing = canonical
    ? await consolidateDuplicateRequests(canonical, candidates.filter((candidate) => candidate.id !== canonical.id))
    : null;
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

  if (existing) {
    const normalizedTargets = await resolveNormalizedRequestTargets(request);
    const synced = await prisma.mediaRequest.update({
      where: { id: existing.id },
      data: {
        externalId: request.externalId,
        mediaType: request.mediaType,
        providerId: provider.id,
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
        rawRequest: requestRawRequestValue(provider.id, request),
        rawMedia: requestRawMediaValue(request),
        status: nextStatus,
        movieId: normalizedTargets.movieId,
        tvShowId: normalizedTargets.tvShowId,
        seasonId: normalizedTargets.seasonId,
        episodeId: normalizedTargets.episodeId,
        ...(clearDownloadId ? { downloadId: null } : {})
      }
    });
    return { request: synced, action: "updated" };
  }

  const normalizedTargets = await resolveNormalizedRequestTargets(request);
  const synced = await prisma.mediaRequest.create({
    data: {
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
      rawRequest: requestRawRequestValue(provider.id, request),
      rawMedia: requestRawMediaValue(request),
      movieId: normalizedTargets.movieId,
      tvShowId: normalizedTargets.tvShowId,
      seasonId: normalizedTargets.seasonId,
      episodeId: normalizedTargets.episodeId,
      status: statusFromExternal(request.externalStatus, request.mediaType)
    }
  });

  return { request: synced, action: "created" };
}

export function getRequest(id: string) {
  return prisma.mediaRequest.findUniqueOrThrow({
    where: { id },
    include: {
      provider: true,
      ...REQUEST_RELATION_SELECT
    }
  }).then((request) => hydrateLegacyRequestFields(request));
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
  const externalId = `manual:${input.mediaType}:${input.tmdbId ?? input.tvdbId ?? input.imdbId ?? mediaIdentityKey(input)}`;
  const profileId = input.mediaType === "tv" ? provider?.defaultTvProfile : provider?.defaultMovieProfile;
  const manualRequest: ExternalMediaRequest = {
    ...input,
    externalId,
    requestedBy: "Drakkar",
    externalStatus: "manual"
  };
  const metadataEnriched = await enrichRequestMetadataFallback(manualRequest).catch(() => manualRequest);
  const enriched = input.mediaType === "tv"
    ? await enrichTvRequestWithStructure(metadataEnriched).catch(() => metadataEnriched)
    : metadataEnriched;

  const existing = provider
    ? await prisma.mediaRequest.findUnique({ where: { providerId_externalId: { providerId: provider.id, externalId } } })
    : await prisma.mediaRequest.findFirst({ where: { providerId: null, externalId } });
  const data = {
    providerId: null,
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
    rawRequest: requestRawRequestValue(null, enriched, { source: "manual" }),
    rawMedia: requestRawMediaValue(enriched),
    status: "approved",
    selectedProfileId: profileId
  };
  const normalizedTargets = await resolveNormalizedRequestTargets(enriched);

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
        rawRequest: requestRawRequestValue(null, enriched, { source: "manual" }),
        rawMedia: requestRawMediaValue(enriched),
        movieId: normalizedTargets.movieId,
        tvShowId: normalizedTargets.tvShowId,
        seasonId: normalizedTargets.seasonId,
        episodeId: normalizedTargets.episodeId,
        status: "approved",
        selectedProfileId: profileId
      }
    })
    : await prisma.mediaRequest.create({
      data: {
        ...data,
        movieId: normalizedTargets.movieId,
        tvShowId: normalizedTargets.tvShowId,
        seasonId: normalizedTargets.seasonId,
        episodeId: normalizedTargets.episodeId
      }
    });
  return { request, seerr: null, localOnly: true };
}

export async function tvRequestAvailabilitySummary(request: MediaRequest) {
  const seasons = await monitoredSeasonNumbersForRequest(request);
  if (seasons.length === 0) {
    const available = await prisma.importItem.count({ where: { requestId: request.id, mediaType: "tv" } });
    return { hasMissingEpisodes: available === 0, hasAvailableEpisodes: available > 0 };
  }
  const requestedEpisodes = requestedEpisodesBySeason(request.episodes);
  const seasonEpisodeCounts = await requestedSeasonEpisodeCounts(request, seasons);

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
    if (knownEpisodeCount > 0) {
      if (existingEpisodes.size < knownEpisodeCount) hasMissingEpisodes = true;
      continue;
    }
    if (existingEpisodes.size === 0) hasMissingEpisodes = true;
  }
  return { hasMissingEpisodes, hasAvailableEpisodes };
}

async function requestedSeasonEpisodeCounts(
  request: Pick<MediaRequest, "mediaType" | "title" | "year" | "tmdbId" | "tvdbId" | "imdbId" | "seasons">,
  seasonNumbers?: number[]
) {
  const counts = new Map(
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
  const missingSeasonCounts = (seasonNumbers ?? [...counts.keys()]).filter((season) => season > 0 && (counts.get(season) ?? 0) <= 0);
  if (request.mediaType !== "tv" || missingSeasonCounts.length === 0) return counts;

  const settings = await getSettings();
  const structure = await fetchSeriesStructure(settings, {
    mediaType: "tv",
    title: request.title,
    year: request.year ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined,
    imdbId: request.imdbId ?? undefined
  }).catch(() => undefined);
  for (const season of missingSeasonCounts) {
    const structureSeason = structure?.seasons.find((item) => item.seasonNumber === season);
    if (structureSeason?.episodeCount && structureSeason.episodeCount > 0) {
      counts.set(season, structureSeason.episodeCount);
    }
  }
  return counts;
}

function requestedEpisodeTotals(request: Pick<MediaRequest, "episodes" | "seasons">) {
  const explicit = requestedEpisodesBySeason(request.episodes);
  if (explicit.size > 0) {
    return new Map([...explicit.entries()].map(([season, episodes]) => [season, episodes.size] as const));
  }
  const totals = new Map<number, number>();
  if (!Array.isArray(request.seasons)) return totals;
  for (const item of request.seasons) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const seasonNumber = numberField(record.seasonNumber ?? record.season ?? record.number);
    const episodeCount = numberField(record.episodeCount ?? record.episodesCount ?? record.totalEpisodes);
    if (seasonNumber && episodeCount && episodeCount > 0) totals.set(seasonNumber, episodeCount);
  }
  return totals;
}

async function summarizeTvRequestCountsBatch(
  request: {
    id: string;
    mediaType: string;
    title: string;
    year: number | null;
    tmdbId: string | null;
    tvdbId: string | null;
    imdbId: string | null;
    tvShowId?: string | null;
    seasons: Prisma.JsonValue | null;
    episodes: Prisma.JsonValue | null;
  },
  availableByRequest: Map<string, Array<{ season: number | null; episode: number | null }>>,
  downloadingByRequest: Map<string, number>,
  seasonCountsByShow?: Map<string, Map<number, number>>
) {
  const availableEntries = availableByRequest.get(request.id) ?? [];
  const availableCount = availableEntries.length;
  const downloadingCount = downloadingByRequest.get(request.id) ?? 0;
  const explicitRequestedSeasons = requestedSeasons(request.seasons);
  const totalsBySeason = requestedEpisodeTotals(request);
  const seasonNumbersForTotals = totalsBySeason.size > 0
    ? [...totalsBySeason.keys()]
    : explicitRequestedSeasons;
  let resolvedTotalsBySeason: Map<number, number>;
  if (seasonNumbersForTotals.length === 0) {
    resolvedTotalsBySeason = totalsBySeason;
  } else if (request.tvShowId && seasonCountsByShow?.has(request.tvShowId)) {
    const knownBySeason = seasonCountsByShow.get(request.tvShowId) ?? new Map<number, number>();
    resolvedTotalsBySeason = new Map(
      seasonNumbersForTotals.map((seasonNumber) => [
        seasonNumber,
        totalsBySeason.get(seasonNumber) ?? knownBySeason.get(seasonNumber) ?? 0
      ])
    );
  } else {
    resolvedTotalsBySeason = totalsBySeason;
  }

  if (resolvedTotalsBySeason.size === 0) {
    if (explicitRequestedSeasons.length > 0) {
      const availableSeasons = new Set(
        availableEntries
          .map((entry) => entry.season)
          .filter((season): season is number => typeof season === "number")
      );
      const missingSeasonCount = explicitRequestedSeasons.filter((season) => !availableSeasons.has(season)).length;
      return {
        availableCount,
        missingCount: missingSeasonCount,
        downloadingCount,
        hasMissingEpisodes: missingSeasonCount > 0,
        hasAvailableEpisodes: availableCount > 0
      };
    }
    return {
      availableCount,
      missingCount: availableCount > 0 ? 0 : 1,
      downloadingCount,
      hasMissingEpisodes: availableCount === 0,
      hasAvailableEpisodes: availableCount > 0
    };
  }

  const availableBySeason = new Map<number, Set<number>>();
  for (const entry of availableEntries) {
    if (entry.season == null || entry.episode == null) continue;
    const seasonSet = availableBySeason.get(entry.season) ?? new Set<number>();
    seasonSet.add(entry.episode);
    availableBySeason.set(entry.season, seasonSet);
  }

  let missingCount = 0;
  for (const [season, totalEpisodes] of resolvedTotalsBySeason.entries()) {
    const availableEpisodes = availableBySeason.get(season)?.size ?? 0;
    missingCount += Math.max(0, totalEpisodes - availableEpisodes);
  }

  return {
    availableCount,
    missingCount,
    downloadingCount,
    hasMissingEpisodes: missingCount > 0,
    hasAvailableEpisodes: availableCount > 0
  };
}

async function fillMissingSeasonCountsForSummary(
  requests: Array<{
    id: string;
    mediaType: string;
    title: string;
    year: number | null;
    tmdbId: string | null;
    tvdbId: string | null;
    imdbId: string | null;
    tvShowId?: string | null;
    seasons: Prisma.JsonValue | null;
    episodes: Prisma.JsonValue | null;
  }>,
  seasonCountsByShow: Map<string, Map<number, number>>
) {
  const candidates = requests.filter((request) => {
    if (request.mediaType !== "tv" || !request.tvShowId) return false;
    const explicitSeasons = requestedSeasons(request.seasons);
    if (explicitSeasons.length === 0 || requestedEpisodeTotals(request).size > 0) return false;
    const known = seasonCountsByShow.get(request.tvShowId);
    return explicitSeasons.some((seasonNumber) => !known?.get(seasonNumber));
  });
  if (candidates.length === 0) return;

  const settings = await getSettings();
  await mapWithConcurrency(candidates, 3, async (request) => {
    const structure = await fetchSeriesStructure(settings, {
      mediaType: "tv",
      title: request.title,
      year: request.year ?? undefined,
      tmdbId: request.tmdbId ?? undefined,
      tvdbId: request.tvdbId ?? undefined,
      imdbId: request.imdbId ?? undefined
    }).catch(() => undefined);
    if (!structure?.seasons.length || !request.tvShowId) return;
    const requested = new Set(requestedSeasons(request.seasons));
    const known = seasonCountsByShow.get(request.tvShowId) ?? new Map<number, number>();
    for (const season of structure.seasons) {
      if (!requested.has(season.seasonNumber) || !season.episodeCount) continue;
      known.set(season.seasonNumber, season.episodeCount);
      await upsertTvSeason(prisma, {
        tvShowId: request.tvShowId,
        seasonNumber: season.seasonNumber,
        title: season.name ?? `Season ${String(season.seasonNumber).padStart(2, "0")}`,
        airDate: season.airDate ? new Date(season.airDate) : undefined,
        episodeCount: season.episodeCount
      }).catch(() => undefined);
    }
    seasonCountsByShow.set(request.tvShowId, known);
  });
}

export async function listRequests() {
  return listRequestsPage();
}

export async function listRequestsPage(options?: { page?: number; limit?: number; summaryOnly?: boolean }) {
  const page = Math.max(1, options?.page ?? 1);
  const limit = Math.max(1, Math.min(options?.limit ?? 200, 500));
  const skip = (page - 1) * limit;
  const requests = options?.summaryOnly
    ? await prisma.mediaRequest.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          mediaType: true,
          title: true,
          year: true,
          tmdbId: true,
          tvdbId: true,
          imdbId: true,
        status: true,
        requestedBy: true,
        requestedQuality: true,
        selectedProfileId: true,
        externalStatus: true,
        movieId: true,
        tvShowId: true,
        seasonId: true,
        episodeId: true,
        seasons: true,
        episodes: true,
        downloadId: true,
        createdAt: true,
          updatedAt: true,
          ...REQUEST_RELATION_SELECT
        }
      })
    : await prisma.mediaRequest.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          provider: true,
          ...REQUEST_RELATION_SELECT
        }
      });
  const total = await prisma.mediaRequest.count();
  const downloadIds = [...new Set(requests.map((request) => request.downloadId).filter((id): id is string => Boolean(id)))];
  const downloads = downloadIds.length > 0
    ? await prisma.download.findMany({ where: { id: { in: downloadIds } }, select: { id: true, status: true } })
    : [];
  const byId = new Map(downloads.map((download) => [download.id, download]));
  const tvRequestIds = requests.filter((request) => request.mediaType === "tv").map((request) => request.id);
  const tvShowIds = [
    ...new Set(
      requests
        .filter((request) => request.mediaType === "tv")
        .map((request) => request.tvShowId)
        .filter((id): id is string => Boolean(id))
    )
  ];
  const [availableImports, downloadingItems] = tvRequestIds.length > 0 ? await Promise.all([
    prisma.importItem.findMany({
      where: {
        requestId: { in: tvRequestIds },
        mediaType: "tv",
        symlinks: { some: { status: { not: "broken" } } }
      },
      select: { requestId: true, season: true, episode: true }
    }),
    prisma.mediaLibraryItem.findMany({
      where: {
        requestId: { in: tvRequestIds },
        mediaType: "tv",
        libraryStatus: { in: ["requested", "searching", "grabbed"] }
      },
      select: { requestId: true }
    })
  ]) : [[], []];
  const seasonCountsByShow = new Map<string, Map<number, number>>();
  if (tvShowIds.length > 0) {
    const seasons = await prisma.tvSeason.findMany({
      where: { tvShowId: { in: tvShowIds } },
      select: { tvShowId: true, seasonNumber: true, episodeCount: true }
    });
    for (const season of seasons) {
      const bySeason = seasonCountsByShow.get(season.tvShowId) ?? new Map<number, number>();
      bySeason.set(season.seasonNumber, season.episodeCount ?? 0);
      seasonCountsByShow.set(season.tvShowId, bySeason);
    }
  }
  await fillMissingSeasonCountsForSummary(requests, seasonCountsByShow);
  const availableByRequest = new Map<string, Array<{ season: number | null; episode: number | null }>>();
  for (const item of availableImports) {
    const key = item.requestId;
    if (!key) continue;
    const bucket = availableByRequest.get(key) ?? [];
    bucket.push({ season: item.season, episode: item.episode });
    availableByRequest.set(key, bucket);
  }
  const downloadingByRequest = new Map<string, number>();
  for (const item of downloadingItems) {
    const key = item.requestId;
    if (!key) continue;
    downloadingByRequest.set(key, (downloadingByRequest.get(key) ?? 0) + 1);
  }
  const items = (await Promise.all(requests.map(async (request) => ({
    ...hydrateLegacyRequestFields(request),
    download: request.downloadId ? byId.get(request.downloadId) ?? null : null,
    monitorSummary: request.mediaType === "tv"
      ? await summarizeTvRequestCountsBatch(request, availableByRequest, downloadingByRequest, seasonCountsByShow)
      : null
  })))).map((request) => ({
    ...request,
    status: effectiveRequestStatus({
      request,
      downloadStatus: request.download?.status ?? null,
      monitorSummary: request.monitorSummary
    })
  }));
  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit))
  };
}

export async function getRequestMonitor(id: string) {
  const request = await getRequest(id);
  const requestTitleClauses = titleSearchClauses(request.title);
  const availableImports = await prisma.importItem.findMany({
    where: {
      OR: [
        { requestId: request.id },
        {
          mediaType: request.mediaType,
          year: request.year ?? undefined,
          ...(request.mediaType === "movie" ? { season: null, episode: null } : {}),
          OR: requestTitleClauses
        }
      ],
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

  const requestedSeasonNumbers = await monitoredSeasonNumbersForRequest(request, structure);
  const requestedEpisodes = requestedEpisodesBySeason(request.episodes);
  const activeDownloads = await prisma.download.findMany({
    where: {
      status: { in: TV_ACTIVE_DOWNLOAD_STATUSES },
      OR: titleSearchClauses(request.title)
    },
    select: { title: true }
  });

  const availableBySeason = new Map<number, Set<number>>();
  const importIds = availableImports.map((item) => item.id);
  const libraryItems = await prisma.mediaLibraryItem.findMany({
    where: {
      OR: [
        { requestId: request.id },
        ...(importIds.length > 0 ? [{ sourceKey: { in: importIds.map((importId) => `import:${importId}`) } }] : [])
      ]
    },
    select: {
      id: true,
      mediaType: true,
      season: true,
      episode: true,
      symlinkPath: true,
      strmPath: true,
      filePath: true
    }
  });
  const libraryItemByEpisode = new Map<string, { id: string; subtitleLanguages: string[] }>();
  await Promise.all(libraryItems.map(async (item) => {
    if (item.season == null || item.episode == null) return;
    libraryItemByEpisode.set(`${item.season}:${item.episode}`, {
      id: item.id,
      subtitleLanguages: await subtitleLanguagesForItem(item).catch(() => [])
    });
  }));
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

  const availableSeasonNumbers = [...availableBySeason.keys()].filter((seasonNumber) => seasonNumber > 0);
  const downloadingSeasonNumbers = [...downloadingBySeason.keys()].filter((seasonNumber) => seasonNumber > 0);
  const relevantSeasonNumbers = [...new Set([
    ...requestedSeasonNumbers,
    ...availableSeasonNumbers,
    ...downloadingSeasonNumbers
  ])].sort((left, right) => left - right);
  const seasonDefs = structure?.seasons.length
    ? structure.seasons.filter((season) => relevantSeasonNumbers.length === 0 || relevantSeasonNumbers.includes(season.seasonNumber))
    : relevantSeasonNumbers.map((seasonNumber) => ({
        seasonNumber,
        name: `Season ${String(seasonNumber).padStart(2, "0")}`,
        episodeCount: Math.max(
          ...[
            ...(requestedEpisodes.get(seasonNumber) ?? new Set<number>()),
            ...(availableBySeason.get(seasonNumber) ?? new Set<number>()),
            ...(downloadingBySeason.get(seasonNumber) ?? new Set<number>())
          ],
          0
        ),
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
        const status = available ? "available" : downloading ? "downloading" : "missing_monitored";
        const libraryItem = libraryItemByEpisode.get(`${season.seasonNumber}:${episodeNumber}`);
        return {
          episodeNumber,
          title: episodeNameByNumber.get(episodeNumber),
          airDate: episodeAirDateByNumber.get(episodeNumber),
          monitored,
          available,
          downloading,
          status,
          libraryItemId: libraryItem?.id,
          subtitleLanguages: libraryItem?.subtitleLanguages ?? []
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

export async function shouldAutoGrabSyncedRequest(request: MediaRequest) {
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


export function setRequestStatus(id: string, status: string) {
  return prisma.mediaRequest.update({ where: { id }, data: { status } });
}

export async function setRequestProfile(id: string, profileId: string) {
  const current = await prisma.mediaRequest.findUniqueOrThrow({
    where: { id },
    select: { id: true, mediaType: true }
  });
  const profile = await resolveProfile(profileId, current.mediaType);
  await prisma.mediaRequest.update({
    where: { id },
    data: {
      selectedProfileId: profile.id,
      requestedQuality: profile.name
    }
  });
  await refreshLibraryRequestRows([id]).catch(() => undefined);
  return getRequest(id);
}

export async function searchForRequest(id: string, options?: { cachedOnly?: boolean; limit?: number; recordHistory?: boolean; skipFallback?: boolean; cacheResult?: boolean }) {
  const request = await getRequest(id);
  const useRequestCache = options?.cacheResult !== false;
  const cached = useRequestCache ? await cachedRequestReleases(request) : null;
  if (cached) return { request, releases: cached };
  const monitoredSeasons = await monitoredSeasonNumbersForRequest(request);
  const season = requestedEpisodesBySeason(request.episodes).size > 0 ? monitoredSeasons[0] : undefined;
  const releases = await runSearch({
    kind: request.mediaType === "tv" && season ? "season" : request.mediaType === "tv" ? "tv" : "movie",
    query: request.title,
    imdbId: request.imdbId ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined,
    season,
    limit: options?.limit,
    recordHistory: options?.recordHistory,
    skipFallback: options?.skipFallback,
    cachedOnly: options?.cachedOnly
  });
  if (useRequestCache) await cacheRequestReleases(request, releases);
  return { request, releases };
}

function requestReleaseCacheKey(request: MediaRequest) {
  return `request:release-cache:${request.id}:${Buffer.from(JSON.stringify({
    mediaType: request.mediaType,
    title: request.title,
    imdbId: request.imdbId,
    tmdbId: request.tmdbId,
    tvdbId: request.tvdbId,
    selectedProfileId: request.selectedProfileId,
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

export function requestedSeasons(value: Prisma.JsonValue | null | undefined) {
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

export async function monitoredSeasonNumbersForRequest(
  request: Pick<MediaRequest, "title" | "year" | "tmdbId" | "tvdbId" | "imdbId" | "seasons" | "episodes" | "mediaType">,
  structure?: Awaited<ReturnType<typeof fetchSeriesStructure>>
) {
  const explicitRequestedSeasons = requestedSeasons(request.seasons);
  if (request.mediaType !== "tv") return explicitRequestedSeasons;
  const explicitRequestedEpisodes = requestedEpisodesBySeason(request.episodes);
  if (explicitRequestedEpisodes.size > 0 || explicitRequestedSeasons.length > 0) return explicitRequestedSeasons;
  const resolvedStructure = structure ?? await getSettings()
    .then((settings) => fetchSeriesStructure(settings, {
      mediaType: "tv",
      title: request.title,
      year: request.year ?? undefined,
      tmdbId: request.tmdbId ?? undefined,
      tvdbId: request.tvdbId ?? undefined,
      imdbId: request.imdbId ?? undefined
    }))
    .catch(() => undefined);
  const fullSeriesSeasons = resolvedStructure?.seasons
    .filter((season) => season.seasonNumber > 0)
    .map((season) => season.seasonNumber) ?? [];
  return fullSeriesSeasons.length > 0 ? fullSeriesSeasons : explicitRequestedSeasons;
}

export async function rankReleasesForRequest(id: string) {
  const request = await getRequest(id);
  const settings = await getSettings();
  const configuredProfileId =
    request.selectedProfileId ??
    (request.mediaType === "tv" ? request.provider?.defaultTvProfile ?? settings.defaultTvProfile : request.provider?.defaultMovieProfile ?? settings.defaultMovieProfile);
  const profile = await resolveProfile(configuredProfileId, request.mediaType);
  const rejectAmbiguousAnime = request.mediaType === "tv" && Boolean(request.year);
  const { releases } = await searchForRequest(id);
  const ranked = await Promise.all(
    releases.map(async (release) => ({
      release,
      decision: (await isReleaseBlocklisted(release))
        ? { ...scoreReleaseForRequest(request, release, profile, { rejectAmbiguousAnime }), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
        : scoreReleaseForRequest(request, release, profile, { rejectAmbiguousAnime })
    }))
  );
  const accepted = ranked.filter((item) => item.decision.accepted).sort((a, b) => b.decision.score - a.decision.score);
  return { request, profile, releases: accepted, rejectedCount: ranked.length - accepted.length };
}

export async function rankTvEpisodeForRequest(id: string, season: number, episode: number) {
  const request = await getRequest(id);
  if (request.mediaType !== "tv") throw new Error("request is not a TV request");
  const settings = await getSettings();
  const configuredProfileId = request.selectedProfileId ?? request.provider?.defaultTvProfile ?? settings.defaultTvProfile;
  const profile = await resolveProfile(configuredProfileId, request.mediaType);
  const rejectAmbiguousAnime = Boolean(request.year);
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
        ? { ...scoreReleaseForRequest(request, release, profile, { rejectAmbiguousAnime }), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
        : scoreReleaseForRequest(request, release, profile, { rejectAmbiguousAnime })
    }))
  );
  const accepted = ranked.filter((item) => item.decision.accepted).sort((a, b) => b.decision.score - a.decision.score);
  return { request, profile, releases: accepted, rejectedCount: ranked.length - accepted.length };
}

export async function grabTvEpisodeForRequest(id: string, season: number, episode: number) {
  const request = await getRequest(id);
  if (request.mediaType !== "tv") throw new Error("request is not a TV request");
  const existingEpisodes = await existingEpisodesForSeason(request.id, request.title, season);
  if (existingEpisodes.has(episode)) {
    return { grabbed: false, reason: "episode already available or downloading", season, episode };
  }
  const result = await grabBestTvSeasonForRequest(request, season, existingEpisodes, new Set([episode]));
  await refreshLibraryRequestRows([id]).catch(() => undefined);
  return { season, episode, ...result };
}

export async function grabBestForRequest(id: string, options?: { priorityBoost?: number; cachedOnly?: boolean; searchLimit?: number; skipFallback?: boolean; recordHistory?: boolean; cacheResult?: boolean }) {
  type RankedCandidate = RequestPipelineCandidate<{
    release: Parameters<typeof scoreRelease>[0];
    decision: ReturnType<typeof scoreRelease>;
  }>;

  return runRequestGrabPipeline<RankedCandidate>({
    maxAttempts: MOVIE_NZB_FETCH_ATTEMPTS_PER_PASS,
    handlers: {
      checkExisting: async () => {
        const request = await getRequest(id);
        const workingImport = await findWorkingImportForRequest(request);
        if (workingImport) {
          await prisma.mediaRequest.update({ where: { id }, data: { status: "available", downloadId: workingImport.downloadId } });
          await refreshLibraryRequestRows([id]).catch(() => undefined);
          return { grabbed: false, reason: "a working library item already exists", import: workingImport };
        }
        const existingDownload = await existingActiveDownload(request.downloadId);
        if (existingDownload) {
          if (options?.priorityBoost && existingDownload.status !== "downloading") {
            await promoteDownloadPriority(existingDownload.id, options.priorityBoost).catch(() => undefined);
          }
          return { grabbed: true, reason: "request already has an active download", download: existingDownload };
        }
        if (await requestGrabCoolingDown(id)) {
          return { grabbed: false, reason: "request search cooling down after recent failed grab attempt" };
        }
        return null;
      },
      loadCandidates: async () => {
        const request = await getRequest(id);
        const settings = await getSettings();
        const configuredProfileId =
          request.selectedProfileId ??
          (request.mediaType === "tv" ? request.provider?.defaultTvProfile ?? settings.defaultTvProfile : request.provider?.defaultMovieProfile ?? settings.defaultMovieProfile);
        const profile = await resolveProfile(configuredProfileId, request.mediaType);
        const rejectAmbiguousAnime = request.mediaType === "tv" && Boolean(request.year);
        const { releases } = await searchForRequest(id, {
          cachedOnly: options?.cachedOnly,
          limit: options?.searchLimit,
          recordHistory: options?.recordHistory,
          skipFallback: options?.skipFallback,
          cacheResult: options?.cacheResult
        });
        const scored = await Promise.all(
          releases.map(async (release) => ({
            release,
            decision: (await isReleaseBlocklisted(release))
              ? { ...scoreReleaseForRequest(request, release, profile, { rejectAmbiguousAnime }), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
              : scoreReleaseForRequest(request, release, profile, { rejectAmbiguousAnime })
          }))
        );
        const ranked = scored.filter((item) => item.decision.accepted).sort((a, b) => b.decision.score - a.decision.score);
        if (ranked.length > 0) return { candidates: ranked };
        if (options?.cachedOnly) {
          return { terminal: { grabbed: false, reason: "no acceptable cached release found", releases: ranked } };
        }
        await markRequestGrabCooldown(id).catch(() => undefined);
        await prisma.mediaRequest.update({ where: { id }, data: { status: "no_release_found" } });
        await refreshLibraryRequestRows([id]).catch(() => undefined);
        return { terminal: { grabbed: false, reason: "no acceptable release found", releases: ranked } };
      },
      tryCandidate: async (candidate) => {
        const reusable = await reuseExistingReleaseDownload(id, candidate.release);
        if (reusable) {
          return { grabbed: true, reason: "reused existing download", release: candidate.release, decision: candidate.decision, download: reusable, reused: true, attemptedFetch: false };
        }
        const settings = await getSettings();
        let download: Awaited<ReturnType<typeof addNzbFromPath>>;
        try {
          const nzb = await downloadNzb(settings, candidate.release);
          download = await addNzbFromPath(nzb.primaryPath, candidate.release.title, {
            guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
            requestId: id,
            priority: options?.priorityBoost
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed to fetch or import NZB";
          const blocklisted = await maybeBlocklistGrabFailure({
            guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
            title: candidate.release.title,
            reason: message,
            source: "grab-validation",
            release: candidate.release
          });
          return {
            grabbed: false,
            reason: `${candidate.release.title}: ${message}`,
            transient: !blocklisted,
            retryableFailure: !blocklisted,
            attemptedFetch: true
          };
        }
        if (download.status === "failed") {
          const blocklisted = await maybeBlocklistGrabFailure({
            guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
            title: candidate.release.title,
            reason: download.error,
            source: "grab-validation",
            release: candidate.release
          });
          return {
            grabbed: false,
            reason: `${candidate.release.title}: ${download.error ?? "failed before queueing"}`,
            download,
            transient: !blocklisted,
            retryableFailure: !blocklisted,
            attemptedFetch: true
          };
        }
        await prisma.mediaRequest.update({
          where: { id },
          data: { status: requestStatusForDownloadStatus(download.status), selectedRelease: jsonValue(candidate.release), downloadId: download.id }
        });
        await refreshLibraryRequestRows([id]).catch(() => undefined);
        return { grabbed: true, reason: "release queued", release: candidate.release, decision: candidate.decision, download, attemptedFetch: true };
      },
      onExhausted: async ({ rejected }) => {
        await markRequestGrabCooldown(id).catch(() => undefined);
        if (options?.cachedOnly) {
          return { grabbed: false, reason: "all acceptable cached releases failed before queueing", rejected };
        }
        await prisma.mediaRequest.update({ where: { id }, data: { status: "no_release_found", downloadId: null } });
        await refreshLibraryRequestRows([id]).catch(() => undefined);
        return { grabbed: false, reason: "all acceptable releases failed before queueing", rejected };
      }
    }
  });
}

export async function grabMissingTvForRequest(id: string, options?: { priorityBoost?: number; cachedOnly?: boolean; searchLimit?: number; skipFallback?: boolean; recordHistory?: boolean; cacheResult?: boolean }) {
  return runTvRequestGrabPipeline<
    MediaRequest & { provider?: RequestProvider | null },
    Parameters<typeof scoreRelease>[0],
    { season: number; existingEpisodes: Set<number>; requestedSeasonEpisodes?: Set<number> },
    Awaited<ReturnType<typeof grabBestTvSeasonForRequest>>
  >({
    handlers: {
      loadRequest: async () => getRequest(id),
      prepare: async (request) => {
        if (request.mediaType !== "tv") {
          return { terminal: await grabBestForRequest(id, options), seasonsNeedingSearch: [] };
        }
        const seasons = await monitoredSeasonNumbersForRequest(request);
        if (seasons.length === 0) {
          return { terminal: await grabBestForRequest(id, options), seasonsNeedingSearch: [] };
        }
        const requestedEpisodes = requestedEpisodesBySeason(request.episodes);
        const seasonEpisodeCounts = await requestedSeasonEpisodeCounts(request, seasons);
        const seasonsNeedingSearch: Array<{ season: number; existingEpisodes: Set<number>; requestedSeasonEpisodes?: Set<number> }> = [];
        for (const season of seasons) {
          if (await hasActiveSeasonPackDownload(request.title, season)) continue;
          const existingEpisodes = await existingEpisodesForSeason(request.id, request.title, season);
          const requestedSeasonEpisodes = requestedEpisodes.get(season);
          const knownEpisodeCount = seasonEpisodeCounts.get(season) ?? 0;
          if (requestedSeasonEpisodes && requestedSeasonEpisodes.size > 0 && [...requestedSeasonEpisodes].every((episode) => existingEpisodes.has(episode))) continue;
          if ((!requestedSeasonEpisodes || requestedSeasonEpisodes.size === 0) && knownEpisodeCount > 0 && existingEpisodes.size >= knownEpisodeCount) continue;
          if ((!requestedSeasonEpisodes || requestedSeasonEpisodes.size === 0) && knownEpisodeCount === 0 && existingEpisodes.size > 0) continue;
          seasonsNeedingSearch.push({ season, existingEpisodes, requestedSeasonEpisodes });
        }
        if (seasonsNeedingSearch.length === 0) {
          await setTvMonitorCursor(request.id, null).catch(() => undefined);
          await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "available" } }).catch(() => undefined);
          await refreshLibraryRequestRows([request.id]).catch(() => undefined);
          return {
            terminal: { grabbed: false, reason: "all requested episodes already available", seasons: [] },
            seasonsNeedingSearch: []
          };
        }
        const seasonSlice = await takeMonitoredSeasonSlice(request.id, seasonsNeedingSearch);
        return {
          seasonsNeedingSearch: seasonSlice
        };
      },
      loadBroadReleases: async (request) =>
        runSearch({
          kind: "tv",
          query: request.title,
          imdbId: request.imdbId ?? undefined,
          tmdbId: request.tmdbId ?? undefined,
          tvdbId: request.tvdbId ?? undefined,
          limit: options?.searchLimit,
          recordHistory: options?.recordHistory,
          skipFallback: options?.skipFallback,
          cachedOnly: options?.cachedOnly
        }).catch(() => []),
      processSeason: async ({ request, season, broadReleases }) =>
        grabBestTvSeasonForRequest(request, season.season, season.existingEpisodes, season.requestedSeasonEpisodes, broadReleases, options),
      finalize: async ({ request, seasonResults, totalSeasonsNeedingSearch }) => {
        const results = seasonResults.map((item) => ({ season: item.season.season, result: item.result }));
        const grabbedResults = results.filter((item) => item.result.grabbed);
        const grabbedDownloadId = downloadIdFromTvGrabResults(grabbedResults as Array<{ result: { queued?: Array<{ download?: { id?: string } }>; download?: { id?: string } } }>);
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
        if (!hasMissingEpisodes) await setTvMonitorCursor(request.id, null).catch(() => undefined);
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
                    : options?.cachedOnly
                      ? "approved"
                      : "no_release_found",
            downloadId: activeDownloadId
          }
        });
        await refreshLibraryRequestRows([request.id]).catch(() => undefined);
        return {
          grabbed: grabbedResults.length > 0,
          seasons: results,
          remainingSeasonSearches: Math.max(0, totalSeasonsNeedingSearch - seasonResults.length)
        };
      }
    }
  });
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

export async function existingEpisodesForSeason(requestId: string, title: string, season: number) {
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

export async function findWorkingImportForRequest(request: MediaRequest) {
  const direct = await prisma.importItem.findFirst({
    where: {
      requestId: request.id,
      symlinks: { some: { status: { not: "broken" } } }
    },
    include: { symlinks: { orderBy: { updatedAt: "desc" } } },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
  });
  if (direct) return direct;

  const requestTitleClauses = titleSearchClauses(request.title);
  const candidates = await prisma.importItem.findMany({
    where: {
      mediaType: request.mediaType,
      year: request.year ?? undefined,
      ...(request.mediaType === "movie" ? { season: null, episode: null } : {}),
      symlinks: { some: { status: { not: "broken" } } },
      OR: requestTitleClauses
    },
    include: { symlinks: { orderBy: { updatedAt: "desc" } } },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: 50
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
  releasePool?: Parameters<typeof scoreRelease>[0][],
  options?: { priorityBoost?: number; cachedOnly?: boolean; searchLimit?: number; skipFallback?: boolean; recordHistory?: boolean; cacheResult?: boolean }
) {
  type Candidate = { release: Parameters<typeof scoreRelease>[0]; decision: ReturnType<typeof scoreRelease> };
  return runTvSeasonGrabPipeline<
    {
      profile: Awaited<ReturnType<typeof resolveProfile>>;
      rejectAmbiguousAnime: boolean;
      eligibleRequestedEpisodes?: Set<number>;
      seasonEpisodeCount?: number;
      releases: Parameters<typeof scoreRelease>[0][];
    },
    Parameters<typeof scoreRelease>[0],
    Candidate
  >({
    handlers: {
      checkCooldown: async () =>
        (await seasonSearchCoolingDown(request.id, season))
          ? { grabbed: false, reason: "season search cooling down after recent unsuccessful attempt", queued: [], rejected: [] }
          : null,
      prepare: async () => {
        const settings = await getSettings();
        const configuredProfileId = request.selectedProfileId ?? request.provider?.defaultTvProfile ?? settings.defaultTvProfile;
        const profile = await resolveProfile(configuredProfileId, request.mediaType);
        const rejectAmbiguousAnime = Boolean(request.year);
        const explicitRequestedEpisodes = requestedEpisodes;
        const explicitSeasonEpisodeCount = Array.isArray(request.seasons)
          ? request.seasons.flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const record = item as Record<string, unknown>;
              const seasonNumber = numberField(record.seasonNumber ?? record.season ?? record.number);
              const episodeCount = numberField(record.episodeCount ?? record.episodesCount ?? record.totalEpisodes);
              return seasonNumber === season && episodeCount ? [episodeCount] : [];
            })[0]
          : undefined;
        if (options?.cachedOnly) {
          return {
            profile,
            rejectAmbiguousAnime,
            eligibleRequestedEpisodes: explicitRequestedEpisodes,
            seasonEpisodeCount: explicitRequestedEpisodes?.size ?? explicitSeasonEpisodeCount,
            releases: []
          };
        }
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
        const eligibleRequestedEpisodes = explicitRequestedEpisodes && explicitRequestedEpisodes.size > 0
          ? airedEpisodes.size > 0 ? intersectEpisodes(explicitRequestedEpisodes, airedEpisodes) : explicitRequestedEpisodes
          : airedEpisodes.size > 0 ? airedEpisodes : undefined;
        const seasonEpisodeCount = eligibleRequestedEpisodes?.size ?? seriesStructure?.seasons.find((item) => item.seasonNumber === season)?.episodeCount;
        return {
          profile,
          rejectAmbiguousAnime,
          eligibleRequestedEpisodes,
          seasonEpisodeCount,
          releases: []
        };
      },
      loadReleases: async (prepared) => {
        if (prepared.eligibleRequestedEpisodes && prepared.eligibleRequestedEpisodes.size === 0) return [];
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
              season,
              limit: options?.searchLimit,
              recordHistory: options?.recordHistory,
              skipFallback: options?.skipFallback,
              cachedOnly: options?.cachedOnly
            });
        prepared.releases = releases;
        return releases;
      },
      scoreReleases: async (prepared, releases) => {
        const scored = await Promise.all(
          releases.map(async (release) => ({
            release,
            decision: (await isReleaseBlocklisted(release))
              ? { ...scoreReleaseForRequest(request, release, prepared.profile, { rejectAmbiguousAnime: prepared.rejectAmbiguousAnime }), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
              : scoreReleaseForRequest(request, release, prepared.profile, { rejectAmbiguousAnime: prepared.rejectAmbiguousAnime })
          }))
        );
        const accepted = scored.filter((item) => item.decision.accepted).sort((a, b) => b.decision.score - a.decision.score);
        return {
          accepted,
          seasonPacks: accepted.filter((item) => isSeasonPackTitle(item.release.title, season))
        };
      },
      processSeasonPacks: async ({ prepared, seasonPacks }) => {
        const queued: Array<Awaited<ReturnType<typeof queueReleaseForRequest>>> = [];
        const rejected: string[] = [];
        let nzbFetchAttempts = 0;
        for (const candidate of seasonPacks) {
          const result = await queueReleaseForRequest(request.id, candidate, options);
          if (result.attemptedFetch) nzbFetchAttempts += 1;
          if (result.grabbed) {
            queued.push(result);
            return {
              terminal: { grabbed: true, mode: "season_pack", queued, rejected } satisfies TvSeasonGrabResult,
              queued,
              rejected,
              attemptedFetches: nzbFetchAttempts
            };
          }
          rejected.push(`${candidate.release.title}: ${result.reason ?? "failed before queueing"}`);
          if (result.retryableFailure) {
            rejected.push("season pass cooling down after temporary NZB fetch failure");
            await markSeasonSearchCooldown(request.id, season);
            return {
              terminal: { grabbed: false, reason: result.reason ?? "temporary NZB fetch failure", queued, rejected, transient: true },
              queued,
              rejected,
              attemptedFetches: nzbFetchAttempts
            };
          }
          if (nzbFetchAttempts >= TV_NZB_FETCH_ATTEMPTS_PER_SEASON_PASS) {
            rejected.push(`stopped after ${TV_NZB_FETCH_ATTEMPTS_PER_SEASON_PASS} NZB fetch attempt for this season pass; retry rotates next cycle`);
            await markSeasonSearchCooldown(request.id, season);
            return {
              terminal: { grabbed: false, reason: "season pass cooling down after failed grab attempt", queued, rejected },
              queued,
              rejected,
              attemptedFetches: nzbFetchAttempts
            };
          }
        }
        if (prepared.eligibleRequestedEpisodes && prepared.eligibleRequestedEpisodes.size === 0) {
          return {
            terminal: { grabbed: false, reason: "no aired monitored episodes need search", queued, rejected },
            queued,
            rejected,
            attemptedFetches: nzbFetchAttempts
          };
        }
        return { queued, rejected, attemptedFetches: nzbFetchAttempts };
      },
      searchEpisodes: async ({ prepared, accepted }) => {
        const episodeCandidates = bestEpisodeCandidates(accepted, season, existingEpisodes, prepared.eligibleRequestedEpisodes);
        const coveredEpisodes = episodesFromCandidates(episodeCandidates, season);
        const remainingExistingEpisodes = new Set([...existingEpisodes, ...coveredEpisodes]);
        const separatelySearchedEpisodes = await searchEpisodesForSeason(
          request,
          season,
          prepared.profile,
          remainingExistingEpisodes,
          prepared.eligibleRequestedEpisodes,
          prepared.seasonEpisodeCount,
          prepared.releases,
          options
        );
        return [...episodeCandidates, ...separatelySearchedEpisodes];
      },
      processEpisodeCandidates: async ({ prepared, episodeCandidates, queued, rejected, attemptedFetches }) => {
        let nzbFetchAttempts = attemptedFetches;
        const nextQueued = [...queued] as Array<Awaited<ReturnType<typeof queueReleaseForRequest>>>;
        const nextRejected = [...rejected];
        for (const candidate of episodeCandidates) {
          if (nextQueued.length >= TV_EPISODE_DOWNLOADS_PER_REQUEST_PASS) {
            nextRejected.push(`stopped after ${TV_EPISODE_DOWNLOADS_PER_REQUEST_PASS} queued episode candidates; remaining episodes rotate next monitor pass`);
            break;
          }
          if (nzbFetchAttempts >= TV_NZB_FETCH_ATTEMPTS_PER_SEASON_PASS) {
            nextRejected.push(`stopped after ${TV_NZB_FETCH_ATTEMPTS_PER_SEASON_PASS} NZB fetch attempt for this season pass; retry rotates next cycle`);
            break;
          }
          const result = await queueReleaseForRequest(request.id, candidate, options);
          if (result.attemptedFetch) nzbFetchAttempts += 1;
          if (result.grabbed) nextQueued.push(result);
          else nextRejected.push(`${candidate.release.title}: ${result.reason ?? "failed before queueing"}`);
          if (!result.grabbed && result.retryableFailure) {
            nextRejected.push("season pass cooling down after temporary NZB fetch failure");
            await markSeasonSearchCooldown(request.id, season);
            return { grabbed: false, reason: result.reason ?? "temporary NZB fetch failure", queued: nextQueued, rejected: nextRejected, transient: true };
          }
          if (!result.grabbed && result.attemptedFetch && nzbFetchAttempts >= TV_NZB_FETCH_ATTEMPTS_PER_SEASON_PASS) {
            nextRejected.push("season pass cooling down after failed grab attempt");
            break;
          }
        }
        if (nextQueued.length > 0) {
          return {
            grabbed: true,
            mode: prepared.releases.some((release) => isSeasonPackTitle(release.title, season)) ? "episodes_after_season_pack_failure" : "episodes",
            queued: nextQueued,
            rejected: nextRejected
          };
        }
        if (!options?.cachedOnly) await markSeasonSearchCooldown(request.id, season);
        return {
          grabbed: false,
          reason: options?.cachedOnly
            ? prepared.releases.some((release) => isSeasonPackTitle(release.title, season))
              ? "all acceptable cached season packs and episode releases failed before queueing"
              : "no acceptable cached season or episode release found"
            : prepared.releases.some((release) => isSeasonPackTitle(release.title, season))
              ? "all season packs and episode releases failed before queueing"
              : "no acceptable season or episode release found",
          queued: nextQueued,
          rejected: nextRejected
        };
      },
      buildNoCandidateResult: async (prepared) => {
        if (prepared.eligibleRequestedEpisodes && prepared.eligibleRequestedEpisodes.size === 0) {
          return { grabbed: false, reason: "no aired monitored episodes need search", queued: [], rejected: [] };
        }
        if (!options?.cachedOnly) await markSeasonSearchCooldown(request.id, season);
        return {
          grabbed: false,
          reason: options?.cachedOnly ? "no acceptable cached season or episode release found" : "no acceptable season or episode release found",
          queued: [],
          rejected: []
        };
      }
    }
  });
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
  releasePool?: Parameters<typeof scoreRelease>[0][],
  options?: { cachedOnly?: boolean; searchLimit?: number; skipFallback?: boolean; recordHistory?: boolean; cacheResult?: boolean }
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
  const batchSize = options?.searchLimit
    ? options.searchLimit <= 40
      ? 1
      : 2
    : 4;
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
        : options?.cachedOnly
          ? []
        : await runSearch({
            kind: "episode",
            query: request.title,
            imdbId: request.imdbId ?? undefined,
            tmdbId: request.tmdbId ?? undefined,
            tvdbId: request.tvdbId ?? undefined,
            season,
            episode,
            limit: options?.searchLimit,
            recordHistory: options?.recordHistory ?? false,
            skipFallback: options?.skipFallback
          });
      const scored = await Promise.all(
        releases.map(async (release) => ({
          release,
          decision: (await isReleaseBlocklisted(release))
            ? { ...scoreReleaseForRequest(request, release, profile, { rejectAmbiguousAnime: Boolean(request.year) }), accepted: false, score: -1000, reasons: ["release is blocklisted"] }
            : scoreReleaseForRequest(request, release, profile, { rejectAmbiguousAnime: Boolean(request.year) })
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

export function requestedEpisodesBySeason(value: Prisma.JsonValue | null | undefined) {
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

export function numberField(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function titleSearchClauses(title: string) {
  const baseTitle = title.split(":")[0] ?? title;
  return [
    { title: { contains: baseTitle, mode: "insensitive" as const } },
    { title: { contains: baseTitle.replaceAll(" ", "."), mode: "insensitive" as const } }
  ];
}

function isSeasonPackTitle(title: string, season: number) {
  const parsed = parseReleaseTitle(title);
  return parsed.season === season && parsed.isSeasonPack;
}

function releaseBelongsToSeason(title: string, season: number) {
  const parsed = parseReleaseTitle(title);
  return parsed.season === season || titleCoversSeason(title, season) || episodePattern(season).test(title);
}

function releaseBelongsToEpisode(title: string, season: number, episode: number) {
  const parsed = parseReleaseTitle(title);
  if (parsed.season === season && parsed.episode === episode) return true;
  if (parsed.season === season && parsed.isMultiEpisode && parsed.episode && parsed.episodeEnd) {
    return episode >= parsed.episode && episode <= parsed.episodeEnd;
  }
  return episodesCoveredByTitle(title, season).has(episode);
}

export function episodeNumberFromTitle(title: string, season: number) {
  const parsed = parseReleaseTitle(title);
  if (parsed.season === season && parsed.episode) return parsed.episode;
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
  const episodePart = episode ? `0?${episode}` : "\\d{1,4}";
  return new RegExp(`(?:\\bS0?${season}E(?<episode>${episodePart})(?:\\b|E\\d{1,4}|[- .]?E?\\d{1,4}\\b)|\\b0?${season}x(?<episode_x>${episodePart})\\b)`, "i");
}

function episodesCoveredByTitle(title: string, season: number) {
  const episodes = new Set<number>();
  const single = title.match(new RegExp(`\\bS0?${season}E(?<episode>\\d{1,4})\\b`, "i"));
  if (single?.groups?.episode) episodes.add(Number(single.groups.episode));

  const oneBy = title.match(new RegExp(`\\b0?${season}x(?<episode>\\d{1,4})\\b`, "i"));
  if (oneBy?.groups?.episode) episodes.add(Number(oneBy.groups.episode));

  const multi = title.match(new RegExp(`\\bS0?${season}E(?<first>\\d{1,4})(?<rest>(?:E\\d{1,4})+)\\b`, "i"));
  if (multi?.groups?.first && multi.groups.rest) {
    episodes.add(Number(multi.groups.first));
    for (const match of multi.groups.rest.matchAll(/E(\d{1,4})/gi)) episodes.add(Number(match[1]));
  }

  const range = title.match(new RegExp(`\\bS0?${season}E(?<start>\\d{1,4})[- .]?E?(?<end>\\d{1,4})\\b`, "i"));
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

function requestGrabCooldownKey(requestId: string) {
  return `request:grab-cooldown:${requestId}`;
}

function wantedSearchCooldownKey(requestId: string) {
  return `request:wanted-search-cooldown:${requestId}`;
}

function tvMonitorCursorKey(requestId: string) {
  return `request-monitor.tv.next-season:${requestId}`;
}

async function getTvMonitorCursor(requestId: string) {
  const key = tvMonitorCursorKey(requestId);
  const cached = tvMonitorCursorCache.get(key);
  if (cached !== undefined) return cached;
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  const value = row?.value as { nextSeason?: unknown } | undefined;
  const nextSeason = typeof value?.nextSeason === "number" && Number.isFinite(value.nextSeason) && value.nextSeason > 0
    ? Math.floor(value.nextSeason)
    : null;
  tvMonitorCursorCache.set(key, nextSeason, 5 * 60 * 1000);
  return nextSeason;
}

async function setTvMonitorCursor(requestId: string, nextSeason: number | null) {
  const key = tvMonitorCursorKey(requestId);
  tvMonitorCursorCache.set(key, nextSeason, 5 * 60 * 1000);
  if (!nextSeason) {
    await prisma.setting.delete({ where: { key } }).catch(() => undefined);
    return;
  }
  await prisma.setting.upsert({
    where: { key },
    update: { value: { nextSeason } },
    create: { key, value: { nextSeason } }
  });
}

export function rotateMonitoredSeasonSlice<T extends { season: number }>(
  seasonsNeedingSearch: T[],
  nextSeason: number | null | undefined,
  limit = TV_SEASONS_PER_MONITOR_PASS
) {
  if (seasonsNeedingSearch.length <= limit) {
    return {
      slice: seasonsNeedingSearch,
      nextCursor: seasonsNeedingSearch.length === 0 ? null : seasonsNeedingSearch[0]?.season ?? null
    };
  }

  const startIndex = nextSeason
    ? Math.max(0, seasonsNeedingSearch.findIndex((item) => item.season >= nextSeason))
    : 0;
  const rotated = [
    ...seasonsNeedingSearch.slice(startIndex),
    ...seasonsNeedingSearch.slice(0, startIndex)
  ];
  const slice = rotated.slice(0, limit);
  const remaining = rotated.slice(limit);
  return {
    slice,
    nextCursor: remaining[0]?.season ?? slice[0]?.season ?? null
  };
}

async function takeMonitoredSeasonSlice(
  requestId: string,
  seasonsNeedingSearch: Array<{ season: number; existingEpisodes: Set<number>; requestedSeasonEpisodes?: Set<number> }>
) {
  const nextSeason = await getTvMonitorCursor(requestId);
  const { slice, nextCursor } = rotateMonitoredSeasonSlice(seasonsNeedingSearch, nextSeason);
  await setTvMonitorCursor(requestId, nextCursor);
  return slice;
}

async function seasonSearchCoolingDown(requestId: string, season: number) {
  const key = seasonCooldownKey(requestId, season);
  const local = localRequestCooldownCache.get(key);
  if (local !== undefined) return local;
  const remote = Boolean(await redis.get(key));
  localRequestCooldownCache.set(key, remote, remote ? SEARCH_COOLDOWN_SECONDS * 1000 : LOCAL_REDIS_NEGATIVE_CACHE_MS);
  return remote;
}

export async function markSeasonSearchCooldown(requestId: string, season: number, ttlSeconds = SEARCH_COOLDOWN_SECONDS) {
  const key = seasonCooldownKey(requestId, season);
  localRequestCooldownCache.set(key, true, ttlSeconds * 1000);
  await redis.set(key, "1", "EX", ttlSeconds);
}

async function requestGrabCoolingDown(requestId: string) {
  const key = requestGrabCooldownKey(requestId);
  const local = localRequestCooldownCache.get(key);
  if (local !== undefined) return local;
  const remote = Boolean(await redis.get(key));
  localRequestCooldownCache.set(key, remote, remote ? REQUEST_GRAB_COOLDOWN_SECONDS * 1000 : LOCAL_REDIS_NEGATIVE_CACHE_MS);
  return remote;
}

async function markRequestGrabCooldown(requestId: string) {
  const key = requestGrabCooldownKey(requestId);
  localRequestCooldownCache.set(key, true, REQUEST_GRAB_COOLDOWN_SECONDS * 1000);
  await redis.set(key, "1", "EX", REQUEST_GRAB_COOLDOWN_SECONDS);
}

export async function wantedSearchCoolingDown(requestId: string) {
  const key = wantedSearchCooldownKey(requestId);
  const local = localRequestCooldownCache.get(key);
  if (local !== undefined) return local;
  const remote = Boolean(await redis.get(key));
  localRequestCooldownCache.set(key, remote, remote ? REQUEST_WANTED_SEARCH_COOLDOWN_SECONDS * 1000 : LOCAL_REDIS_NEGATIVE_CACHE_MS);
  return remote;
}

export async function markWantedSearchCooldown(requestId: string, ttlSeconds = REQUEST_WANTED_SEARCH_COOLDOWN_SECONDS) {
  const key = wantedSearchCooldownKey(requestId);
  localRequestCooldownCache.set(key, true, ttlSeconds * 1000);
  await redis.set(key, "1", "EX", ttlSeconds);
}

export async function markWantedSearchTimeoutCooldown(requestId: string) {
  return markWantedSearchCooldown(requestId, REQUEST_WANTED_SEARCH_TIMEOUT_COOLDOWN_SECONDS);
}

export function requestSeasonRecoveryHint(request: {
  mediaType: string;
  seasonTarget?: { seasonNumber?: number | null } | null;
  episodeTarget?: { seasonNumber?: number | null } | null;
}) {
  if (request.mediaType !== "tv") return null;
  const seasonNumber = request.seasonTarget?.seasonNumber ?? request.episodeTarget?.seasonNumber ?? null;
  return typeof seasonNumber === "number" && Number.isFinite(seasonNumber) && seasonNumber > 0
    ? Math.floor(seasonNumber)
    : null;
}

export function missingArticleCooldownPlan(request: {
  mediaType: string;
  seasonTarget?: { seasonNumber?: number | null } | null;
  episodeTarget?: { seasonNumber?: number | null } | null;
}) {
  const season = requestSeasonRecoveryHint(request);
  if (request.mediaType === "movie") {
    return {
      wantedTtlSeconds: REQUEST_MISSING_ARTICLE_MOVIE_COOLDOWN_SECONDS,
      season,
      seasonTtlSeconds: null
    };
  }
  if (season) {
    return {
      wantedTtlSeconds: REQUEST_MISSING_ARTICLE_FOLLOWUP_COOLDOWN_SECONDS,
      season,
      seasonTtlSeconds: REQUEST_MISSING_ARTICLE_TV_SEASON_COOLDOWN_SECONDS
    };
  }
  return {
    wantedTtlSeconds: REQUEST_MISSING_ARTICLE_TV_COOLDOWN_SECONDS,
    season: null,
    seasonTtlSeconds: null
  };
}

export async function markMissingArticleSearchCooldown(request: {
  id: string;
  mediaType: string;
  seasonTarget?: { seasonNumber?: number | null } | null;
  episodeTarget?: { seasonNumber?: number | null } | null;
}) {
  const plan = missingArticleCooldownPlan(request);
  await markWantedSearchCooldown(request.id, plan.wantedTtlSeconds);
  if (plan.season && plan.seasonTtlSeconds) {
    await markSeasonSearchCooldown(request.id, plan.season, plan.seasonTtlSeconds);
  }
  return plan;
}

async function queueReleaseForRequest(
  requestId: string,
  candidate: { release: Parameters<typeof scoreRelease>[0]; decision: ReturnType<typeof scoreRelease> },
  options?: { priorityBoost?: number }
) {
  const settings = await getSettings();
  const reusable = await reuseExistingReleaseDownload(requestId, candidate.release);
  if (reusable) {
    if (options?.priorityBoost && reusable.status !== "downloading") {
      await promoteDownloadPriority(reusable.id, options.priorityBoost).catch(() => undefined);
    }
    return { grabbed: true, reason: "reused existing download", release: candidate.release, decision: candidate.decision, download: reusable, reused: true, attemptedFetch: false };
  }
  let attemptedFetch = false;
  let download: Awaited<ReturnType<typeof addNzbFromPath>>;
  try {
    attemptedFetch = true;
    const nzb = await downloadNzb(settings, candidate.release);
    download = await addNzbFromPath(nzb.primaryPath, candidate.release.title, {
      guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
      requestId,
      priority: options?.priorityBoost
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to fetch or import NZB";
    const blocklisted = await maybeBlocklistGrabFailure({
      guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
      title: candidate.release.title,
      reason: message,
      source: "grab-validation",
      release: candidate.release
    });
    return { grabbed: false, reason: message, attemptedFetch, retryableFailure: !blocklisted };
  }
  if (download.status === "failed") {
    const blocklisted = await maybeBlocklistGrabFailure({
      guid: candidate.release.guid ? String(candidate.release.guid) : undefined,
      title: candidate.release.title,
      reason: download.error,
      source: "grab-validation",
      release: candidate.release
    });
    return { grabbed: false, reason: download.error ?? "failed before queueing", download, attemptedFetch, retryableFailure: !blocklisted };
  }
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: { status: requestStatusForDownloadStatus(download.status), selectedRelease: jsonValue(candidate.release), downloadId: download.id }
  });
  await refreshLibraryRequestRows([requestId]).catch(() => undefined);
  return { grabbed: true, reason: "release queued", release: candidate.release, decision: candidate.decision, download, attemptedFetch };
}

export async function grabReleaseForRequest(id: string, release: unknown) {
  const typedRelease = release as Parameters<typeof scoreRelease>[0];
  return runRequestGrabPipeline<{ release: Parameters<typeof scoreRelease>[0]; decision: ReturnType<typeof scoreRelease> }>({
    maxAttempts: 1,
    handlers: {
      checkExisting: async () => {
        const request = await getRequest(id);
        const existingDownload = await existingActiveDownload(request.downloadId);
        if (existingDownload) return { grabbed: true, reason: "request already has an active download", download: existingDownload };
        const settings = await getSettings();
        const configuredProfileId =
          request.selectedProfileId ??
          (request.mediaType === "tv" ? request.provider?.defaultTvProfile ?? settings.defaultTvProfile : request.provider?.defaultMovieProfile ?? settings.defaultMovieProfile);
        const profile = await resolveProfile(configuredProfileId, request.mediaType);
        if (await isReleaseBlocklisted(typedRelease)) {
          await prisma.mediaRequest.update({
            where: { id },
            data: { status: "blocklisted_release", selectedRelease: jsonValue(typedRelease) }
          });
          return { grabbed: false, reason: "release is blocklisted", release: typedRelease };
        }
        const decision = scoreReleaseForRequest(request, typedRelease, profile, {
          rejectAmbiguousAnime: request.mediaType === "tv" && Boolean(request.year)
        });
        if (!decision.accepted) {
          await prisma.mediaRequest.update({
            where: { id },
            data: { status: "rejected_release", selectedRelease: jsonValue(typedRelease) }
          });
          return { grabbed: false, reason: "release rejected by quality profile", decision, release: typedRelease };
        }
        return null;
      },
      loadCandidates: async () => {
        const request = await getRequest(id);
        const settings = await getSettings();
        const configuredProfileId =
          request.selectedProfileId ??
          (request.mediaType === "tv" ? request.provider?.defaultTvProfile ?? settings.defaultTvProfile : request.provider?.defaultMovieProfile ?? settings.defaultMovieProfile);
        const profile = await resolveProfile(configuredProfileId, request.mediaType);
        const decision = scoreReleaseForRequest(request, typedRelease, profile, {
          rejectAmbiguousAnime: request.mediaType === "tv" && Boolean(request.year)
        });
        return { candidates: [{ release: typedRelease, decision }] };
      },
      tryCandidate: async (candidate) => {
        const reusable = await reuseExistingReleaseDownload(id, typedRelease);
        if (reusable) return { grabbed: true, reason: "reused existing download", release: typedRelease, decision: candidate.decision, download: reusable, reused: true };
        const settings = await getSettings();
        let download: Awaited<ReturnType<typeof addNzbFromPath>>;
        try {
          const nzb = await downloadNzb(settings, typedRelease);
          download = await addNzbFromPath(nzb.primaryPath, typedRelease.title, {
            guid: typedRelease.guid ? String(typedRelease.guid) : undefined,
            requestId: id
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed to fetch or import NZB";
          const blocklisted = await maybeBlocklistGrabFailure({
            guid: typedRelease.guid ? String(typedRelease.guid) : undefined,
            title: typedRelease.title,
            reason: message,
            source: "manual-grab-validation",
            release: typedRelease
          });
          await markRequestGrabCooldown(id).catch(() => undefined);
          await prisma.mediaRequest.update({
            where: { id },
            data: {
              status: blocklisted ? "release_failed" : "approved",
              selectedRelease: blocklisted ? jsonValue(typedRelease) : Prisma.JsonNull,
              downloadId: null
            }
          }).catch(() => undefined);
          await refreshLibraryRequestRows([id]).catch(() => undefined);
          return { grabbed: false, transient: !blocklisted, retryableFailure: !blocklisted, reason: message, release: typedRelease, attemptedFetch: true };
        }
        if (download.status === "failed") {
          const blocklisted = await maybeBlocklistGrabFailure({
            guid: typedRelease.guid ? String(typedRelease.guid) : undefined,
            title: typedRelease.title,
            reason: download.error,
            source: "manual-grab-validation",
            release: typedRelease
          });
          if (!blocklisted) {
            await markRequestGrabCooldown(id).catch(() => undefined);
            await prisma.mediaRequest.update({
              where: { id },
              data: { status: "approved", selectedRelease: Prisma.JsonNull, downloadId: null }
            }).catch(() => undefined);
            await refreshLibraryRequestRows([id]).catch(() => undefined);
            return { grabbed: false, transient: true, retryableFailure: true, reason: download.error ?? "temporary fetch failure", release: typedRelease, attemptedFetch: true };
          }
          await prisma.mediaRequest.update({
            where: { id },
            data: { status: "release_failed", selectedRelease: jsonValue(typedRelease), downloadId: null }
          });
          const next = await grabBestForRequest(id);
          return {
            grabbed: next.grabbed,
            reason: "selected release failed before queueing; blocklisted and searched for a replacement",
            release: typedRelease,
            replacement: next,
            attemptedFetch: true,
            stop: true
          };
        }
        await prisma.mediaRequest.update({
          where: { id },
          data: { status: requestStatusForDownloadStatus(download.status), selectedRelease: jsonValue(typedRelease), downloadId: download.id }
        });
        await refreshLibraryRequestRows([id]).catch(() => undefined);
        return { grabbed: true, reason: "release queued", release: typedRelease, decision: candidate.decision, download, attemptedFetch: true };
      },
      onExhausted: async () => ({
        grabbed: false,
        reason: "selected release could not be queued"
      })
    }
  });
}

export async function blocklistSelectedRelease(request: MediaRequest, reason: string, source: string) {
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

export async function existingActiveDownload(downloadId?: string | null) {
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
  await refreshLibraryRequestRows([id]).catch(() => undefined);
  return refreshed;
}

export async function reconcileRequestLinkStates() {
  const requests = await prisma.mediaRequest.findMany({
    where: {
      OR: [
        { downloadId: { not: null } },
        { status: "grabbed" }
      ]
    },
    select: {
      id: true,
      mediaType: true,
      status: true,
      downloadId: true,
      seasons: true,
      episodes: true,
      title: true,
      year: true,
      tmdbId: true,
      tvdbId: true,
      imdbId: true,
      ...REQUEST_RELATION_SELECT
    }
  });
  if (requests.length === 0) return { updated: 0 };

  const downloadIds = [...new Set(requests.map((request) => request.downloadId).filter((id): id is string => Boolean(id)))];
  const downloads = downloadIds.length > 0
    ? await prisma.download.findMany({ where: { id: { in: downloadIds } }, select: { id: true, status: true } })
    : [];
  const downloadsById = new Map(downloads.map((download) => [download.id, download.status]));

  const tvRequests = requests.filter((request) => request.mediaType === "tv");
  const tvRequestIds = tvRequests.map((request) => request.id);
  const [availableImports, downloadingItems] = tvRequestIds.length > 0 ? await Promise.all([
    prisma.importItem.findMany({
      where: {
        requestId: { in: tvRequestIds },
        mediaType: "tv",
        symlinks: { some: { status: { not: "broken" } } }
      },
      select: { requestId: true, season: true, episode: true }
    }),
    prisma.mediaLibraryItem.findMany({
      where: {
        requestId: { in: tvRequestIds },
        mediaType: "tv",
        libraryStatus: { in: ["requested", "searching", "grabbed"] }
      },
      select: { requestId: true }
    })
  ]) : [[], []];
  const availableByRequest = new Map<string, Array<{ season: number | null; episode: number | null }>>();
  for (const item of availableImports) {
    const key = item.requestId;
    if (!key) continue;
    const bucket = availableByRequest.get(key) ?? [];
    bucket.push({ season: item.season, episode: item.episode });
    availableByRequest.set(key, bucket);
  }
  const downloadingByRequest = new Map<string, number>();
  for (const item of downloadingItems) {
    const key = item.requestId;
    if (!key) continue;
    downloadingByRequest.set(key, (downloadingByRequest.get(key) ?? 0) + 1);
  }

  let updated = 0;
  for (const request of requests) {
    const hydratedRequest = hydrateLegacyRequestFields(request);
    const linkedDownloadStatus = request.downloadId ? downloadsById.get(request.downloadId) ?? null : null;
    const monitorSummary = hydratedRequest.mediaType === "tv"
      ? await summarizeTvRequestCountsBatch(hydratedRequest, availableByRequest, downloadingByRequest)
      : null;
    const nextStatus = effectiveRequestStatus({
      request: hydratedRequest,
      downloadStatus: linkedDownloadStatus,
      monitorSummary
    });
    const shouldClearDownloadId = !linkedDownloadStatus
      || isFailedLinkedDownloadStatus(linkedDownloadStatus)
      || (
        hydratedRequest.mediaType === "tv"
        && (linkedDownloadStatus === "available" || linkedDownloadStatus === "completed")
        && nextStatus !== "available"
      );
    if (nextStatus === hydratedRequest.status && !shouldClearDownloadId) continue;
    await prisma.mediaRequest.update({
      where: { id: hydratedRequest.id },
      data: {
        status: nextStatus,
        ...(shouldClearDownloadId ? { downloadId: null } : {})
      }
    });
    updated += 1;
  }
  if (updated > 0) await refreshLibraryRequestRows(requests.map((request) => request.id)).catch(() => undefined);
  return { updated };
}

export async function markRequestAvailable(id: string) {
  const request = await getRequest(id);
  const nextStatus = request.mediaType === "tv"
    ? await tvRequestAvailabilitySummary(request).then((summary) => summary.hasMissingEpisodes ? "approved" : "available").catch(() => "available")
    : "available";
  const updated = await prisma.mediaRequest.update({
    where: { id },
    data: { status: nextStatus }
  });
  if (updated.mediaType === "tv" && nextStatus === "available") {
    await setTvMonitorCursor(id, null).catch(() => undefined);
  }
  await refreshLibraryRequestRows([id]).catch(() => undefined);
  return { ok: true, localOnly: true, status: updated.status };
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
