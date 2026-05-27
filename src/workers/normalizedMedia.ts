import { basename } from "node:path";
import { Prisma, prisma } from "../repositories/db/prisma.js";
import { getSettings } from "../services/settings/settingsStore.js";
import { fetchMediaDetails, fetchSeasonEpisodes, fetchSeriesStructure } from "../services/metadataService.js";
import {
  hydrateLegacyMediaFields,
  hydrateLegacyRequestFields,
  normalizeTmdbImagePath,
  normalizedLibraryMediaType,
  normalizedRequestMediaType,
  upsertMovie,
  upsertTvEpisode,
  upsertTvSeason,
  upsertTvShow
} from "../services/media-library/normalizedMedia.js";
import type { AppSettings } from "../services/settings/settingsStore.js";

type Report = {
  mode: "apply" | "report";
  moviesCreated: number;
  tvShowsCreated: number;
  seasonsCreated: number;
  episodesCreated: number;
  mediaRequestsLinked: number;
  mediaLibraryItemsLinked: number;
  mediaFilesCreated: number;
  filesLinkedToMovies: number;
  filesLinkedToEpisodes: number;
  rowsSkippedMissingTmdbId: number;
  rowsSkippedMissingSeason: number;
  rowsSkippedMissingEpisode: number;
  rowsSkippedUnresolvedTarget: number;
  duplicateWarnings: string[];
  unresolvedRequests: string[];
  unresolvedLibraryItems: string[];
};

type CachedShow = Awaited<ReturnType<typeof ensureShow>>;

const REQUEST_RELATION_SELECT = {
  movie: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true } },
  tvShow: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true } },
  seasonTarget: { select: { seasonNumber: true, title: true, overview: true } },
  episodeTarget: { select: { seasonNumber: true, episodeNumber: true, title: true, overview: true, airDate: true } }
} as const;

const LIBRARY_RELATION_SELECT = {
  movie: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true, posterPath: true, backdropPath: true, releaseDate: true } },
  tvShow: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true, posterPath: true, backdropPath: true, firstAirDate: true } },
  seasonTarget: { select: { seasonNumber: true, title: true, overview: true, airDate: true, posterPath: true } },
  episodeTarget: { select: { seasonNumber: true, episodeNumber: true, title: true, overview: true, airDate: true, stillPath: true } }
} as const;

function emptyReport(mode: "apply" | "report"): Report {
  return {
    mode,
    moviesCreated: 0,
    tvShowsCreated: 0,
    seasonsCreated: 0,
    episodesCreated: 0,
    mediaRequestsLinked: 0,
    mediaLibraryItemsLinked: 0,
    mediaFilesCreated: 0,
    filesLinkedToMovies: 0,
    filesLinkedToEpisodes: 0,
    rowsSkippedMissingTmdbId: 0,
    rowsSkippedMissingSeason: 0,
    rowsSkippedMissingEpisode: 0,
    rowsSkippedUnresolvedTarget: 0,
    duplicateWarnings: [],
    unresolvedRequests: [],
    unresolvedLibraryItems: []
  };
}

function asJson<T>(value: T) {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseSeasonNumbers(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seasons = new Set<number>();
  for (const item of value) {
    if (typeof item === "number" && Number.isFinite(item)) seasons.add(item);
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const seasonNumber = record.seasonNumber ?? record.season ?? record.number;
    if (typeof seasonNumber === "number" && Number.isFinite(seasonNumber)) seasons.add(seasonNumber);
    if (typeof seasonNumber === "string" && Number.isFinite(Number(seasonNumber))) seasons.add(Number(seasonNumber));
  }
  return [...seasons].sort((left, right) => left - right);
}

function parseRequestedEpisodes(value: unknown) {
  const seasons = new Map<number, Set<number>>();
  if (!Array.isArray(value)) return seasons;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const seasonNumber = Number(record.seasonNumber ?? record.season);
    const episodeNumber = Number(record.episodeNumber ?? record.episode ?? record.number);
    if (!Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber)) continue;
    const bucket = seasons.get(seasonNumber) ?? new Set<number>();
    bucket.add(episodeNumber);
    seasons.set(seasonNumber, bucket);
  }
  return seasons;
}

function parseDate(value?: string | Date | null) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function filenameForLibraryItem(item: {
  filePath?: string | null;
  symlinkPath?: string | null;
  strmPath?: string | null;
}) {
  return basename(item.symlinkPath ?? item.filePath ?? item.strmPath ?? "");
}

