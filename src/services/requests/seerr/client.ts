import type { RequestProvider } from "../../../repositories/db/prisma.js";
import type { ExternalMediaRequest } from "../types.js";
import { assertServiceAllowed, guardedExternalCall, recordServiceFailure, recordServiceSuccess } from "../../serviceGuard.js";

type SeerrRequest = {
  id: number;
  status?: number;
  type?: "movie" | "tv";
  requestedBy?: { displayName?: string; username?: string; email?: string };
  media?: {
    id?: number;
    mediaType?: "movie" | "tv";
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
    status?: number;
  };
  seasons?: unknown[];
  is4k?: boolean;
  profileName?: string;
  requestedQuality?: string;
  movie?: { title?: string; releaseDate?: string };
  tv?: { name?: string; firstAirDate?: string };
};

type SeerrRequestPage = {
  pageInfo?: {
    pages?: number;
    pageSize?: number;
    results?: number;
    page?: number;
  };
  results?: SeerrRequest[];
};

type SeerrMediaDetails = {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  imdbId?: string;
  externalIds?: {
    imdbId?: string;
    tvdbId?: number;
  };
};

type SeerrRequestDetails = SeerrRequest & {
  seasons?: unknown[];
};

type FetchSeerrRequestsOptions = {
  maxRequests?: number;
  includeDetails?: boolean;
  skip?: number;
  pageSize?: number;
};

function serviceName(provider: RequestProvider) {
  return `request-provider:${provider.id}`;
}

function providerConfigured(provider: RequestProvider) {
  return Boolean(provider.enabled && provider.baseUrl && provider.apiKey);
}

async function providerFetch(provider: RequestProvider, path: string, init: RequestInit = {}) {
  await assertServiceAllowed(serviceName(provider), providerConfigured(provider), `${provider.name} is not configured; request skipped`);
  const url = new URL(path, provider.baseUrl);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "x-api-key": provider.apiKey,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers
      },
      signal: AbortSignal.timeout(15000)
    });
    if (response.ok) await recordServiceSuccess(serviceName(provider));
    else await recordServiceFailure(serviceName(provider), new Error(`${provider.name} returned HTTP ${response.status}`));
    return response;
  } catch (error) {
    await recordServiceFailure(serviceName(provider), error);
    throw error;
  }
}

async function fetchMediaDetails(provider: RequestProvider, request: SeerrRequest) {
  const mediaType = request.media?.mediaType ?? request.type ?? "movie";
  const tmdbId = request.media?.tmdbId;
  if (!tmdbId) return undefined;

  const response = await providerFetch(provider, `/api/v1/${mediaType}/${tmdbId}`);
  if (!response.ok) return undefined;
  return response.json() as Promise<SeerrMediaDetails>;
}

