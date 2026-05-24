import { redis } from "../db/redis.js";
import { prisma } from "../db/prisma.js";
import { fetchCalendarMediaInfo, fetchSeasonEpisodes, fetchSeriesStructure } from "../metadata/metadataService.js";
import { getSettings } from "../settings/settingsStore.js";

type CalendarItemType = "movie" | "show" | "episode";

export type ReleaseCalendarEntry = {
  id: string;
  type: CalendarItemType;
  title: string;
  releaseDate: string;
  overview?: string;
  mediaType: "movie" | "tv";
  year?: number;
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
};

export type ReleaseCalendarResponse = {
  month: string;
  startsOn: string;
  endsOn: string;
  entries: ReleaseCalendarEntry[];
};

type TrackedSeries = {
  key: string;
  title: string;
  year?: number;
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  seasonNumbers: Set<number>;
};

type TrackedMovie = {
  key: string;
  title: string;
  year?: number;
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
};

type KnownEpisode = {
  releaseDate: string;
  entry: ReleaseCalendarEntry;
};

const CALENDAR_CACHE_TTL_SECONDS = 6 * 60 * 60;
const CALENDAR_FETCH_CONCURRENCY = 8;

function monthRange(month?: string) {
  const match = month?.match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const monthIndex = match ? Number(match[2]) - 1 : now.getUTCMonth();
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return {
    month: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    start,
    end
  };
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function trackedKey(input: { mediaType: "movie" | "tv"; tmdbId?: string | null; tvdbId?: string | null; imdbId?: string | null; title: string; year?: number | null }) {
  if (input.imdbId) return `${input.mediaType}:imdb:${input.imdbId}`;
  if (input.tmdbId) return `${input.mediaType}:tmdb:${input.tmdbId}`;
  if (input.tvdbId) return `${input.mediaType}:tvdb:${input.tvdbId}`;
  return `${input.mediaType}:${input.title.toLowerCase()}:${input.year ?? ""}`;
}

function shouldHideLibraryItem(input: {
  sourceKey: string;
  title: string;
  requestId?: string | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  imdbId?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
}) {
  const suspiciousTitle = /&quot;|^\s*\d+\]\s*|^[a-z0-9]{20,}$/i.test(input.title);
  const hasMetadata = Boolean(input.requestId || input.tmdbId || input.tvdbId || input.imdbId || input.posterUrl || input.backdropUrl);
  return input.sourceKey.startsWith("import:") && suspiciousTitle && !hasMetadata;
}