const movieCache = new Map<string, Awaited<ReturnType<typeof prisma.movie.findUnique>>>();
const showCache = new Map<string, Awaited<ReturnType<typeof prisma.tvShow.findUnique>>>();
const seasonCache = new Map<string, Awaited<ReturnType<typeof prisma.tvSeason.findUnique>>>();
const episodeCache = new Map<string, Awaited<ReturnType<typeof prisma.tvEpisode.findUnique>>>();
const structureCache = new Map<string, Awaited<ReturnType<typeof fetchSeriesStructure>>>();
const seasonEpisodesCache = new Map<string, Awaited<ReturnType<typeof fetchSeasonEpisodes>>>();

async function ensureMovie(
  report: Report,
  settings: AppSettings | null,
  input: {
    tmdbId?: string | null;
    imdbId?: string | null;
    tvdbId?: string | null;
    title: string;
    year?: number | null;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rawSeerr?: unknown;
  }
) {
  const resolvedMetadata = !input.tmdbId && settings
    ? await fetchMediaDetails(settings, {
        mediaType: "movie",
        title: input.title,
        year: input.year,
        imdbId: input.imdbId,
        tvdbId: input.tvdbId
      }).catch(() => undefined)
    : undefined;
  const tmdbId = input.tmdbId ?? resolvedMetadata?.tmdbId;
  if (!tmdbId) {
    report.rowsSkippedMissingTmdbId += 1;
    return null;
  }
  const cached = movieCache.get(tmdbId);
  if (cached) return cached;
  const existing = await prisma.movie.findUnique({ where: { tmdbId } });
  const details = settings
    ? await fetchMediaDetails(settings, {
        mediaType: "movie",
        title: input.title,
        year: input.year,
        tmdbId,
        imdbId: input.imdbId ?? resolvedMetadata?.imdbId,
        tvdbId: input.tvdbId ?? resolvedMetadata?.tvdbId
      }).catch(() => undefined)
    : resolvedMetadata;
  const movie = await upsertMovie(prisma, {
    tmdbId,
    imdbId: input.imdbId ?? resolvedMetadata?.imdbId ?? details?.imdbId,
    tvdbId: input.tvdbId ?? resolvedMetadata?.tvdbId ?? details?.tvdbId,
    title: details?.title ?? input.title,
    overview: details?.overview ?? input.overview,
    releaseDate: undefined,
    year: details?.year ?? input.year,
    runtimeMinutes: details?.runtimeMinutes,
    posterPath: normalizeTmdbImagePath(input.posterUrl) ?? normalizeTmdbImagePath(details?.posterUrl),
    backdropPath: normalizeTmdbImagePath(input.backdropUrl) ?? normalizeTmdbImagePath(details?.backdropUrl),
    rawSeerr: input.rawSeerr ? asJson(input.rawSeerr) : undefined
  });
  if (!existing) report.moviesCreated += 1;
  movieCache.set(tmdbId, movie);
  return movie;
}

async function ensureShow(
  report: Report,
  settings: AppSettings | null,
  input: {
    tmdbId?: string | null;
    imdbId?: string | null;
    tvdbId?: string | null;
    title: string;
    year?: number | null;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rawSeerr?: unknown;
  }
) {
  const resolvedMetadata = !input.tmdbId && settings
    ? await fetchMediaDetails(settings, {
        mediaType: "tv",
        title: input.title,
        year: input.year,
        imdbId: input.imdbId,
        tvdbId: input.tvdbId
      }).catch(() => undefined)
    : undefined;
  const tmdbId = input.tmdbId ?? resolvedMetadata?.tmdbId;
  if (!tmdbId) {
    report.rowsSkippedMissingTmdbId += 1;
    return null;
  }
  const cached = showCache.get(tmdbId);
  if (cached) return cached;
  const existing = await prisma.tvShow.findUnique({ where: { tmdbId } });
  const structure = settings
    ? await fetchSeriesStructure(settings, {
        mediaType: "tv",
        title: input.title,
        year: input.year,
        tmdbId,
        tvdbId: input.tvdbId ?? resolvedMetadata?.tvdbId,
        imdbId: input.imdbId ?? resolvedMetadata?.imdbId
      }).catch(() => undefined)
    : undefined;
  structureCache.set(tmdbId, structure);
  const show = await upsertTvShow(prisma, {
    tmdbId,
    imdbId: input.imdbId ?? resolvedMetadata?.imdbId,
    tvdbId: input.tvdbId ?? resolvedMetadata?.tvdbId ?? structure?.tvdbId,
    title: structure?.title ?? resolvedMetadata?.title ?? input.title,
    overview: structure?.overview ?? resolvedMetadata?.overview ?? input.overview,
    firstAirDate: undefined,
    year: resolvedMetadata?.year ?? input.year,
    posterPath: normalizeTmdbImagePath(input.posterUrl) ?? normalizeTmdbImagePath(structure?.posterUrl) ?? normalizeTmdbImagePath(resolvedMetadata?.posterUrl),
    backdropPath: normalizeTmdbImagePath(input.backdropUrl) ?? normalizeTmdbImagePath(structure?.backdropUrl) ?? normalizeTmdbImagePath(resolvedMetadata?.backdropUrl),
    numberOfSeasons: structure?.numberOfSeasons,
    numberOfEpisodes: structure?.numberOfEpisodes,
    rawSeerr: input.rawSeerr ? asJson(input.rawSeerr) : undefined
  });
  if (!existing) report.tvShowsCreated += 1;
  showCache.set(tmdbId, show);
  return show;
}

