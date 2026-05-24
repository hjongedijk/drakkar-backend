import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { getAuthUserByApiKey } from "../auth/service.js";

function stableInt(value: string) {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return Number.parseInt(hash, 16) & 0x7fffffff;
}

function queryToken(request: FastifyRequest) {
  const url = new URL(request.url, env.APP_BASE_URL);
  const auth = request.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
  const xApiKey = Array.isArray(request.headers["x-api-key"]) ? request.headers["x-api-key"][0] : request.headers["x-api-key"];
  const xApiToken = Array.isArray(request.headers["x-api-token"]) ? request.headers["x-api-token"][0] : request.headers["x-api-token"];
  return String(xApiKey ?? xApiToken ?? url.searchParams.get("apikey") ?? url.searchParams.get("apiToken") ?? bearer ?? "");
}

async function ensureCompatAuth(request: FastifyRequest) {
  const token = queryToken(request);
  if (!token) return false;
  if (token === env.getDrakkarApiToken(env.CONFIG_DIR)) return true;
  return Boolean(await getAuthUserByApiKey(token));
}

function compatPosterImages(posterUrl?: string | null, backdropUrl?: string | null) {
  return [
    ...(posterUrl ? [{ coverType: "poster", url: posterUrl }] : []),
    ...(backdropUrl ? [{ coverType: "fanart", url: backdropUrl }] : [])
  ];
}

function resolutionNumber(value?: string | null) {
  const match = value?.match(/(\d{3,4})p/i);
  return match ? Number(match[1]) : undefined;
}

function qualityName(source?: string | null, quality?: string | null) {
  const resolution = quality ?? "Unknown";
  const mappedSource = source
    ? ({
        webdl: "WEBDL",
        webrip: "WEBRip",
        bluray: "Bluray",
        hdtv: "HDTV",
        remux: "Remux"
      } satisfies Record<string, string>)[source.toLowerCase()] ?? source.toUpperCase()
    : "Unknown";
  return `${mappedSource}-${resolution}`;
}

function sonarrVideoCodec(value?: string | null) {
  if (!value) return undefined;
  if (/h265|x265|hevc/i.test(value)) return "HEVC";
  if (/h264|x264|avc/i.test(value)) return "AVC";
  return value;
}

function sonarrAudioCodec(value?: string | null) {
  if (!value) return undefined;
  if (/eac3|ddp/i.test(value)) return "E-AC-3";
  if (/ac3|dd/i.test(value)) return "AC-3";
  return value;
}

function radarrVideoCodec(value?: string | null) {
  if (!value) return undefined;
  if (/h265|x265/i.test(value)) return "x265";
  if (/hevc/i.test(value)) return "HEVC";
  if (/h264|x264|avc/i.test(value)) return "x264";
  return value;
}

function radarrAudioCodec(value?: string | null) {
  if (!value) return undefined;
  if (/eac3|ddp/i.test(value)) return "E-AC-3";
  if (/ac3|dd/i.test(value)) return "AC-3";
  return value;
}

function languageListFromProfileName(name?: string | null) {
  if (!name) return [];
  const lower = name.toLowerCase();
  if (lower.includes("dutch")) return ["Dutch"];
  if (lower.includes("english")) return ["English"];
  return ["English"];
}

async function fileSize(path?: string | null, fallback?: number | null) {
  if (path) {
    try {
      const info = await stat(path);
      if (Number.isFinite(info.size)) return info.size;
    } catch {}
  }
  return Math.max(0, Number(fallback ?? 0));
}

function episodeSeriesFolder(path?: string | null) {
  if (!path) return null;
  const folder = dirname(path);
  if (/\/Season [^/]+$/i.test(folder) || /\\Season [^\\]+$/i.test(folder)) return dirname(folder);
  return folder;
}

async function loadCompatRows() {
  const [libraryItems, requests, profiles] = await Promise.all([
    prisma.mediaLibraryItem.findMany({
      where: {
        libraryStatus: "available",
        OR: [
          { mediaType: "tv", season: { not: null }, episode: { not: null }, symlinkPath: { not: null } },
          { mediaType: "tv", season: { not: null }, episode: { not: null }, filePath: { not: null } },
          { mediaType: "movie", symlinkPath: { not: null } },
          { mediaType: "movie", filePath: { not: null } }
        ]
      },
      orderBy: [{ updatedAt: "desc" }]
    }),
    prisma.mediaRequest.findMany(),
    prisma.qualityProfile.findMany({ orderBy: { name: "asc" } })
  ]);
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  return { libraryItems, requestsById, profiles, profilesById };
}