async function mapWithConcurrency<T, R>(input: T[], concurrency: number, worker: (value: T, index: number) => Promise<R>) {
  const limit = Math.max(1, Math.min(concurrency, input.length || 1));
  const results = new Array<R>(input.length);
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < input.length) {
      const index = cursor;
      const value = input[index];
      cursor += 1;
      results[index] = await worker(value as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function recordMovie(movieMap: Map<string, TrackedMovie>, item: { title: string; year?: number | null; tmdbId?: string | null; tvdbId?: string | null; imdbId?: string | null }) {
  const key = trackedKey({ mediaType: "movie", ...item });
  if (!movieMap.has(key)) {
    movieMap.set(key, {
      key,
      title: item.title,
      year: item.year ?? undefined,
      tmdbId: item.tmdbId ?? undefined,
      tvdbId: item.tvdbId ?? undefined,
      imdbId: item.imdbId ?? undefined
    });
  }
}

function recordSeries(seriesMap: Map<string, TrackedSeries>, item: { title: string; year?: number | null; tmdbId?: string | null; tvdbId?: string | null; imdbId?: string | null; season?: number | null }) {
  const key = trackedKey({ mediaType: "tv", ...item });
  const tracked = seriesMap.get(key) ?? {
    key,
    title: item.title,
    year: item.year ?? undefined,
    tmdbId: item.tmdbId ?? undefined,
    tvdbId: item.tvdbId ?? undefined,
    imdbId: item.imdbId ?? undefined,
    seasonNumbers: new Set<number>()
  };
  if (typeof item.season === "number" && item.season > 0) tracked.seasonNumbers.add(item.season);
  seriesMap.set(key, tracked);
}

function knownEpisodeKey(entry: Pick<ReleaseCalendarEntry, "seriesTitle" | "tmdbId" | "tvdbId" | "title" | "releaseDate" | "seasonNumber" | "episodeNumber">) {
  return `${entry.tmdbId ?? entry.tvdbId ?? entry.seriesTitle ?? entry.title}:${entry.releaseDate}:${entry.seasonNumber ?? ""}:${entry.episodeNumber ?? ""}`;
}

export async function fetchReleaseCalendar(month?: string): Promise<ReleaseCalendarResponse> {
  const range = monthRange(month);
  const cacheKey = `release-calendar:v4:${range.month}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached) as ReleaseCalendarResponse;

  const settings = await getSettings();
  const startDate = toIsoDate(range.start);
  const endDate = toIsoDate(range.end);

  const [libraryItems, requests] = await Promise.all([
    prisma.mediaLibraryItem.findMany({
      where: {
        OR: [{ sourceKey: { startsWith: "import:" } }, { sourceKey: { startsWith: "request:" } }]
      },
      orderBy: { title: "asc" }
    }),
    prisma.mediaRequest.findMany({
      where: {
        status: { not: "rejected" }
      },
      orderBy: { title: "asc" }
    })
  ]);

  const movieMap = new Map<string, TrackedMovie>();
  const seriesMap = new Map<string, TrackedSeries>();
  const knownEpisodes = new Map<string, KnownEpisode>();

  for (const item of libraryItems) {
    if (shouldHideLibraryItem(item)) continue;
    if (item.mediaType === "movie") {
      recordMovie(movieMap, item);
      continue;
    }

    recordSeries(seriesMap, item);

    if (item.episodeAirDate && typeof item.season === "number" && typeof item.episode === "number") {
      const releaseDate = toIsoDate(item.episodeAirDate);
      if (releaseDate >= startDate && releaseDate <= endDate) {
        const entry: ReleaseCalendarEntry = {
          id: `episode:${item.sourceKey}`,
          type: "episode",
          title: item.episodeTitle || `${item.title} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`,
          releaseDate,
          overview: item.episodeOverview ?? item.overview ?? undefined,
          mediaType: "tv",
          year: item.year ?? undefined,
          tmdbId: item.tmdbId ?? undefined,
          tvdbId: item.tvdbId ?? undefined,
          imdbId: item.imdbId ?? undefined,
          seriesTitle: item.title,
          seasonNumber: item.season,
          episodeNumber: item.episode
        };
        knownEpisodes.set(knownEpisodeKey(entry), { releaseDate, entry });
      }
    }
  }

  for (const request of requests) {
    if (request.mediaType === "movie") {
      recordMovie(movieMap, request);
      continue;
    }
    recordSeries(seriesMap, request);
  }

  const movieEntries = (await mapWithConcurrency<TrackedMovie, ReleaseCalendarEntry | null>([...movieMap.values()], CALENDAR_FETCH_CONCURRENCY, async (trackedMovie) => {
    const info = await fetchCalendarMediaInfo(settings, {
      mediaType: "movie",
      title: trackedMovie.title,
      year: trackedMovie.year,
      tmdbId: trackedMovie.tmdbId,
      tvdbId: trackedMovie.tvdbId,
      imdbId: trackedMovie.imdbId
    }).catch(() => undefined);
    const releaseDate = info?.releaseDate?.slice(0, 10);
    if (!releaseDate || releaseDate < startDate || releaseDate > endDate) return null;
    return {
      id: `movie:${info?.tmdbId ?? trackedMovie.title}:${releaseDate}`,
      type: "movie",
      title: info?.title ?? trackedMovie.title,
      releaseDate,
      overview: info?.overview,
      mediaType: "movie",
      year: info?.year ?? trackedMovie.year,
      tmdbId: info?.tmdbId ?? trackedMovie.tmdbId,
      tvdbId: info?.tvdbId ?? trackedMovie.tvdbId,
      imdbId: info?.imdbId ?? trackedMovie.imdbId
    };
  })).filter(isDefined);

  const showAndEpisodeEntries = (await mapWithConcurrency([...seriesMap.values()], CALENDAR_FETCH_CONCURRENCY, async (tracked) => {
    const entries: ReleaseCalendarEntry[] = [];
    const info = await fetchCalendarMediaInfo(settings, {
      mediaType: "tv",
      title: tracked.title,
      year: tracked.year,
      tmdbId: tracked.tmdbId,
      tvdbId: tracked.tvdbId,
      imdbId: tracked.imdbId
    }).catch(() => undefined);

    const showReleaseDate = info?.releaseDate?.slice(0, 10);
    if (showReleaseDate && showReleaseDate >= startDate && showReleaseDate <= endDate) {
      entries.push({
        id: `show:${info?.tmdbId ?? tracked.title}:${showReleaseDate}`,
        type: "show",
        title: info?.title ?? tracked.title,
        releaseDate: showReleaseDate,
        overview: info?.overview,
        mediaType: "tv",
        year: info?.year ?? tracked.year,
        tmdbId: info?.tmdbId ?? tracked.tmdbId,
        tvdbId: info?.tvdbId ?? tracked.tvdbId,
        imdbId: info?.imdbId ?? tracked.imdbId
      });
    }

    const structure = await fetchSeriesStructure(settings, {
      mediaType: "tv",
      title: tracked.title,
      year: tracked.year,
      tmdbId: info?.tmdbId ?? tracked.tmdbId,
      tvdbId: info?.tvdbId ?? tracked.tvdbId,
      imdbId: info?.imdbId ?? tracked.imdbId
    }).catch(() => undefined);
    if (!structure?.tmdbId) return entries;

    const seasonNumbers = tracked.seasonNumbers.size > 0
      ? [...tracked.seasonNumbers]
      : structure.seasons.map((season) => season.seasonNumber).filter((season) => season > 0);

    const seasons = await mapWithConcurrency(seasonNumbers, 4, async (seasonNumber) => {
      const episodes = await fetchSeasonEpisodes(settings, structure.tmdbId as string, seasonNumber).catch(() => []);
      return { seasonNumber, episodes };
    });

    for (const season of seasons) {
      for (const episode of season.episodes) {
        const airDate = episode.airDate?.slice(0, 10);
        if (!airDate || airDate < startDate || airDate > endDate) continue;
        const entry: ReleaseCalendarEntry = {
          id: `episode:${tracked.key}:${season.seasonNumber}:${episode.episodeNumber}`,
          type: "episode",
          title: episode.name || `${tracked.title} S${String(season.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`,
          releaseDate: airDate,
          overview: episode.overview,
          mediaType: "tv",
          year: tracked.year ?? info?.year,
          tmdbId: info?.tmdbId ?? tracked.tmdbId ?? structure.tmdbId,
          tvdbId: info?.tvdbId ?? tracked.tvdbId ?? structure.tvdbId,
          imdbId: info?.imdbId ?? tracked.imdbId,
          seriesTitle: tracked.title,
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber
        };
        if (!knownEpisodes.has(knownEpisodeKey(entry))) entries.push(entry);
      }
    }

    return entries;
  })).flat();

  const deduped = new Map<string, ReleaseCalendarEntry>();
  const allEntries: ReleaseCalendarEntry[] = [
    ...movieEntries,
    ...showAndEpisodeEntries,
    ...[...knownEpisodes.values()].map((item) => item.entry)
  ];
  for (const entry of allEntries) {
    const key = `${entry.type}:${entry.tmdbId ?? entry.tvdbId ?? entry.seriesTitle ?? entry.title}:${entry.releaseDate}:${entry.seasonNumber ?? ""}:${entry.episodeNumber ?? ""}`;
    if (!deduped.has(key)) deduped.set(key, entry);
  }

  const response: ReleaseCalendarResponse = {
    month: range.month,
    startsOn: startDate,
    endsOn: endDate,
    entries: [...deduped.values()].sort((a, b) =>
      a.releaseDate.localeCompare(b.releaseDate)
      || a.type.localeCompare(b.type)
      || (a.seriesTitle ?? a.title).localeCompare(b.seriesTitle ?? b.title, undefined, { sensitivity: "base" })
      || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0)
    )
  };

  await redis.set(cacheKey, JSON.stringify(response), "EX", CALENDAR_CACHE_TTL_SECONDS).catch(() => undefined);
  return response;
}