async function ensureSeason(
  report: Report,
  settings: AppSettings | null,
  show: NonNullable<CachedShow>,
  seasonNumber?: number | null
) {
  if (seasonNumber == null) {
    report.rowsSkippedMissingSeason += 1;
    return null;
  }
  const cacheKey = `${show.id}:${seasonNumber}`;
  const cached = seasonCache.get(cacheKey);
  if (cached) return cached;
  const existing = await prisma.tvSeason.findUnique({
    where: { tvShowId_seasonNumber: { tvShowId: show.id, seasonNumber } }
  });
  const structure = structureCache.get(show.tmdbId)
    ?? (settings
      ? await fetchSeriesStructure(settings, {
          mediaType: "tv",
          title: show.title,
          year: show.year,
          tmdbId: show.tmdbId,
          tvdbId: show.tvdbId ?? undefined,
          imdbId: show.imdbId ?? undefined
        }).catch(() => undefined)
      : undefined);
  if (structure) structureCache.set(show.tmdbId, structure);
  const seasonInfo = structure?.seasons.find((item) => item.seasonNumber === seasonNumber);
  const season = await upsertTvSeason(prisma, {
    tvShowId: show.id,
    seasonNumber,
    title: seasonInfo?.name ?? `Season ${String(seasonNumber).padStart(2, "0")}`,
    airDate: parseDate(seasonInfo?.airDate),
    episodeCount: seasonInfo?.episodeCount
  });
  if (!existing) report.seasonsCreated += 1;
  seasonCache.set(cacheKey, season);
  return season;
}

async function ensureEpisode(
  report: Report,
  settings: AppSettings | null,
  show: NonNullable<CachedShow>,
  season: NonNullable<Awaited<ReturnType<typeof ensureSeason>>>,
  episodeNumber?: number | null
) {
  if (episodeNumber == null) {
    report.rowsSkippedMissingEpisode += 1;
    return null;
  }
  const cacheKey = `${show.id}:${season.seasonNumber}:${episodeNumber}`;
  const cached = episodeCache.get(cacheKey);
  if (cached) return cached;
  const existing = await prisma.tvEpisode.findUnique({
    where: {
      tvShowId_seasonNumber_episodeNumber: {
        tvShowId: show.id,
        seasonNumber: season.seasonNumber,
        episodeNumber
      }
    }
  });
  const episodeCacheKey = `${show.tmdbId}:${season.seasonNumber}`;
  const seasonEpisodes = seasonEpisodesCache.get(episodeCacheKey)
    ?? (settings ? await fetchSeasonEpisodes(settings, show.tmdbId, season.seasonNumber).catch(() => []) : []);
  seasonEpisodesCache.set(episodeCacheKey, seasonEpisodes);
  const metadata = seasonEpisodes.find((item) => item.episodeNumber === episodeNumber);
  const episode = await upsertTvEpisode(prisma, {
    tvShowId: show.id,
    seasonId: season.id,
    seasonNumber: season.seasonNumber,
    episodeNumber,
    title: metadata?.name ?? `Episode ${episodeNumber}`,
    overview: metadata?.overview,
    airDate: parseDate(metadata?.airDate),
    stillPath: normalizeTmdbImagePath(metadata?.stillUrl)
  });
  if (!existing) report.episodesCreated += 1;
  episodeCache.set(cacheKey, episode);
  return episode;
}

