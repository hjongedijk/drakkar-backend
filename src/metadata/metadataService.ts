import type { AppSettings } from "../settings/settingsStore.js";

export type MediaMetadataLookup = {
  mediaType: string;
  title: string;
  year?: number | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
};

export type MediaMetadata = {
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  title?: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
  metadataProvider?: string;
  episodeTitle?: string;
  episodeOverview?: string;
  episodeAirDate?: Date;
};

export type SeriesSeasonStructure = {
  seasonNumber: number;
  name?: string;
  episodeCount: number;
  airDate?: string;
};

export type SeriesStructure = {
  tmdbId?: string;
  tvdbId?: string;
  title?: string;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
  status?: string;
  numberOfSeasons: number;
  numberOfEpisodes: number;
  seasons: SeriesSeasonStructure[];
};

export type DiscoverMediaItem = {
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
};

export type CalendarMediaInfo = {
  mediaType: "movie" | "tv";
  title?: string;
  year?: number;
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  overview?: string;
  releaseDate?: string;
};

type TmdbSearchResult = {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  status?: string;
  number_of_seasons?: number;
  number_of_episodes?: number;
  seasons?: Array<{ season_number?: number; name?: string; episode_count?: number; air_date?: string }>;
};

type TmdbEpisode = {
  episode_number?: number;
  name?: string;
  overview?: string;
  air_date?: string;
  still_path?: string | null;
};

type TvdbToken = {
  token: string;
  expiresAt: number;
};

let tvdbToken: TvdbToken | null = null;

function imageUrl(path?: string | null, size = "w500") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

