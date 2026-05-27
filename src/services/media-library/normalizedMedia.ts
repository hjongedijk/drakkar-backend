import type { Prisma, PrismaClient } from "../../repositories/db/prisma.js";

type TxLike = Prisma.TransactionClient | PrismaClient;

export type NormalizedMediaType = "movie" | "tv" | "season" | "episode";

export type LegacyMetadataShape = {
  mediaType: string;
  title?: string | null;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
  episodeOverview?: string | null;
  episodeAirDate?: Date | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  imdbId?: string | null;
};

export function normalizeTmdbImagePath(value?: string | null) {
  if (!value) return undefined;
  if (value.startsWith("/")) return value;
  const match = value.match(/^https?:\/\/image\.tmdb\.org\/t\/p\/[^/]+(\/.+)$/i);
  if (match?.[1]) return match[1];
  return value.startsWith("http://") || value.startsWith("https://") ? undefined : value;
}

export function buildTmdbImageUrl(path?: string | null, size = "w500") {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith("/") ? `https://image.tmdb.org/t/p/${size}${path}` : path;
}

export function normalizedLibraryMediaType(input: {
  mediaType: string;
  season?: number | null;
  episode?: number | null;
}): NormalizedMediaType {
  if (input.mediaType === "movie") return "movie";
  if (input.season != null && input.episode != null) return "episode";
  if (input.season != null) return "season";
  return "tv";
}

export function normalizedRequestMediaType(input: {
  mediaType: string;
  seasons?: unknown;
  episodes?: unknown;
}): NormalizedMediaType {
  if (input.mediaType === "movie") return "movie";
  if (Array.isArray(input.episodes) && input.episodes.length > 0) return "episode";
  if (Array.isArray(input.seasons) && input.seasons.length > 0) return "season";
  return "tv";
}

function yearFromDate(value?: Date | string | null) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getUTCFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function hydrateLegacyMediaFields<
  T extends LegacyMetadataShape & {
    movie?: {
      tmdbId: string;
      imdbId: string | null;
      tvdbId: string | null;
      title: string;
      overview: string | null;
      year: number | null;
      posterPath: string | null;
      backdropPath: string | null;
      releaseDate: Date | null;
    } | null;
    tvShow?: {
      tmdbId: string;
      imdbId: string | null;
      tvdbId: string | null;
      title: string;
      overview: string | null;
      year: number | null;
      posterPath: string | null;
      backdropPath: string | null;
      firstAirDate: Date | null;
    } | null;
    seasonTarget?: {
      seasonNumber: number;
      title: string | null;
      overview: string | null;
      airDate: Date | null;
      posterPath: string | null;
    } | null;
    episodeTarget?: {
      seasonNumber: number;
      episodeNumber: number;
      title: string;
      overview: string | null;
      airDate: Date | null;
      stillPath: string | null;
    } | null;
  }
>(value: T): T {
  const movie = value.movie;
  const show = value.tvShow;
  const episode = value.episodeTarget;
  const season = value.seasonTarget;
  const normalized = movie ?? show;
  return {
    ...value,
    title: normalized?.title ?? value.title,
    year: normalized?.year ?? yearFromDate(movie?.releaseDate ?? show?.firstAirDate) ?? value.year,
    tmdbId: normalized?.tmdbId ?? value.tmdbId,
    imdbId: normalized?.imdbId ?? value.imdbId,
    tvdbId: normalized?.tvdbId ?? value.tvdbId,
    overview: normalized?.overview ?? season?.overview ?? value.overview,
    posterUrl: buildTmdbImageUrl(season?.posterPath ?? normalized?.posterPath, "w500") ?? value.posterUrl,
    backdropUrl: buildTmdbImageUrl(episode?.stillPath ?? normalized?.backdropPath, episode ? "w780" : "w1280") ?? value.backdropUrl,
    season: season?.seasonNumber ?? episode?.seasonNumber ?? value.season,
    episode: episode?.episodeNumber ?? value.episode,
    episodeTitle: episode?.title ?? value.episodeTitle,
    episodeOverview: episode?.overview ?? value.episodeOverview,
    episodeAirDate: episode?.airDate ?? value.episodeAirDate
  };
}

export function hydrateLegacyRequestFields<
  T extends {
    mediaType: string;
    title?: string | null;
    year?: number | null;
    tmdbId?: string | null;
    tvdbId?: string | null;
    imdbId?: string | null;
    movie?: {
      tmdbId: string;
      imdbId: string | null;
      tvdbId: string | null;
      title: string;
      overview: string | null;
      year: number | null;
    } | null;
    tvShow?: {
      tmdbId: string;
      imdbId: string | null;
      tvdbId: string | null;
      title: string;
      overview: string | null;
      year: number | null;
    } | null;
    seasonTarget?: {
      seasonNumber: number;
      title: string | null;
      overview: string | null;
    } | null;
    episodeTarget?: {
      seasonNumber: number;
      episodeNumber: number;
      title: string;
      overview: string | null;
      airDate: Date | null;
    } | null;
  }
