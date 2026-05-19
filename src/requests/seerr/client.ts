import type { RequestProvider } from "@prisma/client";
import type { ExternalMediaRequest } from "../types.js";

type SeerrRequest = {
  id: number;
  status?: number;
  type?: "movie" | "tv";
  requestedBy?: { displayName?: string; username?: string; email?: string };
  media?: {
    mediaType?: "movie" | "tv";
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
    status?: number;
  };
  seasons?: unknown[];
  profileName?: string;
  requestedQuality?: string;
  movie?: { title?: string; releaseDate?: string };
  tv?: { name?: string; firstAirDate?: string };
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

function providerFetch(provider: RequestProvider, path: string) {
  const url = new URL(path, provider.baseUrl);
  return fetch(url, {
    headers: {
      "x-api-key": provider.apiKey,
      accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });
}

async function fetchMediaDetails(provider: RequestProvider, request: SeerrRequest) {
  const mediaType = request.media?.mediaType ?? request.type ?? "movie";
  const tmdbId = request.media?.tmdbId;
  if (!tmdbId) return undefined;

  const response = await providerFetch(provider, `/api/v1/${mediaType}/${tmdbId}`);
  if (!response.ok) return undefined;
  return response.json() as Promise<SeerrMediaDetails>;
}

export async function testSeerrConnection(provider: RequestProvider) {
  const response = await providerFetch(provider, "/api/v1/status");
  return { ok: response.ok, status: response.status };
}

export async function fetchSeerrRequests(provider: RequestProvider): Promise<ExternalMediaRequest[]> {
  const response = await providerFetch(provider, "/api/v1/request?take=100&skip=0&filter=all&sort=added");
  if (!response.ok) throw new Error(`${provider.name} returned HTTP ${response.status}`);
  const data = (await response.json()) as { results?: SeerrRequest[] };
  return Promise.all((data.results ?? []).map(async (request) => {
    const details = await fetchMediaDetails(provider, request);
    const mediaType = request.media?.mediaType ?? request.type ?? "movie";
    const title = mediaType === "movie" ? request.movie?.title ?? details?.title : request.tv?.name ?? details?.name;
    const date = mediaType === "movie" ? request.movie?.releaseDate ?? details?.releaseDate : request.tv?.firstAirDate ?? details?.firstAirDate;
    return {
      externalId: String(request.id),
      mediaType,
      title: title ?? `Request ${request.id}`,
      year: date ? Number(date.slice(0, 4)) : undefined,
      tmdbId: request.media?.tmdbId ? String(request.media.tmdbId) : undefined,
      tvdbId: request.media?.tvdbId ? String(request.media.tvdbId) : details?.externalIds?.tvdbId ? String(details.externalIds.tvdbId) : undefined,
      imdbId: request.media?.imdbId ?? details?.imdbId ?? details?.externalIds?.imdbId,
      seasons: request.seasons,
      requestedBy: request.requestedBy?.displayName ?? request.requestedBy?.username ?? request.requestedBy?.email,
      requestedQuality: request.profileName ?? request.requestedQuality,
      externalStatus: String(request.status ?? request.media?.status ?? "unknown")
    };
  }));
}

export async function updateSeerrAvailable(provider: RequestProvider, requestId: string) {
  const response = await providerFetch(provider, `/api/v1/request/${requestId}/available`);
  return { ok: response.ok, status: response.status };
}