async function mapSeerrRequest(provider: RequestProvider, request: SeerrRequest, options: FetchSeerrRequestsOptions = {}): Promise<ExternalMediaRequest> {
  const mediaType = request.media?.mediaType ?? request.type ?? "movie";
  const title = mediaType === "movie" ? request.movie?.title : request.tv?.name;
  const date = mediaType === "movie" ? request.movie?.releaseDate : request.tv?.firstAirDate;
  const needsDetails = !title || !date || (!request.media?.imdbId && !request.media?.tvdbId);
  const details = options.includeDetails !== false && needsDetails ? await fetchMediaDetails(provider, request) : undefined;
  const normalized = extractSeasonEpisodes(request.seasons);
  const effectiveDate = date ?? details?.releaseDate ?? details?.firstAirDate;
  let tvdbId: string | undefined;
  if (request.media?.tvdbId) tvdbId = String(request.media.tvdbId);
  else if (details?.externalIds?.tvdbId) tvdbId = String(details.externalIds.tvdbId);
  return {
    externalId: String(request.id),
    mediaType,
    title: title ?? details?.title ?? details?.name ?? `Request ${request.id}`,
    year: effectiveDate ? Number(effectiveDate.slice(0, 4)) : undefined,
    tmdbId: request.media?.tmdbId ? String(request.media.tmdbId) : undefined,
    tvdbId,
    imdbId: request.media?.imdbId ?? details?.imdbId ?? details?.externalIds?.imdbId,
    seasons: normalized.seasons,
    episodes: normalized.episodes,
    requestedBy: request.requestedBy?.displayName ?? request.requestedBy?.username ?? request.requestedBy?.email,
    requestedQuality: request.profileName ?? request.requestedQuality ?? (request.is4k ? "4K" : undefined),
    externalStatus: String(request.status ?? request.media?.status ?? "unknown")
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  input: TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>
) {
  const output = new Array<TOutput>(input.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, input.length)) }, async () => {
    while (nextIndex < input.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      output[currentIndex] = await mapper(input[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return output;
}

export async function testSeerrConnection(provider: RequestProvider) {
  return guardedExternalCall(serviceName(provider), providerConfigured(provider), `${provider.name} is not configured; connection test skipped`, async () => {
    const status = await providerFetch(provider, "/api/v1/status");
    if (!status.ok) return { ok: false, status: status.status, endpoint: "status", message: `${provider.name} status check failed (${status.status})` };
    const requests = await providerFetch(provider, "/api/v1/request?take=1&skip=0&filter=all&sort=added");
    return {
      ok: requests.ok,
      status: requests.status,
      endpoint: requests.ok ? "requests" : "request-list",
      message: requests.ok
        ? `${provider.name} connection OK`
        : `${provider.name} request list failed (${requests.status}). Check host, API key, and permissions.`
    };
  });
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function extractSeasonEpisodes(input: unknown) {
  if (!Array.isArray(input)) return { seasons: undefined, episodes: undefined };
  const seasons = new Set<number>();
  const episodesBySeason = new Map<number, Set<number>>();

  for (const item of input) {
    if (typeof item === "number" && Number.isFinite(item)) {
      seasons.add(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const seasonNumber = numberValue(record.seasonNumber ?? record.season ?? record.season_number ?? record.number);
    if (!seasonNumber) continue;
    seasons.add(seasonNumber);

    const episodeCollection = [record.episodes, record.requestedEpisodes, record.requested_episodes].find(Array.isArray);
    if (!Array.isArray(episodeCollection)) continue;
    const episodeSet = episodesBySeason.get(seasonNumber) ?? new Set<number>();
    for (const episodeItem of episodeCollection) {
      if (typeof episodeItem === "number" && Number.isFinite(episodeItem)) {
        episodeSet.add(episodeItem);
        continue;
      }
      if (!episodeItem || typeof episodeItem !== "object") continue;
      const episodeRecord = episodeItem as Record<string, unknown>;
      const episodeNumber = numberValue(
        episodeRecord.episodeNumber ?? episodeRecord.episode ?? episodeRecord.episode_number ?? episodeRecord.number
      );
      if (episodeNumber) episodeSet.add(episodeNumber);
    }
    if (episodeSet.size > 0) episodesBySeason.set(seasonNumber, episodeSet);
  }

  return {
    seasons:
      seasons.size > 0
        ? [...seasons].sort((a, b) => a - b).map((seasonNumber) => ({ seasonNumber }))
        : undefined,
    episodes:
      episodesBySeason.size > 0
        ? [...episodesBySeason.entries()]
            .flatMap(([seasonNumber, episodes]) =>
              [...episodes].sort((a, b) => a - b).map((episodeNumber) => ({ seasonNumber, episodeNumber }))
            )
        : undefined
  };
}

async function fetchRequestPage(provider: RequestProvider, take: number, skip: number) {
  const response = await providerFetch(provider, `/api/v1/request?take=${take}&skip=${skip}&filter=all&sort=added`);
  if (!response.ok) throw new Error(`${provider.name} returned HTTP ${response.status}`);
  return response.json() as Promise<SeerrRequestPage>;
}

async function fetchAllRequestPages(provider: RequestProvider, pageSize = 100, options: FetchSeerrRequestsOptions = {}) {
  const requests: SeerrRequest[] = [];
  let skip = Math.max(0, options.skip ?? 0);
  let page = 0;
  let totalPages: number | undefined;
  const maxRequests = options.maxRequests && options.maxRequests > 0 ? options.maxRequests : undefined;

  while (true) {
    const data = await fetchRequestPage(provider, pageSize, skip);
    const pageResults = data.results ?? [];
    requests.push(...(maxRequests ? pageResults.slice(0, Math.max(0, maxRequests - requests.length)) : pageResults));
    page += 1;
    totalPages = data.pageInfo?.pages ?? totalPages;

    const exhaustedByLimit = Boolean(maxRequests && requests.length >= maxRequests);
    const exhaustedByCount = pageResults.length < pageSize;
    const exhaustedByPageInfo = Boolean(totalPages && page >= totalPages);
    const exhaustedByResults = Boolean(data.pageInfo && typeof data.pageInfo.results === "number" && requests.length >= data.pageInfo.results);
    if (exhaustedByLimit || exhaustedByCount || exhaustedByPageInfo || exhaustedByResults) break;
    skip += pageSize;
  }

  return requests;
}

export async function fetchSeerrRequests(provider: RequestProvider, options: FetchSeerrRequestsOptions = {}): Promise<ExternalMediaRequest[]> {
  await assertServiceAllowed(serviceName(provider), providerConfigured(provider), `${provider.name} is not configured; request sync skipped`);
  const effectivePageSize = Math.max(1, Math.min(100, options.pageSize ?? options.maxRequests ?? 100));
  const requests = await fetchAllRequestPages(provider, effectivePageSize, options);
  return mapWithConcurrency(requests, 8, async (request) => mapSeerrRequest(provider, request, options));
}

export async function fetchSeerrRequestById(provider: RequestProvider, requestId: string): Promise<ExternalMediaRequest | null> {
  await assertServiceAllowed(serviceName(provider), providerConfigured(provider), `${provider.name} is not configured; request sync skipped`);
  const response = await providerFetch(provider, `/api/v1/request/${encodeURIComponent(requestId)}`);
  if (!response.ok) return null;
  const request = await response.json() as SeerrRequestDetails;
  return mapSeerrRequest(provider, request);
}

export async function updateSeerrAvailable(provider: RequestProvider, requestId: string) {
  const requestResponse = await providerFetch(provider, `/api/v1/request/${encodeURIComponent(requestId)}`);
  if (!requestResponse.ok) return { ok: false, status: requestResponse.status };
  const request = await requestResponse.json() as SeerrRequest;
  if (!request.media?.id) return { ok: false, status: 422, message: "Seerr request has no media ID." };
  const response = await providerFetch(provider, `/api/v1/media/${request.media.id}/available`, {
    method: "POST",
    body: JSON.stringify({ is4k: Boolean(request.is4k) })
  });
  return { ok: response.ok, status: response.status };
}

export async function createSeerrRequest(provider: RequestProvider, input: { mediaType: "movie" | "tv"; tmdbId: string }) {
  const response = await providerFetch(provider, "/api/v1/request", {
    method: "POST",
    body: JSON.stringify({
      mediaType: input.mediaType,
      mediaId: Number(input.tmdbId),
      seasons: input.mediaType === "tv" ? "all" : undefined
    })
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}