>(value: T): T {
  const normalized = value.movie ?? value.tvShow;
  return {
    ...value,
    title: normalized?.title ?? value.title,
    year: normalized?.year ?? value.year,
    tmdbId: normalized?.tmdbId ?? value.tmdbId,
    imdbId: normalized?.imdbId ?? value.imdbId,
    tvdbId: normalized?.tvdbId ?? value.tvdbId
  };
}

export async function upsertMovie(
  tx: TxLike,
  input: {
    tmdbId: string;
    imdbId?: string | null;
    tvdbId?: string | null;
    title: string;
    originalTitle?: string | null;
    overview?: string | null;
    releaseDate?: Date | null;
    year?: number | null;
    runtimeMinutes?: number | null;
    posterPath?: string | null;
    backdropPath?: string | null;
    rawSeerr?: Prisma.InputJsonValue | null;
    rawTmdb?: Prisma.InputJsonValue | null;
  }
) {
  return tx.movie.upsert({
    where: { tmdbId: input.tmdbId },
    create: {
      tmdbId: input.tmdbId,
      imdbId: input.imdbId ?? undefined,
      tvdbId: input.tvdbId ?? undefined,
      title: input.title,
      originalTitle: input.originalTitle ?? undefined,
      overview: input.overview ?? undefined,
      releaseDate: input.releaseDate ?? undefined,
      year: input.year ?? undefined,
      runtimeMinutes: input.runtimeMinutes ?? undefined,
      posterPath: normalizeTmdbImagePath(input.posterPath) ?? undefined,
      backdropPath: normalizeTmdbImagePath(input.backdropPath) ?? undefined,
      rawSeerr: input.rawSeerr ?? undefined,
      rawTmdb: input.rawTmdb ?? undefined
    },
    update: {
      imdbId: input.imdbId ?? undefined,
      tvdbId: input.tvdbId ?? undefined,
      title: input.title,
      originalTitle: input.originalTitle ?? undefined,
      overview: input.overview ?? undefined,
      releaseDate: input.releaseDate ?? undefined,
      year: input.year ?? undefined,
      runtimeMinutes: input.runtimeMinutes ?? undefined,
      posterPath: normalizeTmdbImagePath(input.posterPath) ?? undefined,
      backdropPath: normalizeTmdbImagePath(input.backdropPath) ?? undefined,
      rawSeerr: input.rawSeerr ?? undefined,
      rawTmdb: input.rawTmdb ?? undefined
    }
  });
}

export async function upsertTvShow(
  tx: TxLike,
  input: {
    tmdbId: string;
    imdbId?: string | null;
    tvdbId?: string | null;
    title: string;
    originalTitle?: string | null;
    overview?: string | null;
    firstAirDate?: Date | null;
    lastAirDate?: Date | null;
    year?: number | null;
    posterPath?: string | null;
    backdropPath?: string | null;
    numberOfSeasons?: number | null;
    numberOfEpisodes?: number | null;
    rawSeerr?: Prisma.InputJsonValue | null;
    rawTmdb?: Prisma.InputJsonValue | null;
  }
) {
  return tx.tvShow.upsert({
    where: { tmdbId: input.tmdbId },
    create: {
      tmdbId: input.tmdbId,
      imdbId: input.imdbId ?? undefined,
      tvdbId: input.tvdbId ?? undefined,
      title: input.title,
      originalTitle: input.originalTitle ?? undefined,
      overview: input.overview ?? undefined,
      firstAirDate: input.firstAirDate ?? undefined,
      lastAirDate: input.lastAirDate ?? undefined,
      year: input.year ?? undefined,
      posterPath: normalizeTmdbImagePath(input.posterPath) ?? undefined,
      backdropPath: normalizeTmdbImagePath(input.backdropPath) ?? undefined,
      numberOfSeasons: input.numberOfSeasons ?? undefined,
      numberOfEpisodes: input.numberOfEpisodes ?? undefined,
      rawSeerr: input.rawSeerr ?? undefined,
      rawTmdb: input.rawTmdb ?? undefined
    },
    update: {
      imdbId: input.imdbId ?? undefined,
      tvdbId: input.tvdbId ?? undefined,
      title: input.title,
      originalTitle: input.originalTitle ?? undefined,
      overview: input.overview ?? undefined,
      firstAirDate: input.firstAirDate ?? undefined,
      lastAirDate: input.lastAirDate ?? undefined,
      year: input.year ?? undefined,
      posterPath: normalizeTmdbImagePath(input.posterPath) ?? undefined,
      backdropPath: normalizeTmdbImagePath(input.backdropPath) ?? undefined,
      numberOfSeasons: input.numberOfSeasons ?? undefined,
      numberOfEpisodes: input.numberOfEpisodes ?? undefined,
      rawSeerr: input.rawSeerr ?? undefined,
      rawTmdb: input.rawTmdb ?? undefined
    }
  });
}