async function buildSonarrData() {
  const { libraryItems, requestsById, profilesById } = await loadCompatRows();
  const tvItems = libraryItems.filter((item) => item.mediaType === "tv" && item.season != null && item.episode != null);
  const seriesById = new Map<number, {
    id: number;
    title: string;
    path: string;
    tvdbId: number;
    overview: string;
    images: Array<{ coverType: string; url: string }>;
    sortTitle: string;
    year?: number;
    seriesType: string;
    imdbId?: string | null;
    monitored: boolean;
    ended: boolean;
    lastAired?: string;
    tags: number[];
    alternateTitles: Array<{ title: string }>;
    qualityProfileId: number;
  }>();
  const episodes: Array<Record<string, unknown>> = [];
  const episodeFiles: Array<Record<string, unknown>> = [];

  for (const item of tvItems) {
    const request = item.requestId ? requestsById.get(item.requestId) : undefined;
    const profile = item.qualityProfileId ? profilesById.get(item.qualityProfileId) : undefined;
    const path = item.symlinkPath ?? item.filePath;
    if (!path || item.season == null || item.episode == null) continue;
    const seriesPath = episodeSeriesFolder(path);
    if (!seriesPath) continue;
    const seriesId = item.tvdbId ? Number(item.tvdbId) : stableInt(`series:${item.title}:${item.year ?? ""}`);
    const episodeId = stableInt(`episode:${seriesId}:${item.season}:${item.episode}`);
    const episodeFileId = stableInt(`episode-file:${path}`);
    const size = await fileSize(path, item.size ?? undefined);
    const lastAired = item.episodeAirDate?.toISOString().slice(0, 10);

    if (!seriesById.has(seriesId)) {
      seriesById.set(seriesId, {
        id: seriesId,
        title: item.title,
        path: seriesPath,
        tvdbId: item.tvdbId ? Number(item.tvdbId) : seriesId,
        overview: item.overview ?? "",
        images: compatPosterImages(item.posterUrl, item.backdropUrl),
        sortTitle: item.sortTitle,
        year: item.year ?? undefined,
        seriesType: "standard",
        imdbId: item.imdbId ?? undefined,
        monitored: request ? !["rejected"].includes(request.status) : true,
        ended: false,
        lastAired,
        tags: [],
        alternateTitles: [],
        qualityProfileId: profile ? stableInt(`quality:${profile.id}`) : 1
      });
    } else if (lastAired) {
      const series = seriesById.get(seriesId)!;
      if (!series.lastAired || series.lastAired < lastAired) series.lastAired = lastAired;
    }

    const languages = languageListFromProfileName(profile?.name).map((name) => ({ name }));
    const episodeFile = {
      id: episodeFileId,
      path,
      size,
      sceneName: basename(item.filePath ?? path),
      quality: {
        quality: {
          name: qualityName(item.source, item.quality),
          resolution: resolutionNumber(item.quality)
        }
      },
      mediaInfo: {
        videoCodec: sonarrVideoCodec(item.codec),
        audioCodec: sonarrAudioCodec(item.audio)
      },
      languages
    };

    episodeFiles.push(episodeFile);
    episodes.push({
      id: episodeId,
      seriesId,
      title: item.episodeTitle ?? `Episode ${item.episode}`,
      seasonNumber: item.season,
      episodeNumber: item.episode,
      monitored: request ? !["rejected"].includes(request.status) : true,
      hasFile: true,
      episodeFileId,
      episodeFile
    });
  }

  return {
    series: [...seriesById.values()].sort((a, b) => a.sortTitle.localeCompare(b.sortTitle)),
    episodes,
    episodeFiles
  };
}

