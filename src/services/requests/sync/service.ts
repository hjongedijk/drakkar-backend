import type { FastifyBaseLogger } from "fastify";
import { readFile } from "node:fs/promises";
import { prisma, Prisma, type MediaRequest, type RequestProvider } from "../../../repositories/db/prisma.js";
import { refreshMediaLibrary } from "../../libraryService.js";
import { refreshLibraryRequestRows } from "../../media-library/libraryRefresh.js";
import { fetchMediaDetails as fetchMetadataDetails, fetchSeriesStructure } from "../../metadataService.js";
import { getSettings } from "../../settings/settingsStore.js";
import { syncRuntimeSettingsFromDatabase } from "../../settings/settingsStore.js";
import { fetchSeerrRequestById, fetchSeerrRequests, testSeerrConnection } from "../seerr/client.js";
import type { ExternalMediaRequest } from "../types.js";
import {
  blocklistSelectedRelease,
  existingActiveDownload,
  getRequest,
  getRequestMonitor,
  grabTvEpisodeForRequest,
  reconcileRequestLinkStates,
  rankReleasesForRequest,
  rankTvEpisodeForRequest,
  findWorkingImportForRequest,
  grabMissingTvForRequest,
  grabBestForRequest,
  grabReleaseForRequest,
  markWantedSearchCooldown,
  markWantedSearchTimeoutCooldown,
  requestedEpisodesBySeason,
  requestedSeasons,
  setRequestProfile,
  setRequestStatus,
  shouldAutoGrabSyncedRequest,
  tvRequestAvailabilitySummary,
  upsertRequest,
  wantedSearchCoolingDown
} from "./mediaRequestService.js";
import { hydrateLegacyRequestFields } from "../../media-library/normalizedMedia.js";

const MONITOR_QUEUE_SEED_STATUSES = ["queued", "fetching_nzb", "verifying", "waiting_for_provider", "waiting_for_nzb", "downloading", "paused"];
const MONITORED_REQUEST_STATUSES = ["approved", "grabbed", "available", "release_failed", "no_release_found", "auto_grab_failed"];
const MONITORED_REQUESTS_MAX_DURATION_MS = 90_000;
const MONITORED_REQUEST_OPERATION_TIMEOUT_MS = 30_000;
const REQUEST_RECOVERY_MAX_DURATION_MS = 45_000;
const REQUEST_SYNC_MAX_DURATION_MS = 35_000;
const REQUEST_SYNC_PROVIDER_MAX_REQUESTS = 200;
const FAILED_REQUEST_RECOVERY_MAX_PER_CYCLE = 8;
const SELECTED_RELEASE_RECOVERY_MAX_PER_CYCLE = 8;
const ACTIVE_WANTED_SEARCHES_PER_CYCLE = 1;
const MONITORED_REQUEST_TIMEOUT_BUDGET = 4;
const MONITORED_REQUEST_BATCH_SIZE = 120;
const MONITORED_TV_BATCH_SIZE = 12;
const MONITORED_MOVIE_SEARCH_LIMIT = 10;
const MONITORED_TV_SEARCH_LIMIT = 5;
const MONITORED_TV_CURSOR_KEY = "request-recovery.tv.cursor";
const SELECTED_RELEASE_RECOVERY_CURSOR_KEY = "request-recovery.selected-release.cursor";
const FAILED_REQUEST_RECOVERY_CURSOR_KEY = "request-recovery.failed.cursor";
const MONITORED_SEARCH_OPTIONS = {
  searchLimit: MONITORED_MOVIE_SEARCH_LIMIT,
  skipFallback: true,
  recordHistory: false,
  cacheResult: false
} as const;
const MONITORED_TV_SEARCH_OPTIONS = {
  searchLimit: MONITORED_TV_SEARCH_LIMIT,
  skipFallback: true,
  recordHistory: false,
  cacheResult: false
} as const;
const SEERR_WEBHOOK_PRIORITY = 900;
const webhookSyncInFlight = new Set<string>();