export async function upsertTvSeason(
  tx: TxLike,
  input: {
    tvShowId: string;
    seasonNumber: number;
    tmdbId?: string | null;
    tvdbId?: string | null;
    title?: string | null;
    overview?: string | null;
    airDate?: Date | null;
    posterPath?: string | null;
    episodeCount?: number | null;
    rawSeerr?: Prisma.InputJsonValue | null;
    rawTmdb?: Prisma.InputJsonValue | null;
  }
) {
  return tx.tvSeason.upsert({
    where: {
      tvShowId_seasonNumber: {
        tvShowId: input.tvShowId,
        seasonNumber: input.seasonNumber
      }
    },
    create: {
      tvShowId: input.tvShowId,
      seasonNumber: input.seasonNumber,
      tmdbId: input.tmdbId ?? undefined,
      tvdbId: input.tvdbId ?? undefined,
      title: input.title ?? undefined,
      overview: input.overview ?? undefined,
      airDate: input.airDate ?? undefined,
      posterPath: normalizeTmdbImagePath(input.posterPath) ?? undefined,
      episodeCount: input.episodeCount ?? undefined,
      rawSeerr: input.rawSeerr ?? undefined,
      rawTmdb: input.rawTmdb ?? undefined
    },
    update: {
      tmdbId: input.tmdbId ?? undefined,
      tvdbId: input.tvdbId ?? undefined,
      title: input.title ?? undefined,
      overview: input.overview ?? undefined,
      airDate: input.airDate ?? undefined,
      posterPath: normalizeTmdbImagePath(input.posterPath) ?? undefined,
      episodeCount: input.episodeCount ?? undefined,
      rawSeerr: input.rawSeerr ?? undefined,
      rawTmdb: input.rawTmdb ?? undefined
    }
  });
}

export async function upsertTvEpisode(
  tx: TxLike,
  input: {
    tvShowId: string;
    seasonId: string;
    seasonNumber: number;
    episodeNumber: number;
    tmdbId?: string | null;
    imdbId?: string | null;
    tvdbId?: string | null;
    absoluteEpisodeNumber?: number | null;
    title: string;
    overview?: string | null;
    airDate?: Date | null;
    runtimeMinutes?: number | null;
    stillPath?: string | null;
    rawSeerr?: Prisma.InputJsonValue | null;
    rawTmdb?: Prisma.InputJsonValue | null;
  }
) {
  return tx.tvEpisode.upsert({
    where: {
      tvShowId_seasonNumber_episodeNumber: {
        tvShowId: input.tvShowId,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber
      }
    },
    create: {
      tvShowId: input.tvShowId,
      seasonId: input.seasonId,
      seasonNumber: input.seasonNumber,
      episodeNumber: input.episodeNumber,
      tmdbId: input.tmdbId ?? undefined,
      imdbId: input.imdbId ?? undefined,
      tvdbId: input.tvdbId ?? undefined,
      absoluteEpisodeNumber: input.absoluteEpisodeNumber ?? undefined,
      title: input.title,
      overview: input.overview ?? undefined,
      airDate: input.airDate ?? undefined,
      runtimeMinutes: input.runtimeMinutes ?? undefined,
      stillPath: normalizeTmdbImagePath(input.stillPath) ?? undefined,
      rawSeerr: input.rawSeerr ?? undefined,
      rawTmdb: input.rawTmdb ?? undefined
    },
    update: {
      seasonId: input.seasonId,
      tmdbId: input.tmdbId ?? undefined,
      imdbId: input.imdbId ?? undefined,
      tvdbId: input.tvdbId ?? undefined,
      absoluteEpisodeNumber: input.absoluteEpisodeNumber ?? undefined,
      title: input.title,
      overview: input.overview ?? undefined,
      airDate: input.airDate ?? undefined,
      runtimeMinutes: input.runtimeMinutes ?? undefined,
      stillPath: normalizeTmdbImagePath(input.stillPath) ?? undefined,
      rawSeerr: input.rawSeerr ?? undefined,
      rawTmdb: input.rawTmdb ?? undefined
    }
  });
}