async function buildRadarrData() {
  const { libraryItems, requestsById, profiles, profilesById } = await loadCompatRows();
  const movieItems = libraryItems.filter((item) => item.mediaType === "movie" && (item.symlinkPath || item.filePath));
  const movies: Array<Record<string, unknown>> = [];

  for (const item of movieItems) {
    const request = item.requestId ? requestsById.get(item.requestId) : undefined;
    const profile = item.qualityProfileId ? profilesById.get(item.qualityProfileId) : undefined;
    const path = item.symlinkPath ?? item.filePath;
    if (!path) continue;
    const movieId = item.tmdbId ? Number(item.tmdbId) : stableInt(`movie:${item.title}:${item.year ?? ""}:${path}`);
    const movieFileId = stableInt(`movie-file:${path}`);
    const size = await fileSize(path, item.size ?? undefined);
    const languages = languageListFromProfileName(profile?.name).map((name) => ({ name }));

    movies.push({
      id: movieId,
      title: item.title,
      sortTitle: item.sortTitle,
      year: item.year ?? undefined,
      tmdbId: item.tmdbId ? Number(item.tmdbId) : movieId,
      imdbId: item.imdbId ?? undefined,
      monitored: request ? !["rejected"].includes(request.status) : true,
      overview: item.overview ?? "",
      alternateTitles: [],
      tags: [],
      images: compatPosterImages(item.posterUrl, item.backdropUrl),
      qualityProfileId: profile ? stableInt(`quality:${profile.id}`) : 1,
      hasFile: true,
      movieFile: {
        id: movieFileId,
        path,
        size,
        sceneName: basename(item.filePath ?? path),
        quality: {
          quality: {
            name: qualityName(item.source, item.quality),
            resolution: resolutionNumber(item.quality)
          }
        },
        mediaInfo: {
          videoCodec: radarrVideoCodec(item.codec),
          audioCodec: radarrAudioCodec(item.audio)
        },
        languages
      }
    });
  }

  const qualityProfiles = profiles.map((profile) => ({
    id: stableInt(`quality:${profile.id}`),
    name: profile.name,
    language: {
      name: languageListFromProfileName(profile.name)[0] ?? "English"
    }
  }));

  return { movies, qualityProfiles };
}

async function buildHistoryForRequest(requestId?: string | null) {
  if (!requestId) return { records: [] };
  const request = await prisma.mediaRequest.findUnique({ where: { id: requestId } });
  if (!request || !request.selectedRelease || typeof request.selectedRelease !== "object") return { records: [] };
  const release = request.selectedRelease as Record<string, unknown>;
  const nzbInfoUrl = typeof release.detailsUrl === "string"
    ? release.detailsUrl
    : typeof release.downloadUrl === "string"
      ? release.downloadUrl
      : undefined;
  if (!nzbInfoUrl) return { records: [] };
  return {
    records: [{
      eventType: 1,
      date: request.updatedAt.toISOString(),
      data: {
        nzbInfoUrl
      }
    }]
  };
}

