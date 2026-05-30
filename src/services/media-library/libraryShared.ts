import type { MediaLibraryItem } from "../../repositories/db/prisma.js";

export const LIBRARY_LIST_SELECT = {
  id: true,
  sourceKey: true,
  identityKey: true,
  mediaType: true,
  movieId: true,
  tvShowId: true,
  seasonId: true,
  episodeId: true,
  title: true,
  tmdbId: true,
  tvdbId: true,
  imdbId: true,
  year: true,
  season: true,
  episode: true,
  requestedBy: true,
  requestProvider: true,
  requestId: true,
  qualityProfileId: true,
  downloadId: true,
  importStrategy: true,
  libraryStatus: true,
  streamStatus: true,
  healthStatus: true,
  folderPath: true,
  filePath: true,
  symlinkPath: true,
  strmPath: true,
  quality: true,
  source: true,
  codec: true,
  audio: true,
  releaseGroup: true,
  size: true,
  lastStreamedAt: true,
  streamCount: true,
  createdAt: true,
  updatedAt: true,
  movie: {
    select: {
      tmdbId: true,
      imdbId: true,
      tvdbId: true,
      title: true,
      overview: true,
      year: true,
      posterPath: true,
      backdropPath: true,
      releaseDate: true
    }
  },
  tvShow: {
    select: {
      tmdbId: true,
      imdbId: true,
      tvdbId: true,
      title: true,
      overview: true,
      year: true,
      posterPath: true,
      backdropPath: true,
      firstAirDate: true
    }
  },
  seasonTarget: {
    select: {
      seasonNumber: true,
      title: true,
      overview: true,
      airDate: true,
      posterPath: true
    }
  },
  episodeTarget: {
    select: {
      seasonNumber: true,
      episodeNumber: true,
      title: true,
      overview: true,
      airDate: true,
      stillPath: true
    }
  }
} as const;

export const REQUEST_LIBRARY_RELATION_SELECT = {
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

export function sortTitle(title: string) {
  return title.replace(/^(the|a|an)\s+/i, "").toLowerCase();
}

export async function mapWithConcurrency<TInput, TOutput>(
  input: TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>
) {
  const output = new Array<TOutput>(input.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, input.length || 1)) }, async () => {
    while (nextIndex < input.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      output[currentIndex] = await mapper(input[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return output;
}

export function statusFromRequest(status: string, hasFilesystemEntry = false) {
  if (status === "grabbed") return "grabbed";
  if (status === "available") return hasFilesystemEntry ? "available" : "grabbed";
  if (status === "no_release_found") return "missing";
  if (status.includes("failed") || status.includes("rejected") || status.includes("blocklisted")) return "failed";
  if (status === "approved") return "searching";
  return "requested";
}

export function statusFromRequestAndDownload(input: {
  requestStatus: string;
  downloadStatus?: string | null;
  hasFilesystemEntry?: boolean;
}) {
  if (input.downloadStatus === "available" || input.downloadStatus === "completed") return "available";
  if (input.downloadStatus === "failed" || input.downloadStatus === "cancelled" || input.downloadStatus === "replaced") {
    return input.requestStatus === "no_release_found" ? "missing" : "searching";
  }
  return statusFromRequest(input.requestStatus, input.hasFilesystemEntry ?? false);
}

export function healthFromStatus(status: string) {
  if (status === "available") return "healthy";
  if (status.includes("duplicate")) return "duplicate";
  if (status.includes("no_video")) return "no_video_content";
  if (status.includes("failed")) return "import_failed";
  return "unknown";
}

export function selectedReleaseField(selectedRelease: unknown, key: string) {
  if (!selectedRelease || typeof selectedRelease !== "object") return undefined;
  const value = (selectedRelease as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function selectedReleaseBoolean(selectedRelease: unknown, key: string) {
  if (!selectedRelease || typeof selectedRelease !== "object") return false;
  return Boolean((selectedRelease as Record<string, unknown>)[key]);
}

export function importStrategy(status?: string | null) {
  return status === "ok" ? "symlink" : status ?? undefined;
}

export function shouldHideLibraryItem(item: {
  sourceKey: string;
  title: string;
  requestId?: string | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  imdbId?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
}) {
  const releaseStyleTitle = /\bS\d{1,2}E\d{1,4}(?:E\d{1,4}|[- .]E?\d{1,4})?\b/i.test(item.title)
    && /\b(2160p|1080p|720p|web-?dl|webrip|bluray|h\.?264|x264|x265|hevc|ddp|dts)\b/i.test(item.title);
  const suspiciousTitle = /&quot;|^\s*\d+\]\s*|^[a-z0-9]{20,}$/i.test(item.title) || releaseStyleTitle;
  const placeholderRequestTitle = /^Request \d+$/i.test(item.title.trim());
  const hasMetadata = Boolean(item.requestId || item.tmdbId || item.tvdbId || item.imdbId || item.posterUrl || item.backdropUrl);
  if (item.sourceKey.startsWith("request:") && placeholderRequestTitle && !item.posterUrl && !item.backdropUrl) return true;
  return item.sourceKey.startsWith("import:") && suspiciousTitle && !hasMetadata;
}

export function libraryItemPriority(item: MediaLibraryItem) {
  const statusWeight: Record<string, number> = {
    available: 600,
    grabbed: 500,
    searching: 400,
    requested: 300,
    approved: 250,
    missing: 200,
    failed: 100
  };
  const sourceWeight = item.sourceKey.startsWith("import:") ? 40 : 0;
  const fileWeight = item.filePath ? 20 : 0;
  const requestWeight = item.requestId ? 10 : 0;
  return (statusWeight[item.libraryStatus] ?? 0) + sourceWeight + fileWeight + requestWeight;
}
