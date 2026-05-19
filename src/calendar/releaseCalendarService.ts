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

function requestSeasonNumbers(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const seasons = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const season = record.seasonNumber ?? record.season ?? record.number;
    const parsed = typeof season === "number" ? season : typeof season === "string" ? Number(season) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) seasons.add(parsed);
  }
  return [...seasons].sort((a, b) => a - b);
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

type TrackedSeries = {
  key: string;
  title: string;
  year?: number;
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  requestId?: string;
  seasonNumbers: Set<number>;
};

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

export async function fetchReleaseCalendar(month?: string): Promise<ReleaseCalendarResponse> {
  const range = monthRange(month);
  const cacheKey = `release-calendar:v3:${range.month}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as ReleaseCalendarResponse;

  const settings = await getSettings();
  const startDate = toIsoDate(range.start);
  const endDate = toIsoDate(range.end);

  const libraryItems = (await prisma.mediaLibraryItem.findMany({
    where: {
      OR: [{ sourceKey: { startsWith: "import:" } }, { sourceKey: { startsWith: "request:" } }]
    },
    orderBy: { title: "asc" }
  })).filter((item) => !shouldHideLibraryItem(item));

  const movieMap = new Map<string, { title: string; year?: number; tmdbId?: string; tvdbId?: string; imdbId?: string }>();
  const seriesMap = new Map<string, TrackedSeries>();

  for (const item of libraryItems) {
    const key = trackedKey(item as { mediaType: "movie" | "tv"; tmdbId?: string | null; tvdbId?: string | null; imdbId?: string | null; title: string; year?: number | null });
    if (item.mediaType === "movie") {
      if (!movieMap.has(key)) movieMap.set(key, { title: item.title, year: item.year ?? undefined, tmdbId: item.tmdbId ?? undefined, tvdbId: item.tvdbId ?? undefined, imdbId: item.imdbId ?? undefined });
      continue;
    }
    const tracked = seriesMap.get(key) ?? {
      key,
      title: item.title,
      year: item.year ?? undefined,
      tmdbId: item.tmdbId ?? undefined,
      tvdbId: item.tvdbId ?? undefined,
      imdbId: item.imdbId ?? undefined,
      requestId: item.requestId ?? undefined,
      seasonNumbers: new Set<number>()
    };
    if (typeof item.season === "number" && item.season > 0) tracked.seasonNumbers.add(item.season);
    seriesMap.set(key, tracked);
  }

  const entries: ReleaseCalendarEntry[] = [];

  for (const trackedMovie of movieMap.values()) {
    const info = await fetchCalendarMediaInfo(settings, {
      mediaType: "movie",
      title: trackedMovie.title,
      year: trackedMovie.year,
      tmdbId: trackedMovie.tmdbId,
      tvdbId: trackedMovie.tvdbId,
      imdbId: trackedMovie.imdbId
    }).catch(() => undefined);
    const releaseDate = info?.releaseDate?.slice(0, 10);
    if (!releaseDate || releaseDate < startDate || releaseDate > endDate) continue;
    entries.push({
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
    });
  }

  for (const tracked of seriesMap.values()) {
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
    if (!structure?.tmdbId) continue;

    const seasonNumbers = tracked.seasonNumbers.size > 0
      ? [...tracked.seasonNumbers]
      : structure.seasons.map((season) => season.seasonNumber).filter((season) => season > 0);

    for (const seasonNumber of seasonNumbers) {
      const episodes = await fetchSeasonEpisodes(settings, structure.tmdbId, seasonNumber).catch(() => []);
      for (const episode of episodes) {
        const airDate = episode.airDate?.slice(0, 10);
        if (!airDate || airDate < startDate || airDate > endDate) continue;
        entries.push({
          id: `episode:${tracked.key}:${seasonNumber}:${episode.episodeNumber}`,
          type: "episode",
          title: episode.name || `${tracked.title} S${String(seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`,
          releaseDate: airDate,
          overview: episode.overview,
          mediaType: "tv",
          year: tracked.year ?? info?.year,
          tmdbId: info?.tmdbId ?? tracked.tmdbId ?? structure.tmdbId,
          tvdbId: info?.tvdbId ?? tracked.tvdbId ?? structure.tvdbId,
          imdbId: info?.imdbId ?? tracked.imdbId,
          seriesTitle: tracked.title,
          seasonNumber,
          episodeNumber: episode.episodeNumber
        });
      }
    }
  }

  const deduped = new Map<string, ReleaseCalendarEntry>();
  for (const entry of entries) {
    const key = `${entry.type}:${entry.tmdbId ?? entry.tvdbId ?? entry.title}:${entry.releaseDate}:${entry.seasonNumber ?? ""}:${entry.episodeNumber ?? ""}`;
    if (!deduped.has(key)) deduped.set(key, entry);
  }

  const response: ReleaseCalendarResponse = {
    month: range.month,
    startsOn: startDate,
    endsOn: endDate,
    entries: [...deduped.values()].sort((a, b) =>
      a.releaseDate.localeCompare(b.releaseDate)
      || a.type.localeCompare(b.type)
      || a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
    )
  };

  await redis.set(cacheKey, JSON.stringify(response), "EX", 6 * 60 * 60);
  return response;
}