function yearFromDate(value?: string) {
  const year = value ? Number(value.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : undefined;
}

async function tmdbFetch<T>(settings: AppSettings, path: string, params: Record<string, string | undefined> = {}) {
  if (!settings.tmdbApiKey) return undefined;
  const url = new URL(path, "https://api.themoviedb.org/3/");
  url.searchParams.set("api_key", settings.tmdbApiKey);
  url.searchParams.set("language", settings.metadataLanguage);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`TMDB metadata request failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function resolveTmdb(settings: AppSettings, input: MediaMetadataLookup) {
  if (input.tmdbId) return input.tmdbId;
  const type = input.mediaType === "tv" ? "tv" : "movie";
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(settings, `search/${type}`, {
    query: input.title,
    year: input.mediaType === "movie" && input.year ? String(input.year) : undefined,
    first_air_date_year: input.mediaType === "tv" && input.year ? String(input.year) : undefined
  });
  return data?.results?.[0]?.id ? String(data.results[0].id) : undefined;
}

async function getTmdbMetadata(settings: AppSettings, input: MediaMetadataLookup): Promise<MediaMetadata | undefined> {
  const tmdbId = await resolveTmdb(settings, input);
  if (!tmdbId) return undefined;

  const type = input.mediaType === "tv" ? "tv" : "movie";
  const details = await tmdbFetch<TmdbSearchResult & { imdb_id?: string }>(settings, `${type}/${tmdbId}`, {
    append_to_response: type === "tv" ? "external_ids" : undefined
  });
  if (!details) return undefined;

  const metadata: MediaMetadata = {
    tmdbId,
    imdbId: details.imdb_id,
    title: details.title ?? details.name,
    year: yearFromDate(details.release_date ?? details.first_air_date),
    posterUrl: imageUrl(details.poster_path),
    backdropUrl: imageUrl(details.backdrop_path, "w1280"),
    overview: details.overview,
    metadataProvider: "tmdb"
  };

  const externalIds = details as { external_ids?: { tvdb_id?: number; imdb_id?: string } };
  if (externalIds.external_ids?.tvdb_id) metadata.tvdbId = String(externalIds.external_ids.tvdb_id);
  if (externalIds.external_ids?.imdb_id) metadata.imdbId = externalIds.external_ids.imdb_id;

  if (type === "tv" && input.season != null && input.episode != null) {
    const episode = await tmdbFetch<TmdbEpisode>(settings, `tv/${tmdbId}/season/${input.season}/episode/${input.episode}`);
    if (episode) {
      metadata.episodeTitle = episode.name;
      metadata.episodeOverview = episode.overview;
      metadata.episodeAirDate = episode.air_date ? new Date(episode.air_date) : undefined;
      metadata.backdropUrl = metadata.backdropUrl ?? imageUrl(episode.still_path, "w780");
    }
  }

  return metadata;
}

async function tmdbExternalIds(settings: AppSettings, mediaType: "movie" | "tv", tmdbId: string) {
  if (!settings.tmdbApiKey) return undefined;
  return tmdbFetch<{ imdb_id?: string; tvdb_id?: number }>(settings, `${mediaType}/${tmdbId}/external_ids`);
}

async function getTvdbToken(settings: AppSettings) {
  if (!settings.tvdbApiKey) return undefined;
  if (tvdbToken && tvdbToken.expiresAt > Date.now() + 60_000) return tvdbToken.token;

  const response = await fetch("https://api4.thetvdb.com/v4/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apikey: settings.tvdbApiKey }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`TVDB login failed with HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { token?: string } };
  if (!body.data?.token) return undefined;
  tvdbToken = { token: body.data.token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
  return tvdbToken.token;
}

async function tvdbFetch<T>(settings: AppSettings, path: string) {
  const token = await getTvdbToken(settings);
  if (!token) return undefined;
  const response = await fetch(new URL(path, "https://api4.thetvdb.com/v4/"), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`TVDB metadata request failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function getTvdbMetadata(settings: AppSettings, input: MediaMetadataLookup): Promise<MediaMetadata | undefined> {
  if (!input.tvdbId || input.mediaType !== "tv") return undefined;
  const series = await tvdbFetch<{
    data?: { name?: string; year?: string; overview?: string; image?: string; remoteIds?: { id: string; type: number }[] };
  }>(settings, `series/${input.tvdbId}/extended`);
  const data = series?.data;
  if (!data) return undefined;

  const metadata: MediaMetadata = {
    tvdbId: input.tvdbId,
    title: data.name,
    year: data.year ? Number(data.year) : undefined,
    posterUrl: data.image,
    overview: data.overview,
    imdbId: data.remoteIds?.find((remote) => remote.type === 2)?.id,
    metadataProvider: "tvdb"
  };

  if (input.season != null && input.episode != null) {
    const episodes = await tvdbFetch<{
      data?: { episodes?: { name?: string; overview?: string; aired?: string; seasonNumber?: number; number?: number; image?: string }[] };
    }>(settings, `series/${input.tvdbId}/episodes/default?page=0`);
    const matched = episodes?.data?.episodes?.find((episode) => episode.seasonNumber === input.season && episode.number === input.episode);
    metadata.episodeTitle = matched?.name;
    metadata.episodeOverview = matched?.overview;
    metadata.episodeAirDate = matched?.aired ? new Date(matched.aired) : undefined;
    metadata.backdropUrl = matched?.image;
  }

  return metadata;
}

export async function fetchMediaMetadata(settings: AppSettings, input: MediaMetadataLookup): Promise<MediaMetadata | undefined> {
  const results = await Promise.allSettled([getTmdbMetadata(settings, input), getTvdbMetadata(settings, input)]);
  const tmdb = results[0].status === "fulfilled" ? results[0].value : undefined;
  const tvdb = results[1].status === "fulfilled" ? results[1].value : undefined;
  if (!tmdb && !tvdb) return undefined;
  return { ...tvdb, ...tmdb, tvdbId: tmdb?.tvdbId ?? tvdb?.tvdbId ?? input.tvdbId ?? undefined };
}

export async function fetchSeriesStructure(settings: AppSettings, input: MediaMetadataLookup): Promise<SeriesStructure | undefined> {
  if (input.mediaType !== "tv") return undefined;
  const tmdbId = await resolveTmdb(settings, input);
  if (tmdbId) {
    const details = await tmdbFetch<TmdbSearchResult & { external_ids?: { tvdb_id?: number } }>(settings, `tv/${tmdbId}`, {
      append_to_response: "external_ids"
    });
    if (details) {
      return {
        tmdbId,
        tvdbId: details.external_ids?.tvdb_id ? String(details.external_ids.tvdb_id) : input.tvdbId ?? undefined,
        title: details.name,
        posterUrl: imageUrl(details.poster_path),
        backdropUrl: imageUrl(details.backdrop_path, "w1280"),
        overview: details.overview,
        status: details.status,
        numberOfSeasons: details.number_of_seasons ?? 0,
        numberOfEpisodes: details.number_of_episodes ?? 0,
        seasons: (details.seasons ?? [])
          .filter((season) => (season.season_number ?? 0) > 0)
          .map((season) => ({
            seasonNumber: season.season_number ?? 0,
            name: season.name,
            episodeCount: season.episode_count ?? 0,
            airDate: season.air_date
          }))
      };
    }
  }

  const tvdb = input.tvdbId ? await getTvdbMetadata(settings, input) : undefined;
  if (!tvdb) return undefined;
  return {
    tvdbId: input.tvdbId ?? undefined,
    title: tvdb.title,
    posterUrl: tvdb.posterUrl,
    backdropUrl: tvdb.backdropUrl,
    overview: tvdb.overview,
    status: undefined,
    numberOfSeasons: 0,
    numberOfEpisodes: 0,
    seasons: []
  };
}

export async function fetchSeasonEpisodes(settings: AppSettings, tmdbId: string, seasonNumber: number) {
  const season = await tmdbFetch<{ episodes?: TmdbEpisode[] }>(settings, `tv/${tmdbId}/season/${seasonNumber}`);
  return (season?.episodes ?? []).map((episode) => ({
    episodeNumber: episode.episode_number ?? 0,
    name: episode.name,
    overview: episode.overview,
    airDate: episode.air_date,
    stillUrl: imageUrl(episode.still_path, "w780")
  }));
}

export async function fetchCalendarMediaInfo(settings: AppSettings, input: MediaMetadataLookup): Promise<CalendarMediaInfo | undefined> {
  const tmdbId = await resolveTmdb(settings, input);
  if (tmdbId) {
    const type = input.mediaType === "tv" ? "tv" : "movie";
    const details = await tmdbFetch<TmdbSearchResult & { imdb_id?: string; external_ids?: { tvdb_id?: number; imdb_id?: string } }>(
      settings,
      `${type}/${tmdbId}`,
      { append_to_response: type === "tv" ? "external_ids" : undefined }
    );
    if (details) {
      return {
        mediaType: input.mediaType === "tv" ? "tv" : "movie",
        title: details.title ?? details.name,
        year: yearFromDate(details.release_date ?? details.first_air_date),
        tmdbId,
        tvdbId: details.external_ids?.tvdb_id ? String(details.external_ids.tvdb_id) : input.tvdbId ?? undefined,
        imdbId: details.imdb_id ?? details.external_ids?.imdb_id ?? input.imdbId ?? undefined,
        overview: details.overview,
        releaseDate: details.release_date ?? details.first_air_date
      };
    }
  }

  const fallback = await fetchMediaMetadata(settings, input).catch(() => undefined);
  if (!fallback) return undefined;
  return {
    mediaType: input.mediaType === "tv" ? "tv" : "movie",
    title: fallback.title,
    year: fallback.year,
    tmdbId: fallback.tmdbId,
    tvdbId: fallback.tvdbId,
    imdbId: fallback.imdbId,
    overview: fallback.overview
  };
}

function discoverItemFromTmdb(result: TmdbSearchResult, mediaType: "movie" | "tv", externalIds?: { imdb_id?: string; tvdb_id?: number }): DiscoverMediaItem {
  return {
    mediaType,
    title: result.title ?? result.name ?? "Unknown",
    year: yearFromDate(result.release_date ?? result.first_air_date),
    tmdbId: result.id ? String(result.id) : undefined,
    tvdbId: externalIds?.tvdb_id ? String(externalIds.tvdb_id) : undefined,
    imdbId: externalIds?.imdb_id,
    posterUrl: imageUrl(result.poster_path),
    backdropUrl: imageUrl(result.backdrop_path, "w1280"),
    overview: result.overview
  };
}

export async function fetchDiscoverHome(settings: AppSettings) {
  const [movies, tv] = await Promise.all([
    tmdbFetch<{ results: TmdbSearchResult[] }>(settings, "trending/movie/day"),
    tmdbFetch<{ results: TmdbSearchResult[] }>(settings, "trending/tv/day")
  ]);

  const topMovies = (movies?.results ?? []).slice(0, 12);
  const topTv = (tv?.results ?? []).slice(0, 12);

  const [movieIds, tvIds] = await Promise.all([
    Promise.all(topMovies.map((item) => tmdbExternalIds(settings, "movie", String(item.id)).catch(() => undefined))),
    Promise.all(topTv.map((item) => tmdbExternalIds(settings, "tv", String(item.id)).catch(() => undefined)))
  ]);

  return {
    movies: topMovies.map((item, index) => discoverItemFromTmdb(item, "movie", movieIds[index])),
    tv: topTv.map((item, index) => discoverItemFromTmdb(item, "tv", tvIds[index]))
  };
}

export async function writeImportMetadata(_input: {
  importId: string;
  title: string;
  completedPath: string;
  mediaType: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}) {
  void _input;
  return { metadataPath: null, stableIdPath: null };
}