export async function bazarrCompatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!(await ensureCompatAuth(request))) {
      return reply.status(401).send({ message: "Invalid Bazarr compatibility API key." });
    }
  });

  const sonarrStatus = { version: "4.0.9.2421" };
  const radarrStatus = { version: "5.14.0.9383" };

  app.get("/api/compat/sonarr/api/system/status", async () => sonarrStatus);
  app.get("/api/compat/sonarr/api/v3/system/status", async () => sonarrStatus);
  app.get("/api/compat/radarr/api/system/status", async () => radarrStatus);
  app.get("/api/compat/radarr/api/v3/system/status", async () => radarrStatus);

  app.get("/api/compat/sonarr/api/v3/tag", async () => []);
  app.get("/api/compat/radarr/api/v3/tag", async () => []);

  app.get("/api/compat/sonarr/api/v3/rootfolder", async () => [{ id: stableInt(env.MEDIA_TV_DIR), path: env.MEDIA_TV_DIR }]);
  app.get("/api/compat/radarr/api/v3/rootfolder", async () => [{ id: stableInt(env.MEDIA_MOVIES_DIR), path: env.MEDIA_MOVIES_DIR }]);

  app.get("/api/compat/radarr/api/v3/qualityprofile", async () => (await buildRadarrData()).qualityProfiles);

  app.get("/api/compat/sonarr/api/v3/series", async (request) => {
    const data = await buildSonarrData();
    const id = Number(new URL(request.url, env.APP_BASE_URL).pathname.split("/").pop());
    return Number.isFinite(id) ? data.series.filter((item) => item.id === id) : data.series;
  });
  app.get("/api/compat/sonarr/api/v3/series/:id", async (request, reply) => {
    const data = await buildSonarrData();
    const id = Number((request.params as { id: string }).id);
    const item = data.series.find((series) => series.id === id);
    if (!item) return reply.status(404).send({ message: "Series not found." });
    return item;
  });
  app.get("/api/compat/sonarr/api/v3/episode", async (request) => {
    const data = await buildSonarrData();
    const url = new URL(request.url, env.APP_BASE_URL);
    const seriesId = Number(url.searchParams.get("seriesId"));
    if (Number.isFinite(seriesId)) return data.episodes.filter((item) => item.seriesId === seriesId);
    return data.episodes;
  });
  app.get("/api/compat/sonarr/api/v3/episode/:id", async (request, reply) => {
    const data = await buildSonarrData();
    const id = Number((request.params as { id: string }).id);
    const item = data.episodes.find((episode) => episode.id === id);
    if (!item) return reply.status(404).send({ message: "Episode not found." });
    return item;
  });
  app.get("/api/compat/sonarr/api/v3/episodeFile", async (request) => {
    const data = await buildSonarrData();
    const url = new URL(request.url, env.APP_BASE_URL);
    const seriesId = Number(url.searchParams.get("seriesId"));
    if (!Number.isFinite(seriesId)) return data.episodeFiles;
    const seriesEpisodeIds = new Set(data.episodes.filter((item) => item.seriesId === seriesId).map((item) => item.episodeFileId));
    return data.episodeFiles.filter((item) => seriesEpisodeIds.has(item.id as number));
  });
  app.get("/api/compat/sonarr/api/v3/episodeFile/:id", async (request, reply) => {
    const data = await buildSonarrData();
    const id = Number((request.params as { id: string }).id);
    const item = data.episodeFiles.find((episodeFile) => episodeFile.id === id);
    if (!item) return reply.status(404).send({ message: "Episode file not found." });
    return item;
  });
  app.get("/api/compat/sonarr/api/v3/history", async (request) => {
    const url = new URL(request.url, env.APP_BASE_URL);
    const episodeId = Number(url.searchParams.get("episodeId"));
    if (!Number.isFinite(episodeId)) return { records: [] };
    const data = await buildSonarrData();
    const item = data.episodes.find((episode) => episode.id === episodeId) as { seriesId?: number; seasonNumber?: number; episodeNumber?: number } | undefined;
    if (!item) return { records: [] };
    const libraryItem = await prisma.mediaLibraryItem.findFirst({
      where: {
        mediaType: "tv",
        tvdbId: item.seriesId ? String(item.seriesId) : undefined,
        season: item.seasonNumber,
        episode: item.episodeNumber,
        libraryStatus: "available"
      },
      orderBy: { updatedAt: "desc" }
    });
    return buildHistoryForRequest(libraryItem?.requestId);
  });

  app.get("/api/compat/radarr/api/v3/movie", async (request) => {
    const { movies } = await buildRadarrData();
    const id = Number(new URL(request.url, env.APP_BASE_URL).pathname.split("/").pop());
    return Number.isFinite(id) ? movies.filter((item) => item.id === id) : movies;
  });
  app.get("/api/compat/radarr/api/v3/movie/:id", async (request, reply) => {
    const { movies } = await buildRadarrData();
    const id = Number((request.params as { id: string }).id);
    const item = movies.find((movie) => movie.id === id);
    if (!item) return reply.status(404).send({ message: "Movie not found." });
    return item;
  });
  app.get("/api/compat/radarr/api/v3/history", async (request) => {
    const url = new URL(request.url, env.APP_BASE_URL);
    const movieId = Number(url.searchParams.get("movieIds"));
    if (!Number.isFinite(movieId)) return { records: [] };
    const { movies } = await buildRadarrData();
    const item = movies.find((movie) => movie.id === movieId) as { tmdbId?: number } | undefined;
    if (!item) return { records: [] };
    const libraryItem = await prisma.mediaLibraryItem.findFirst({
      where: {
        mediaType: "movie",
        tmdbId: item.tmdbId ? String(item.tmdbId) : undefined,
        libraryStatus: "available"
      },
      orderBy: { updatedAt: "desc" }
    });
    return buildHistoryForRequest(libraryItem?.requestId);
  });
}