async function ensureMediaFile(
  report: Report,
  input: {
    mediaType: "movie" | "episode";
    movieId?: string;
    episodeId?: string;
    importId?: string | null;
    downloadId?: string | null;
    nzbId?: string | null;
    vfsMountId?: string | null;
    folderPath?: string | null;
    filePath?: string | null;
    symlinkPath?: string | null;
    strmPath?: string | null;
    size?: number | null;
    duration?: number | null;
    quality?: string | null;
    source?: string | null;
    codec?: string | null;
    audio?: string | null;
    hdr?: boolean | null;
    dv?: boolean | null;
    releaseGroup?: string | null;
  }
) {
  const pathClauses: Prisma.MediaFileWhereInput[] = [];
  if (input.filePath) pathClauses.push({ filePath: input.filePath });
  if (input.symlinkPath) pathClauses.push({ symlinkPath: input.symlinkPath });
  if (input.strmPath) pathClauses.push({ strmPath: input.strmPath });
  const existing = pathClauses.length === 0
    ? null
    : await prisma.mediaFile.findFirst({
        where: {
          OR: pathClauses
        }
      });
  const data = {
    mediaType: input.mediaType,
    movieId: input.movieId,
    episodeId: input.episodeId,
    importId: input.importId ?? undefined,
    downloadId: input.downloadId ?? undefined,
    nzbId: input.nzbId ?? undefined,
    vfsMountId: input.vfsMountId ?? undefined,
    path: input.symlinkPath ?? input.filePath ?? input.strmPath ?? undefined,
    folderPath: input.folderPath ?? undefined,
    filePath: input.filePath ?? undefined,
    symlinkPath: input.symlinkPath ?? undefined,
    strmPath: input.strmPath ?? undefined,
    filename: filenameForLibraryItem(input),
    size: input.size ?? undefined,
    duration: input.duration ?? undefined,
    quality: input.quality ?? undefined,
    source: input.source ?? undefined,
    codec: input.codec ?? undefined,
    audio: input.audio ?? undefined,
    hdr: Boolean(input.hdr),
    dv: Boolean(input.dv),
    releaseGroup: input.releaseGroup ?? undefined,
    isAvailable: true
  };
  if (existing) {
    await prisma.mediaFile.update({ where: { id: existing.id }, data });
    return existing.id;
  }
  const created = await prisma.mediaFile.create({ data });
  report.mediaFilesCreated += 1;
  if (input.movieId) report.filesLinkedToMovies += 1;
  if (input.episodeId) report.filesLinkedToEpisodes += 1;
  return created.id;
}