const REQUEST_SYNC_RELATION_SELECT = {
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

function terminalDownloadStatus(status?: string | null) {
  return status ? new Set(["available", "completed", "failed", "cancelled", "replaced"]).has(status) : false;
}

async function withSoftTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  return new Promise<{ timedOut: false; value: T } | { timedOut: true }>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function desiredMovieRequestStatus(input: {
  request: MediaRequest;
  linkedDownloadStatus?: string | null;
  hasWorkingImport: boolean;
  hasActiveDownload: boolean;
}) {
  if (input.hasWorkingImport) return { status: "available", clearDownloadId: false };
  if (input.hasActiveDownload) return { status: "grabbed", clearDownloadId: false };
  if (input.linkedDownloadStatus === "available" || input.linkedDownloadStatus === "completed") {
    return { status: "available", clearDownloadId: false };
  }
  if (input.linkedDownloadStatus === "failed" || input.linkedDownloadStatus === "cancelled" || input.linkedDownloadStatus === "replaced") {
    return { status: "approved", clearDownloadId: true };
  }
  if (input.request.status === "grabbed") return { status: "approved", clearDownloadId: true };
  return { status: input.request.status, clearDownloadId: false };
}

async function getMonitoredTvCursor() {
  const row = await prisma.setting.findUnique({ where: { key: MONITORED_TV_CURSOR_KEY } });
  const value = row?.value as { skip?: unknown } | undefined;
  const skip = typeof value?.skip === "number" && Number.isFinite(value.skip) && value.skip >= 0 ? Math.floor(value.skip) : 0;
  return skip;
}

async function setMonitoredTvCursor(skip: number) {
  await prisma.setting.upsert({
    where: { key: MONITORED_TV_CURSOR_KEY },
    update: { value: { skip } },
    create: { key: MONITORED_TV_CURSOR_KEY, value: { skip } }
  });
}

async function fetchMonitoredTvRequestsBatch() {
  const where = {
    mediaType: "tv",
    status: { in: MONITORED_REQUEST_STATUSES }
  };
  const total = await prisma.mediaRequest.count({ where });
  if (total === 0) {
    await setMonitoredTvCursor(0).catch(() => undefined);
    return [] as Array<MediaRequest & { provider?: RequestProvider | null }>;
  }

  let skip = await getMonitoredTvCursor();
  if (skip >= total) skip = 0;

  let rows = await prisma.mediaRequest.findMany({
    where,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    skip,
    take: MONITORED_TV_BATCH_SIZE,
    include: REQUEST_SYNC_RELATION_SELECT
  });

  if (rows.length === 0) {
    skip = 0;
    rows = await prisma.mediaRequest.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: MONITORED_TV_BATCH_SIZE,
      include: REQUEST_SYNC_RELATION_SELECT
    });
  }

  const nextSkip = skip + rows.length >= total ? 0 : skip + rows.length;
  await setMonitoredTvCursor(nextSkip).catch(() => undefined);
  return rows.map((request) => hydrateLegacyRequestFields(request));
}

async function getRecoveryCursor(key: string) {
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value as { skip?: unknown } | undefined;
  const skip = typeof value?.skip === "number" && Number.isFinite(value.skip) && value.skip >= 0 ? Math.floor(value.skip) : 0;
  return skip;
}

async function setRecoveryCursor(key: string, skip: number) {
  await prisma.setting.upsert({
    where: { key },
    update: { value: { skip } },
    create: { key, value: { skip } }
  });
}

async function fetchRecoveryRequestBatch<T extends Prisma.MediaRequestFindManyArgs>(
  cursorKey: string,
  where: NonNullable<T["where"]>,
  take: number,
  args: Omit<T, "where" | "skip" | "take" | "orderBy">
) {
  const total = await prisma.mediaRequest.count({ where });
  if (total === 0) {
    await setRecoveryCursor(cursorKey, 0).catch(() => undefined);
    return [] as Prisma.MediaRequestGetPayload<T>[];
  }

  let skip = await getRecoveryCursor(cursorKey);
  if (skip >= total) skip = 0;

  let rows = await prisma.mediaRequest.findMany({
    where,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    skip,
    take,
    ...args
  } as T);

  if (rows.length === 0) {
    skip = 0;
    rows = await prisma.mediaRequest.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take,
      ...args
    } as T);
  }

  const nextSkip = skip + rows.length >= total ? 0 : skip + rows.length;
  await setRecoveryCursor(cursorKey, nextSkip).catch(() => undefined);
  return rows as Prisma.MediaRequestGetPayload<T>[];
}