async function run(mode: "apply" | "report") {
  const settings = mode === "apply" ? await getSettings() : null;
  const report = emptyReport(mode);
  const apply = mode === "apply";
  const [requests, libraryItems] = await Promise.all([
    prisma.mediaRequest.findMany({
      include: REQUEST_RELATION_SELECT
    }).then((rows) => rows.map((row) => hydrateLegacyRequestFields(row))),
    prisma.mediaLibraryItem.findMany({
      select: {
        id: true,
        sourceKey: true,
        identityKey: true,
        mediaType: true,
        movieId: true,
        tvShowId: true,
        seasonId: true,
        episodeId: true,
        title: true,
        year: true,
        tmdbId: true,
        tvdbId: true,
        imdbId: true,
        season: true,
        episode: true,
        requestId: true,
        downloadId: true,
        nzbId: true,
        vfsMountId: true,
        folderPath: true,
        filePath: true,
        symlinkPath: true,
        strmPath: true,
        quality: true,
        source: true,
        codec: true,
        audio: true,
        hdr: true,
        dv: true,
        releaseGroup: true,
        size: true,
        duration: true,
        createdAt: true,
        updatedAt: true,
        libraryStatus: true,
        streamStatus: true,
        healthStatus: true,
        streamCount: true,
        requestedBy: true,
        requestProvider: true,
        importStrategy: true,
        ...LIBRARY_RELATION_SELECT
      }
    }).then((rows) => rows.map((row) => hydrateLegacyMediaFields(row) as typeof row & {
      overview?: string | null;
      posterUrl?: string | null;
      backdropUrl?: string | null;
      episodeTitle?: string | null;
      episodeOverview?: string | null;
      episodeAirDate?: Date | null;
    }))
  ]);

  for (const request of requests) {
    if (mode === "report" && (request.movieId || request.tvShowId || request.seasonId || request.episodeId)) {
      continue;
    }
    const normalizedType = normalizedRequestMediaType(request);
    if (request.mediaType === "movie") {
      const movie = await ensureMovie(report, settings, {
        tmdbId: request.tmdbId,
        imdbId: request.imdbId,
        tvdbId: request.tvdbId,
        title: request.title,
        year: request.year,
        rawSeerr: request
      });
      if (!movie) {
        report.rowsSkippedUnresolvedTarget += 1;
        report.unresolvedRequests.push(request.id);
        continue;
      }
      if (apply) {
        await prisma.mediaRequest.update({
          where: { id: request.id },
          data: {
            movieId: movie.id,
            tvShowId: null,
            seasonId: null,
            episodeId: null,
            rawRequest: asJson({
              providerId: request.providerId,
              externalId: request.externalId,
              requestedBy: request.requestedBy,
              requestedQuality: request.requestedQuality,
              externalStatus: request.externalStatus,
              status: request.status,
              selectedProfileId: request.selectedProfileId,
              selectedRelease: request.selectedRelease
            }),
            rawMedia: asJson({
              mediaType: request.mediaType,
              title: request.title,
              year: request.year,
              tmdbId: request.tmdbId,
              tvdbId: request.tvdbId,
              imdbId: request.imdbId
            })
          }
        });
        report.mediaRequestsLinked += 1;
      }
      continue;
    }

    const show = await ensureShow(report, settings, {
      tmdbId: request.tmdbId,
      imdbId: request.imdbId,
      tvdbId: request.tvdbId,
      title: request.title,
      year: request.year,
      rawSeerr: request
    });
    if (!show) {
      report.rowsSkippedUnresolvedTarget += 1;
      report.unresolvedRequests.push(request.id);
      continue;
    }
    const requestedSeasons = parseSeasonNumbers(request.seasons);
    const requestedEpisodes = parseRequestedEpisodes(request.episodes);
    let seasonId: string | null = null;
    let episodeId: string | null = null;
    if (normalizedType === "season" && requestedSeasons.length === 1) {
      const season = await ensureSeason(report, settings, show, requestedSeasons[0]);
      seasonId = season?.id ?? null;
    }
    if (normalizedType === "episode" && requestedEpisodes.size === 1) {
      const [firstSeason, episodes] = [...requestedEpisodes.entries()][0] ?? [];
      const episodeNumbers = episodes ? [...episodes] : [];
      if (firstSeason != null && episodeNumbers.length === 1) {
        const season = await ensureSeason(report, settings, show, firstSeason);
        if (season) {
          seasonId = season.id;
          const episode = await ensureEpisode(report, settings, show, season, episodeNumbers[0]);
          episodeId = episode?.id ?? null;
        }
      }
    }
    if (apply) {
      await prisma.mediaRequest.update({
        where: { id: request.id },
        data: {
          movieId: null,
          tvShowId: show.id,
          seasonId,
          episodeId,
          rawRequest: asJson({
            providerId: request.providerId,
            externalId: request.externalId,
            requestedBy: request.requestedBy,
            requestedQuality: request.requestedQuality,
            externalStatus: request.externalStatus,
            status: request.status,
            selectedProfileId: request.selectedProfileId,
            selectedRelease: request.selectedRelease,
            seasons: request.seasons,
            episodes: request.episodes
          }),
          rawMedia: asJson({
            mediaType: request.mediaType,
            title: request.title,
            year: request.year,
            tmdbId: request.tmdbId,
            tvdbId: request.tvdbId,
            imdbId: request.imdbId
          })
        }
      });
      report.mediaRequestsLinked += 1;
    }
  }

  for (const item of libraryItems) {
    if (mode === "report" && (item.movieId || item.tvShowId || item.seasonId || item.episodeId)) {
      continue;
    }
    const normalizedType = normalizedLibraryMediaType(item);
    if (item.mediaType === "movie") {
      const movie = await ensureMovie(report, settings, {
        tmdbId: item.tmdbId,
        imdbId: item.imdbId,
        tvdbId: item.tvdbId,
        title: item.title,
        year: item.year,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        rawSeerr: { sourceKey: item.sourceKey, requestId: item.requestId }
      });
      if (!movie) {
        report.rowsSkippedUnresolvedTarget += 1;
        report.unresolvedLibraryItems.push(item.id);
        continue;
      }
      if (apply) {
        await prisma.mediaLibraryItem.update({
          where: { id: item.id },
          data: {
            movieId: movie.id,
            tvShowId: null,
            seasonId: null,
            episodeId: null
          }
        });
        report.mediaLibraryItemsLinked += 1;
      }
      if (apply && (item.filePath || item.symlinkPath || item.strmPath)) {
        await ensureMediaFile(report, {
          mediaType: "movie",
          movieId: movie.id,
          importId: item.sourceKey.startsWith("import:") ? item.sourceKey.slice("import:".length) : undefined,
          downloadId: item.downloadId,
          nzbId: item.nzbId,
          vfsMountId: item.vfsMountId,
          folderPath: item.folderPath,
          filePath: item.filePath,
          symlinkPath: item.symlinkPath,
          strmPath: item.strmPath,
          size: item.size,
          duration: item.duration,
          quality: item.quality,
          source: item.source,
          codec: item.codec,
          audio: item.audio,
          hdr: item.hdr,
          dv: item.dv,
          releaseGroup: item.releaseGroup
        });
      }
      continue;
    }

    const show = await ensureShow(report, settings, {
      tmdbId: item.tmdbId,
      imdbId: item.imdbId,
      tvdbId: item.tvdbId,
      title: item.title,
      year: item.year,
      overview: item.overview,
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      rawSeerr: { sourceKey: item.sourceKey, requestId: item.requestId }
    });
    if (!show) {
      report.rowsSkippedUnresolvedTarget += 1;
      report.unresolvedLibraryItems.push(item.id);
      continue;
    }
    const season = normalizedType === "season" || normalizedType === "episode"
      ? await ensureSeason(report, settings, show, item.season)
      : null;
    const episode = normalizedType === "episode" && season
      ? await ensureEpisode(report, settings, show, season, item.episode)
      : null;
    if (apply) {
      await prisma.mediaLibraryItem.update({
        where: { id: item.id },
        data: {
          movieId: null,
          tvShowId: show.id,
          seasonId: season?.id ?? null,
          episodeId: episode?.id ?? null
        }
      });
      report.mediaLibraryItemsLinked += 1;
    }
    if (apply && episode && (item.filePath || item.symlinkPath || item.strmPath)) {
      await ensureMediaFile(report, {
        mediaType: "episode",
        episodeId: episode.id,
        importId: item.sourceKey.startsWith("import:") ? item.sourceKey.slice("import:".length) : undefined,
        downloadId: item.downloadId,
        nzbId: item.nzbId,
        vfsMountId: item.vfsMountId,
        folderPath: item.folderPath,
        filePath: item.filePath,
        symlinkPath: item.symlinkPath,
        strmPath: item.strmPath,
        size: item.size,
        duration: item.duration,
        quality: item.quality,
        source: item.source,
        codec: item.codec,
        audio: item.audio,
        hdr: item.hdr,
        dv: item.dv,
        releaseGroup: item.releaseGroup
      });
    }
  }

  const [duplicateMovieTmdb, duplicateShowTmdb, unresolvedRequestCount, unresolvedLibraryCount] = await Promise.all([
    prisma.$queryRaw<Array<{ tmdb_id: string; count: bigint }>>`SELECT "tmdb_id", COUNT(*)::bigint AS count FROM "movies" GROUP BY "tmdb_id" HAVING COUNT(*) > 1`,
    prisma.$queryRaw<Array<{ tmdb_id: string; count: bigint }>>`SELECT "tmdb_id", COUNT(*)::bigint AS count FROM "tv_shows" GROUP BY "tmdb_id" HAVING COUNT(*) > 1`,
    prisma.mediaRequest.count({
      where: {
        OR: [
          { movieId: null, tvShowId: null, seasonId: null, episodeId: null }
        ]
      }
    }),
    prisma.mediaLibraryItem.count({
      where: {
        OR: [
          { movieId: null, tvShowId: null, seasonId: null, episodeId: null }
        ]
      }
    })
  ]);
  report.duplicateWarnings.push(
    ...duplicateMovieTmdb.map((row) => `movies tmdb_id duplicate: ${row.tmdb_id} (${row.count.toString()})`),
    ...duplicateShowTmdb.map((row) => `tv_shows tmdb_id duplicate: ${row.tmdb_id} (${row.count.toString()})`)
  );
  report.unresolvedRequests.unshift(`unresolved_count=${unresolvedRequestCount}`);
  report.unresolvedLibraryItems.unshift(`unresolved_count=${unresolvedLibraryCount}`);
  return report;
}

const mode = process.argv.includes("--apply") ? "apply" : "report";

try {
  const report = await run(mode);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    ok: false,
    mode,
    error: message
  }, null, 2));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