async function ioPressureAvg10() {
  try {
    const raw = await readFile("/proc/pressure/io", "utf8");
    const line = raw.split("\n").find((entry) => entry.startsWith("some "));
    const match = line?.match(/\bavg10=(\d+(?:\.\d+)?)\b/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

async function fetchProviderRequests(
  provider: RequestProvider,
  options: { full?: boolean; skip?: number; maxRequests?: number; pageSize?: number } = {}
) {
  return fetchSeerrRequests(provider, {
    maxRequests: options.maxRequests ?? (options.full ? undefined : REQUEST_SYNC_PROVIDER_MAX_REQUESTS),
    includeDetails: false,
    skip: options.skip,
    pageSize: options.pageSize
  });
}

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
  return prisma.requestProvider.create({ data: { ...input, type: "seerr" } }).then(async (provider) => {
    await syncRuntimeSettingsFromDatabase();
    return provider;
  });
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
  return prisma.requestProvider.update({ where: { id }, data: input }).then(async (provider) => {
    await syncRuntimeSettingsFromDatabase();
    return provider;
  });
}

export function deleteProvider(id: string) {
  return prisma.requestProvider.delete({ where: { id } }).then(async (provider) => {
    await syncRuntimeSettingsFromDatabase();
    return provider;
  });
}

export async function syncRequests(
  providerId?: string,
  options: { full?: boolean; skip?: number; maxRequests?: number; pageSize?: number; refreshLibrary?: boolean } = {}
) {
  const startedAt = Date.now();
  const providers = await prisma.requestProvider.findMany({
    where: { enabled: true, ...(providerId ? { id: providerId } : {}) }
  });
  const imported: MediaRequest[] = [];
  const providerResults: SyncProviderResult[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let budgetExceeded = false;

  for (const provider of providers) {
    if (!options.full && Date.now() - startedAt >= REQUEST_SYNC_MAX_DURATION_MS) {
      budgetExceeded = true;
      break;
    }
    let fetchedForProvider = 0;
    let importedForProvider = 0;
    let updatedForProvider = 0;
    let skippedForProvider = 0;
    try {
      const requests = await fetchProviderRequests(provider, options);
      fetchedForProvider = requests.length;
      const syncedRequests: MediaRequest[] = [];
      for (const request of requests) {
        if (!options.full && Date.now() - startedAt >= REQUEST_SYNC_MAX_DURATION_MS) {
          budgetExceeded = true;
          break;
        }
        const hydrated = await enrichRequestMetadataFallback(request);
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

      void syncedRequests;
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

  if ((createdCount > 0 || updatedCount > 0) && options.refreshLibrary !== false) {
    void refreshLibraryRequestRows(imported.map((request) => request.id)).catch(() => undefined);
  }
  return {
    imported: createdCount,
    updated: updatedCount,
    skipped: skippedCount,
    fetched: createdCount + updatedCount + skippedCount,
    requests: imported,
    providerResults,
    failedProviders: providerResults.filter((item) => !item.ok).length,
    autoGrabbed: 0,
    budgetExceeded
  };
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function extractWebhookRequestId(payload: unknown) {
  const root = objectValue(payload);
  const request = objectValue(root?.request);
  return (
    stringValue(request?.request_id) ??
    stringValue(request?.id) ??
    stringValue(root?.request_id) ??
    stringValue(root?.requestId)
  );
}

function extractWebhookProviderId(payload: unknown) {
  const root = objectValue(payload);
  return stringValue(root?.providerId) ?? stringValue(root?.provider_id);
}

function eventSuggestsSync(payload: unknown) {
  const root = objectValue(payload);
  const event = `${stringValue(root?.notification_type) ?? ""} ${stringValue(root?.event) ?? ""}`.toLowerCase();
  return /request/.test(event);
}

async function maybeAutoGrabWebhookRequest(provider: RequestProvider, synced: MediaRequest) {
  if (!(await shouldAutoGrabSyncedRequest(synced))) return null;
  try {
    return synced.mediaType === "tv"
      ? await grabMissingTvForRequest(synced.id, { priorityBoost: SEERR_WEBHOOK_PRIORITY })
      : await grabBestForRequest(synced.id, { priorityBoost: SEERR_WEBHOOK_PRIORITY });
  } catch (error) {
    await prisma.mediaRequest.update({
      where: { id: synced.id },
      data: { status: "approved", downloadId: null }
    }).catch(() => undefined);
    await prisma.requestProvider.update({
      where: { id: provider.id },
      data: { lastError: error instanceof Error ? error.message : "automatic request grab failed" }
    }).catch(() => undefined);
    throw error;
  }
}

export async function syncRequestFromWebhook(payload: unknown, providerId?: string) {
  const effectiveProviderId = providerId ?? extractWebhookProviderId(payload);
  const providers = await prisma.requestProvider.findMany({
    where: { type: "seerr", enabled: true, ...(effectiveProviderId ? { id: effectiveProviderId } : {}) },
    orderBy: { createdAt: "asc" }
  });
  if (providers.length === 0) {
    return { ok: false, mode: "noop", reason: "no_enabled_seerr_provider" as const };
  }

  const externalId = extractWebhookRequestId(payload);
  if (!eventSuggestsSync(payload)) {
    return { ok: true, mode: "accepted" as const, requestId: externalId ?? null, reason: "non_request_event" as const };
  }

  if (!externalId) {
    return { ok: true, mode: "accepted" as const, requestId: null, reason: "missing_request_id" as const };
  }

  for (const provider of providers) {
    try {
      const request = await fetchSeerrRequestById(provider, externalId);
      if (!request) continue;
      const hydratedBase = await enrichRequestMetadataFallback(request);
      const hydrated = hydratedBase.mediaType === "tv"
        ? await enrichTvRequestWithStructure(hydratedBase)
        : hydratedBase;
      const result = await upsertRequest(provider, hydrated);
      await prisma.requestProvider.update({
        where: { id: provider.id },
        data: { lastSyncAt: new Date(), lastError: null }
      }).catch(() => undefined);
      const grabbed = await maybeAutoGrabWebhookRequest(provider, result.request).catch((error) => ({
        error: error instanceof Error ? error.message : "automatic request grab failed"
      }));
      await refreshLibraryRequestRows([result.request.id]).catch(() => undefined);
      return {
        ok: true,
        mode: "targeted" as const,
        providerId: provider.id,
        requestId: externalId,
        action: result.action,
        request: result.request,
        grabbed: grabbed ?? null
      };
    } catch (error) {
      await prisma.requestProvider.update({
        where: { id: provider.id },
        data: { lastError: error instanceof Error ? error.message : "webhook sync failed" }
      }).catch(() => undefined);
    }
  }

  const sync = await syncRequests(effectiveProviderId);
  return { ok: true, mode: "full-sync" as const, requestId: externalId, sync };
}

export function enqueueWebhookSync(logger: FastifyBaseLogger, payload: unknown, providerId?: string) {
  const externalId = extractWebhookRequestId(payload) ?? "unknown";
  const key = `${providerId ?? extractWebhookProviderId(payload) ?? "default"}:${externalId}`;
  if (webhookSyncInFlight.has(key)) {
    return { accepted: true, deduped: true, requestId: externalId || null };
  }
  webhookSyncInFlight.add(key);
  queueMicrotask(() => {
    void syncRequestFromWebhook(payload, providerId)
      .then((result) => {
        logger.info({
          mode: "mode" in result ? result.mode : "noop",
          requestId: "requestId" in result ? result.requestId : externalId,
          ok: result.ok,
          deferred: true
        }, "seerr webhook processed");
      })
      .catch((error) => {
        logger.warn({
          requestId: externalId,
          providerId,
          deferred: true,
          err: error
        }, "seerr webhook deferred sync failed");
      })
      .finally(() => {
        webhookSyncInFlight.delete(key);
      });
  });
  return { accepted: true, deduped: false, requestId: externalId || null };
}

export async function recoverFailedRequestDownloads(options: { limit?: number } = {}) {
  const limit = Math.max(1, options.limit ?? FAILED_REQUEST_RECOVERY_MAX_PER_CYCLE);
  const startedAt = Date.now();
  const requests = (await fetchRecoveryRequestBatch(
    FAILED_REQUEST_RECOVERY_CURSOR_KEY,
    {
      downloadId: { not: null },
      status: { not: "available" }
    },
    limit,
    {
      select: {
        id: true,
        mediaType: true,
        status: true,
        downloadId: true,
        selectedRelease: true,
        title: true,
        year: true,
        tmdbId: true,
        tvdbId: true,
        imdbId: true,
        seasons: true,
        episodes: true
      }
    }
  )).map((request) => hydrateLegacyRequestFields(request));
  const downloadIds = [...new Set(requests.flatMap((request) => request.downloadId ? [request.downloadId] : []))];
  const downloads = downloadIds.length > 0
    ? await prisma.download.findMany({ where: { id: { in: downloadIds } }, select: { id: true, status: true, error: true } })
    : [];
  const downloadMap = new Map(downloads.map((download) => [download.id, download]));
  const recovered: Array<{ requestId: string; grabbed: boolean; reason?: string | null }> = [];
  for (const request of requests) {
    if (Date.now() - startedAt >= REQUEST_RECOVERY_MAX_DURATION_MS) break;
    const download = request.downloadId ? downloadMap.get(request.downloadId) ?? null : null;
    if (!download) {
      await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "release_failed", downloadId: null } });
      const result = await grabForRequestMediaType(request.id, request.mediaType);
      recovered.push({ requestId: request.id, grabbed: Boolean(result?.grabbed), reason: result?.reason ?? null });
      continue;
    }
    if (!["failed", "replaced", "cancelled"].includes(download.status)) continue;
    await blocklistSelectedRelease(request, download.error ?? "download failed", "request-recovery");
    await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "release_failed", downloadId: null } });
    const result = await grabForRequestMediaType(request.id, request.mediaType);
    recovered.push({ requestId: request.id, grabbed: Boolean(result?.grabbed), reason: result?.reason ?? null });
  }
  if (recovered.length > 0) await refreshLibraryRequestRows(requests.map((request) => request.id)).catch(() => undefined);
  return { scanned: requests.length, recovered: recovered.length, results: recovered };
}

export async function recoverSelectedReleaseDownloads(options: { limit?: number } = {}) {
  const limit = Math.max(1, options.limit ?? SELECTED_RELEASE_RECOVERY_MAX_PER_CYCLE);
  const startedAt = Date.now();
  const requests = (await fetchRecoveryRequestBatch(
    SELECTED_RELEASE_RECOVERY_CURSOR_KEY,
    {
      downloadId: null,
      selectedRelease: { not: Prisma.JsonNull },
      status: { in: ["approved", "grabbed", "searching", "release_failed", "auto_grab_failed", "no_release_found", "import_failed"] }
    },
    limit,
    {
      select: {
        id: true,
        mediaType: true,
        status: true,
        downloadId: true,
        selectedRelease: true,
        title: true,
        year: true,
        tmdbId: true,
        tvdbId: true,
        imdbId: true,
        seasons: true,
        episodes: true
      }
    }
  )).map((request) => hydrateLegacyRequestFields(request));

  const recovered: Array<{ requestId: string; grabbed: boolean; reason?: string | null }> = [];
  for (const request of requests) {
    if (Date.now() - startedAt >= REQUEST_RECOVERY_MAX_DURATION_MS) break;
    const workingImport = await findWorkingImportForRequest(request).catch(() => null);
    if (workingImport) {
      await prisma.mediaRequest.update({
        where: { id: request.id },
        data: {
          status: "available",
          downloadId: workingImport.downloadId
        }
      }).catch(() => undefined);
      recovered.push({ requestId: request.id, grabbed: false, reason: "working import already exists" });
      continue;
    }
    if (!request.selectedRelease || typeof request.selectedRelease !== "object") continue;
    try {
      const result = await grabReleaseForRequest(request.id, request.selectedRelease);
      recovered.push({ requestId: request.id, grabbed: Boolean(result?.grabbed), reason: result?.reason ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "selected release recovery failed";
      await blocklistSelectedRelease(request, message, "selected-release-recovery");
      await prisma.mediaRequest.update({
        where: { id: request.id },
        data: {
          status: "release_failed",
          selectedRelease: Prisma.JsonNull,
          downloadId: null
        }
      }).catch(() => undefined);
      const retryResult = await grabForRequestMediaType(request.id, request.mediaType).catch((retryError) => ({
        grabbed: false,
        reason: retryError instanceof Error ? retryError.message : "replacement search failed"
      }));
      recovered.push({ requestId: request.id, grabbed: Boolean(retryResult?.grabbed), reason: retryResult?.reason ?? null });
    }
  }

  if (recovered.length > 0) await refreshLibraryRequestRows(recovered.map((item) => item.requestId).filter((value): value is string => Boolean(value))).catch(() => undefined);
  return { recovered: recovered.length, results: recovered };
}

export async function backfillPlaceholderRequestMetadata() {
  const requests = (await prisma.mediaRequest.findMany({
    where: {
      title: { startsWith: "Request " },
      OR: [
        { tmdbId: { not: null } },
        { tvdbId: { not: null } },
        { imdbId: { not: null } }
      ]
    },
    orderBy: { updatedAt: "asc" },
    include: { provider: true },
    take: 20
  })).map((request) => hydrateLegacyRequestFields(request));

  let updated = 0;
  for (const request of requests) {
    let hydrated = await enrichRequestMetadataFallback({
      externalId: request.externalId,
      mediaType: request.mediaType as "movie" | "tv",
      title: request.title,
      year: request.year ?? undefined,
      tmdbId: request.tmdbId ?? undefined,
      tvdbId: request.tvdbId ?? undefined,
      imdbId: request.imdbId ?? undefined,
      seasons: jsonValue(request.seasons) as ExternalMediaRequest["seasons"],
      episodes: jsonValue(request.episodes) as ExternalMediaRequest["episodes"],
      requestedBy: request.requestedBy ?? undefined,
      requestedQuality: request.requestedQuality ?? undefined,
      externalStatus: request.externalStatus ?? undefined
    });
    if ((isPlaceholderRequestTitle(hydrated.title) || !hydrated.title) && request.provider?.type === "seerr" && request.externalId) {
      const providerRequest = await fetchSeerrRequestById(request.provider, request.externalId).catch(() => null);
      if (providerRequest) {
        hydrated = await enrichRequestMetadataFallback(providerRequest).catch(() => hydrated);
      }
    }
    if (!hydrated.title || hydrated.title === request.title) continue;
    await prisma.mediaRequest.update({
      where: { id: request.id },
      data: {
        title: hydrated.title,
        year: hydrated.year,
        tmdbId: hydrated.tmdbId,
        tvdbId: hydrated.tvdbId,
        imdbId: hydrated.imdbId
      }
    }).catch(() => undefined);
    updated += 1;
  }

  if (updated > 0) await refreshLibraryRequestRows(requests.map((request) => request.id)).catch(() => undefined);
  return { scanned: requests.length, updated };
}

export { reconcileRequestLinkStates };

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

export async function ensureMonitoredRequests(
  logger?: FastifyBaseLogger,
  options?: { activeWantedSearchLimit?: number; timeoutBudget?: number }
) {
  const settings = await getSettings();
  const queueSeedTarget = Math.max(1, settings.monitorQueueSeedTarget);
  const startedAt = Date.now();
  let pendingQueueItems = await monitoredQueuePendingCount();
  let activeWantedSearches = 0;
  let timedOutOperations = 0;
  const activeWantedSearchLimit = Math.max(0, options?.activeWantedSearchLimit ?? ACTIVE_WANTED_SEARCHES_PER_CYCLE);
  const timeoutBudget = Math.max(1, options?.timeoutBudget ?? MONITORED_REQUEST_TIMEOUT_BUDGET);
  if (pendingQueueItems >= queueSeedTarget) {
    return { retried: 0, queueSeedTarget, pendingQueueItems, skippedBecauseQueueFull: 1, results: [] };
  }
  const movieRequests = (await prisma.mediaRequest.findMany({
    where: {
      mediaType: "movie",
      status: { in: MONITORED_REQUEST_STATUSES }
    },
    orderBy: [{ status: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
    take: Math.max(queueSeedTarget, Math.ceil(MONITORED_REQUEST_BATCH_SIZE / 2)),
    include: REQUEST_SYNC_RELATION_SELECT
  })).map((request) => hydrateLegacyRequestFields(request));
  const tvRequests = await fetchMonitoredTvRequestsBatch();
  const requests = [...tvRequests, ...movieRequests];

  const retried: Array<{ requestId: string; grabbed: boolean; remainingSeasonSearches?: number }> = [];
  let skippedBecauseQueueFull = 0;
  for (const request of requests) {
    if (Date.now() - startedAt >= MONITORED_REQUESTS_MAX_DURATION_MS) break;
    if (timedOutOperations >= timeoutBudget) {
      logger?.warn({ timedOutOperations, queueSeedTarget, pendingQueueItems }, "monitored request recovery stopped early after timeout budget was exhausted");
      break;
    }
    if (pendingQueueItems >= queueSeedTarget) {
      skippedBecauseQueueFull += 1;
      break;
    }
    if (request.mediaType === "tv") {
      const availabilityResult = await withSoftTimeout(
        tvRequestAvailabilitySummary(request).catch(() => null),
        MONITORED_REQUEST_OPERATION_TIMEOUT_MS
      );
      if (availabilityResult.timedOut) {
        timedOutOperations += 1;
        await markWantedSearchTimeoutCooldown(request.id).catch(() => undefined);
        await prisma.mediaRequest.update({ where: { id: request.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
        logger?.warn({ requestId: request.id, title: request.title, mediaType: request.mediaType }, "monitored request availability summary timed out; skipping request for this cycle");
        continue;
      }
      const availability = availabilityResult.value;
      if (!availability) continue;
      const hasMissingEpisodes = availability.hasMissingEpisodes;
      const hasAvailableEpisodes = availability.hasAvailableEpisodes;
      const workingImport = hasAvailableEpisodes ? await findWorkingImportForRequest(request).catch(() => null) : null;
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
            ...(activeDownload
              ? {}
              : {
                  downloadId: hasMissingEpisodes || clearDeadDownloadId
                    ? null
                    : workingImport?.downloadId ?? request.downloadId
                })
          }
        }).catch(() => undefined);
      }
      if (!hasMissingEpisodes) continue;
      const wantedCoolingDown = await wantedSearchCoolingDown(request.id);
      if (wantedCoolingDown) continue;
      let attemptedActiveSearch = false;
      const cachedResult = await withSoftTimeout(
        grabMissingTvForRequest(request.id, { cachedOnly: true, ...MONITORED_TV_SEARCH_OPTIONS }).catch(() => null),
        MONITORED_REQUEST_OPERATION_TIMEOUT_MS
      );
      let result = cachedResult.timedOut ? null : cachedResult.value;
      if (cachedResult.timedOut) {
        timedOutOperations += 1;
        logger?.warn({ requestId: request.id, title: request.title, mediaType: request.mediaType, cachedOnly: true }, "monitored request cached search timed out; trying active search if budget allows");
      }
      if (!result?.grabbed && activeWantedSearches < activeWantedSearchLimit) {
        attemptedActiveSearch = true;
        activeWantedSearches += 1;
        const activeResult = await withSoftTimeout(
          grabMissingTvForRequest(request.id, MONITORED_TV_SEARCH_OPTIONS).catch(() => null),
          MONITORED_REQUEST_OPERATION_TIMEOUT_MS
        );
        if (activeResult.timedOut) {
          timedOutOperations += 1;
          await markWantedSearchTimeoutCooldown(request.id).catch(() => undefined);
          await prisma.mediaRequest.update({ where: { id: request.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
          logger?.warn({ requestId: request.id, title: request.title, mediaType: request.mediaType, cachedOnly: false }, "monitored request active search timed out; skipping request for this cycle");
          continue;
        }
        result = activeResult.value;
        await markWantedSearchCooldown(request.id).catch(() => undefined);
      }
      const hasRemainingSeasonSearches = Boolean(
        result
        && typeof result === "object"
        && "remainingSeasonSearches" in result
        && typeof (result as Record<string, unknown>).remainingSeasonSearches === "number"
        && Number((result as Record<string, unknown>).remainingSeasonSearches) > 0
      );
      if (result?.grabbed || hasRemainingSeasonSearches || attemptedActiveSearch) {
        retried.push({
          requestId: request.id,
          grabbed: Boolean(result?.grabbed),
          ...(hasRemainingSeasonSearches ? { remainingSeasonSearches: Number((result as Record<string, unknown>).remainingSeasonSearches) } : {})
        });
        await prisma.mediaRequest.update({ where: { id: request.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
      }
      pendingQueueItems = await monitoredQueuePendingCount();
      continue;
    }

    const workingImport = await findWorkingImportForRequest(request).catch(() => null);
    const activeDownload = await existingActiveDownload(request.downloadId).catch(() => null);
    const linkedDownload = request.downloadId
      ? await prisma.download.findUnique({ where: { id: request.downloadId }, select: { id: true, status: true } }).catch(() => null)
      : null;
    const desiredMovieState = desiredMovieRequestStatus({
      request,
      linkedDownloadStatus: linkedDownload?.status,
      hasWorkingImport: Boolean(workingImport),
      hasActiveDownload: Boolean(activeDownload)
    });
    if (desiredMovieState.status !== request.status || desiredMovieState.clearDownloadId) {
      await prisma.mediaRequest.update({
        where: { id: request.id },
        data: {
          status: desiredMovieState.status,
          ...(desiredMovieState.clearDownloadId ? { downloadId: null } : {})
        }
      }).catch(() => undefined);
      request.status = desiredMovieState.status;
      request.downloadId = desiredMovieState.clearDownloadId ? null : request.downloadId;
    }
    if (workingImport || activeDownload || (linkedDownload && terminalDownloadStatus(linkedDownload.status) && !desiredMovieState.clearDownloadId)) continue;
    const wantedCoolingDown = await wantedSearchCoolingDown(request.id);
    if (wantedCoolingDown) continue;
    let attemptedActiveSearch = false;
    const cachedResult = await withSoftTimeout(
      grabBestForRequest(request.id, { cachedOnly: true, ...MONITORED_SEARCH_OPTIONS }).catch(() => null),
      MONITORED_REQUEST_OPERATION_TIMEOUT_MS
    );
    let result = cachedResult.timedOut ? null : cachedResult.value;
    if (cachedResult.timedOut) {
      timedOutOperations += 1;
      logger?.warn({ requestId: request.id, title: request.title, mediaType: request.mediaType, cachedOnly: true }, "monitored request cached search timed out; trying active search if budget allows");
    }
    if (!result?.grabbed && activeWantedSearches < activeWantedSearchLimit) {
      attemptedActiveSearch = true;
      activeWantedSearches += 1;
      const activeResult = await withSoftTimeout(
        grabBestForRequest(request.id, MONITORED_SEARCH_OPTIONS).catch(() => null),
        MONITORED_REQUEST_OPERATION_TIMEOUT_MS
      );
      if (activeResult.timedOut) {
        timedOutOperations += 1;
        await markWantedSearchTimeoutCooldown(request.id).catch(() => undefined);
        await prisma.mediaRequest.update({ where: { id: request.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
        logger?.warn({ requestId: request.id, title: request.title, mediaType: request.mediaType, cachedOnly: false }, "monitored request active search timed out; skipping request for this cycle");
        continue;
      }
      result = activeResult.value;
      await markWantedSearchCooldown(request.id).catch(() => undefined);
    }
    if (result?.grabbed || attemptedActiveSearch) {
      retried.push({ requestId: request.id, grabbed: Boolean(result?.grabbed) });
      await prisma.mediaRequest.update({ where: { id: request.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
    }
    pendingQueueItems = await monitoredQueuePendingCount();
  }

  if (retried.length > 0) await refreshLibraryRequestRows(retried.map((item) => item.requestId)).catch(() => undefined);
  return { retried: retried.length, queueSeedTarget, pendingQueueItems, skippedBecauseQueueFull, results: retried };
}


export * from "./mediaRequestService.js";
