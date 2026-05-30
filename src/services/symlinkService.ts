import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { env } from "../services/config/env.js";
import { prisma, Prisma, type ImportItem } from "../repositories/db/prisma.js";
import { canonicalizeDisplayTitle, inferMediaIdentity, normalizeTitleForIdentity, titlesLikelyMatch } from "../services/media-library/identity.js";
import { hydrateLegacyRequestFields } from "../services/media-library/normalizedMedia.js";
import { fetchMediaMetadata, fetchSeriesStructure } from "../services/metadataService.js";
import { completedPathFor, completedPathToVfsPath, getNamingSettings, libraryPathFor } from "../services/namingService.js";
import { getPolicySettings } from "../services/policyService.js";
import { refreshPlexPath } from "../services/plexService.js";
import { forgetRcloneVfsPaths, libraryForgetPaths } from "../services/rcloneRcService.js";
import { blocklistSelectedRelease, grabBestForRequest, grabMissingTvForRequest, grabTvEpisodeForRequest } from "../services/requests/sync/mediaRequestService.js";
import { getSettings } from "../services/settings/settingsStore.js";
import { scheduleSubtitleSyncForLibraryPath } from "../services/subtitleService.js";
import { probeMediaFile } from "../services/mediaProbeService.js";
import type { AppSettings } from "../services/settings/settingsStore.js";

const REQUEST_RELATION_SELECT = {
  movie: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true } },
  tvShow: { select: { tmdbId: true, imdbId: true, tvdbId: true, title: true, overview: true, year: true } },
  seasonTarget: { select: { seasonNumber: true, title: true, overview: true } },
  episodeTarget: { select: { seasonNumber: true, episodeNumber: true, title: true, overview: true, airDate: true } }
} as const;

async function normalizedMediaFromExistingFileLink(importId: string) {
  const existing = await prisma.mediaFile.findFirst({
    where: { importId },
    select: {
      movie: {
        select: {
          title: true,
          year: true,
          tmdbId: true,
          tvdbId: true
        }
      },
      episode: {
        select: {
          seasonNumber: true,
          episodeNumber: true,
          season: {
            select: {
              tvShow: {
                select: {
                  title: true,
                  year: true,
                  tmdbId: true,
                  tvdbId: true
                }
              }
            }
          }
        }
      }
    }
  });
  if (existing?.movie) {
    return {
      mediaType: "movie" as const,
      title: existing.movie.title,
      year: existing.movie.year ?? undefined,
      season: undefined,
      episode: undefined,
      tmdbId: existing.movie.tmdbId ?? undefined,
      tvdbId: existing.movie.tvdbId ?? undefined
    };
  }
  if (existing?.episode?.season.tvShow) {
    return {
      mediaType: "tv" as const,
      title: existing.episode.season.tvShow.title,
      year: existing.episode.season.tvShow.year ?? undefined,
      season: existing.episode.seasonNumber,
      episode: existing.episode.episodeNumber,
      tmdbId: existing.episode.season.tvShow.tmdbId ?? undefined,
      tvdbId: existing.episode.season.tvShow.tvdbId ?? undefined
    };
  }
  return null;
}

function fallbackMediaTitle(value?: string | null) {
  if (!value) return undefined;
  const prefix = value.split(/\bS\d{1,2}E\d{1,4}\b/i)[0] ?? value;
  const cleaned = prefix
    .replace(/[._]+/g, " ")
    .replace(/\s+-\s+[A-Za-z0-9]+$/, "")
    .trim();
  return canonicalizeDisplayTitle(cleaned) || undefined;
}

function normalizeLookupTitle(value?: string | null) {
  if (!value) return undefined;
  return canonicalizeDisplayTitle(value)
    .replace(/\(\d{4}\)\s*$/g, "")
    .replace(/\($/g, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || undefined;
}

function lookupTitleVariants(value: string, year?: number | null) {
  return new Set(
    [
      value,
      canonicalizeDisplayTitle(value),
      canonicalizeDisplayTitle(value, year),
      normalizeLookupTitle(value)
    ]
      .filter((item): item is string => Boolean(item))
      .map((item) => normalizeTitleForIdentity(item))
      .filter(Boolean)
  );
}

function selectedReleaseIsAmbiguousAnime(
  request: { mediaType: string; year?: number | null; selectedRelease?: unknown },
  downloadTitle?: string | null
) {
  if (request.mediaType !== "tv" || !request.year || !request.selectedRelease || typeof request.selectedRelease !== "object") return false;
  const release = request.selectedRelease as Record<string, unknown>;
  const category = typeof release.category === "string" ? release.category : "";
  const title = typeof release.title === "string" ? release.title : downloadTitle ?? "";
  if (!/\banime\b/i.test(category) || new RegExp(`\\b${request.year}\\b`).test(title)) return false;
  return !release.imdbId && !release.tmdbId && !release.tvdbId;
}

export async function resolveImportMedia(item: ImportItem) {
  const request = item.requestId
    ? await prisma.mediaRequest.findUnique({
        where: { id: item.requestId },
        include: REQUEST_RELATION_SELECT
      }).then((value) => value ? hydrateLegacyRequestFields(value) : null)
    : null;
  const download = item.downloadId ? await prisma.download.findUnique({ where: { id: item.downloadId } }) : null;
  const linkedMedia = await normalizedMediaFromExistingFileLink(item.id);
  const settings = await getSettings();
  const requestForcesMovie = request?.mediaType === "movie";
  const compactTitle = item.title.trim();
  const releaseStyleTitle = /\bS\d{1,2}E\d{1,4}(?:E\d{1,4}|[- .]E?\d{1,4})?\b/i.test(item.title)
    && /\b(2160p|1080p|720p|web-?dl|webrip|bluray|h\.?264|x264|x265|hevc|ddp|dts)\b/i.test(item.title);
  const suspiciousTitle = !item.title
    || /^[a-z0-9]+-[a-z0-9-]+$/i.test(item.title)
    || (/^[a-z0-9]{8,19}$/i.test(compactTitle) && /[a-z]/.test(compactTitle) && /[A-Z]/.test(compactTitle) && /\d/.test(compactTitle))
    || (!request && /^[a-z]{10,19}$/i.test(compactTitle) && /[a-z]/.test(compactTitle) && /[A-Z]/.test(compactTitle))
    || releaseStyleTitle
    || /\($/.test(item.title.trim());
  const downloadIdentity = download?.title ? inferMediaIdentity(download.title) : null;
  const shouldTrustDownloadIdentity = !requestForcesMovie && (
    suspiciousTitle
    || (item.mediaType === "movie" && (item.season !== null || item.episode !== null))
    || downloadIdentity?.mediaType === "tv"
  );
  const inferredIdentity = !requestForcesMovie && (item.mediaType === "tv" || shouldTrustDownloadIdentity || downloadIdentity?.mediaType === "tv")
    ? inferMediaIdentity(`${item.completedPath} ${download?.title ?? ""}`)
    : downloadIdentity;
  const titleFallback = suspiciousTitle
    ? downloadIdentity?.title ?? fallbackMediaTitle(download?.title) ?? item.title
    : item.title;
  const media = linkedMedia ?? {
    mediaType: requestForcesMovie
      ? "movie"
      : shouldTrustDownloadIdentity && downloadIdentity?.mediaType !== "unknown"
        ? downloadIdentity?.mediaType ?? item.mediaType
        : item.mediaType,
    title: canonicalizeDisplayTitle(titleFallback, item.year),
    year: item.year ?? (inferredIdentity?.mediaType === "movie" ? inferredIdentity.year : undefined),
    season: requestForcesMovie ? undefined : item.season ?? (inferredIdentity?.mediaType === "tv" ? inferredIdentity.season : undefined),
    episode: requestForcesMovie ? undefined : item.episode ?? (inferredIdentity?.mediaType === "tv" ? inferredIdentity.episode : undefined),
    tmdbId: undefined as string | undefined,
    tvdbId: undefined as string | undefined
  };

  const requestCandidate = request ? {
    title: request.title,
    year: request.year ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined
  } : null;
  const requestCandidateMatches = requestCandidate
    ? !selectedReleaseIsAmbiguousAnime(request!, download?.title) && await metadataCandidateMatchesMedia(settings, media, requestCandidate)
    : false;
  if (requestCandidate && requestCandidateMatches) {
    media.title = canonicalizeDisplayTitle(requestCandidate.title ?? media.title, requestCandidate.year ?? media.year);
    media.year = media.year ?? requestCandidate.year;
    media.tmdbId = requestCandidate.tmdbId ?? media.tmdbId;
    media.tvdbId = requestCandidate.tvdbId ?? media.tvdbId;
  } else if (request && request.downloadId && request.downloadId === item.downloadId) {
    await prisma.$transaction(async (tx) => {
      await tx.importItem.update({ where: { id: item.id }, data: { requestId: null } });
      await tx.mediaRequest.update({
        where: { id: request.id },
        data: { status: "approved", downloadId: null, selectedRelease: Prisma.JsonNull }
      });
    }).catch(() => undefined);
    item.requestId = null;
  }

  const knownMetadata = await findKnownMetadataForMedia(media, settings);
  if (knownMetadata) {
    media.title = knownMetadata.title ?? media.title;
    media.year = media.year ?? knownMetadata.year ?? undefined;
    media.tmdbId = media.tmdbId ?? knownMetadata.tmdbId ?? undefined;
    media.tvdbId = media.tvdbId ?? knownMetadata.tvdbId ?? undefined;
  }

  const needsMetadata = !media.year || (media.mediaType === "movie" ? !media.tmdbId : !media.tvdbId);
  if (!needsMetadata) return media;
  const lookupTitle = normalizeLookupTitle(titleFallback) ?? normalizeLookupTitle(media.title) ?? media.title;
  const lookupYear = request?.year
    ?? (media.mediaType === "tv" && !media.tvdbId ? undefined : suspiciousTitle ? undefined : media.year);
  const metadataLookup = {
    mediaType: media.mediaType,
    title: lookupTitle,
    year: lookupYear,
    season: media.season,
    episode: media.episode,
    tmdbId: media.tmdbId,
    tvdbId: media.tvdbId,
    imdbId: request?.imdbId
  };
  let metadata = await fetchMediaMetadata(settings, metadataLookup).catch(() => undefined);
  if (metadata && !(await metadataCandidateMatchesMedia(settings, media, metadata))) {
    metadata = undefined;
  }

  if (!metadata) {
    if ((titleFallback && titleFallback !== item.title) || media.season !== item.season || media.episode !== item.episode) {
      await prisma.importItem.update({
        where: { id: item.id },
        data: {
          mediaType: media.mediaType,
          title: media.title,
          year: media.year,
          season: media.season,
          episode: media.episode
        }
      }).catch(() => undefined);
    }
    return media;
  }

  const nextMedia = {
    ...media,
    title: canonicalizeDisplayTitle(metadata.title ?? media.title, metadata.year ?? media.year),
    year: metadata.year ?? media.year,
    tmdbId: media.tmdbId ?? metadata.tmdbId,
    tvdbId: media.tvdbId ?? metadata.tvdbId
  };

  await prisma.importItem.update({
    where: { id: item.id },
    data: {
      mediaType: nextMedia.mediaType,
      title: nextMedia.title,
      year: nextMedia.year,
      season: nextMedia.season,
      episode: nextMedia.episode
    }
  }).catch(() => undefined);

  return nextMedia;
}

async function findKnownMetadataForMedia(media: {
  mediaType: string;
  title: string;
  year?: number | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  season?: number | null;
  episode?: number | null;
}, settings: AppSettings) {
  if (media.tmdbId || media.tvdbId || !media.title) return null;
  const normalizedTitles = lookupTitleVariants(media.title, media.year);
  const [normalizedCandidates, requestCandidates] = await Promise.all([
    media.mediaType === "movie"
      ? prisma.movie.findMany({
          where: {
            year: media.year ?? undefined
          },
          select: { title: true, year: true, tmdbId: true, tvdbId: true }
        })
      : prisma.tvShow.findMany({
          where: {
            year: media.year ?? undefined
          },
          select: { title: true, year: true, tmdbId: true, tvdbId: true }
        }),
    prisma.mediaRequest.findMany({
      where: {
        mediaType: media.mediaType,
        year: media.year ?? undefined,
        OR: [{ tmdbId: { not: null } }, { tvdbId: { not: null } }]
      },
      select: { title: true, year: true, tmdbId: true, tvdbId: true }
    })
  ]);
  for (const candidate of [...normalizedCandidates, ...requestCandidates]) {
    if (![...lookupTitleVariants(candidate.title, candidate.year)].some((title) => normalizedTitles.has(title))) continue;
    if (await metadataCandidateMatchesMedia(settings, media, candidate)) return candidate;
  }
  return null;
}

function seriesStructureAllowsEpisode(
  seasonNumber: number | null | undefined,
  episodeNumber: number | null | undefined,
  structure: Awaited<ReturnType<typeof fetchSeriesStructure>>
) {
  if (seasonNumber == null || episodeNumber == null) return true;
  if (!structure || !structure.seasons.length) return true;
  const season = structure.seasons.find((entry) => entry.seasonNumber === seasonNumber);
  if (!season) return false;
  if (!season.episodeCount || season.episodeCount <= 0) return true;
  return episodeNumber <= season.episodeCount;
}

async function metadataCandidateMatchesMedia(
  settings: AppSettings,
  media: {
    mediaType: string;
    title: string;
    year?: number | null;
    season?: number | null;
    episode?: number | null;
  },
  candidate: {
    title?: string | null;
    year?: number | null;
    tmdbId?: string | null;
    tvdbId?: string | null;
  }
) {
  const mediaTitle = normalizeTitleForIdentity(media.title);
  const candidateTitle = normalizeTitleForIdentity(candidate.title ?? "");
  if (!mediaTitle || !candidateTitle) return false;
  const titleMatches = titlesLikelyMatch(media.title, candidate.title ?? "");

  if (!titleMatches) return false;
  if (media.mediaType === "movie") return !(media.year != null && candidate.year != null && media.year !== candidate.year);
  if (media.mediaType !== "tv" || media.season == null || media.episode == null) return true;
  if (media.year != null && candidate.year != null && media.year !== candidate.year) return false;
  const structure = await fetchSeriesStructure(settings, {
    mediaType: "tv",
    title: candidate.title ?? media.title,
    year: candidate.year ?? media.year,
    tmdbId: candidate.tmdbId ?? undefined,
    tvdbId: candidate.tvdbId ?? undefined,
    season: media.season,
    episode: media.episode
  }).catch(() => undefined);
  if (structure) return seriesStructureAllowsEpisode(media.season, media.episode, structure);
  return !candidate.tmdbId && !candidate.tvdbId && media.year != null && candidate.year != null && media.year === candidate.year;
}

async function removeExisting(path: string) {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // Missing paths are fine; mismatched existing files get replaced by the selected strategy.
  }
}

async function pruneEmptyParents(startPath: string, rootPath: string) {
  let current = dirname(startPath);
  const normalizedRoot = rootPath.replace(/\/+$/, "");
  while (current.startsWith(normalizedRoot) && current !== normalizedRoot) {
    const remaining = await readdir(current).catch(() => null);
    if (!remaining || remaining.length > 0) break;
    await rmdir(current).catch(() => undefined);
    current = dirname(current);
  }
}

function strmContents(item: ImportItem) {
  const vfsPath = item.completedPath.startsWith("/mounted/") ? item.completedPath : completedPathToVfsPath(item.completedPath);
  if (!vfsPath) return item.completedPath;
  const base = env.APP_BASE_URL.replace(/\/+$/, "");
  const params = new URLSearchParams({
    path: vfsPath,
    apiToken: env.DRAKKAR_API_TOKEN
  });
  return `${base}/api/vfs/stream?${params.toString()}\n`;
}

function sourcePathForImport(item: ImportItem) {
  if (!item.completedPath.startsWith("/mounted/")) return item.completedPath;
  const mountedPath = item.completedPath.replace(/\/archive\//, "/");
  return `${env.FUSE_MOUNT_PATH}${mountedPath}`;
}

async function ensureMountedContentPath(
  item: ImportItem,
  media: Awaited<ReturnType<typeof resolveImportMedia>>,
  naming: Awaited<ReturnType<typeof getNamingSettings>>
) {
  const contentPath = completedPathFor({
    media,
    sourcePath: item.completedPath,
    naming
  });
  await mkdir(dirname(contentPath), { recursive: true });
  await ensureSymlinkTarget(contentPath, relative(dirname(contentPath), sourcePathForImport(item)));
  return contentPath;
}

async function stagedSourcePathForImport(item: ImportItem) {
  const sourcePath = sourcePathForImport(item);
  const ext = extname(item.completedPath) || ".mkv";
  const stagedPath = join(env.VFS_COMPLETED_SYMLINKS_DIR, `${item.id}${ext}`);
  await mkdir(dirname(stagedPath), { recursive: true });
  await ensureSymlinkTarget(stagedPath, relative(dirname(stagedPath), sourcePath));
  return stagedPath;
}

async function ensureSymlinkTarget(linkPath: string, target: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await currentSymlinkTarget(linkPath);
    if (existing === target) return;
    if (existing !== null) await removeExisting(linkPath);
    try {
      await symlink(target, linkPath);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/EEXIST/i.test(error.message)) throw error;
    }
  }
  const existing = await currentSymlinkTarget(linkPath);
  if (existing === target) return;
  throw new Error(`could not converge symlink target for ${linkPath}`);
}

async function currentSymlinkTarget(path: string) {
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink()) return "__non_symlink__";
    return await readlink(path);
  } catch {
    return null;
  }
}

function plexLog(level: "info" | "warn", message: string, fields: Record<string, unknown>) {
  const color = level === "warn" ? "\x1b[33m" : "\x1b[32m";
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}="${String(value).replace(/\s+/g, " ").trim()}"`)
    .join(" ");
  console[level](`\x1b[2m${new Date().toISOString()}\x1b[0m ${color}${level.toUpperCase().padEnd(5)}\x1b[0m ${message}${suffix ? ` \x1b[2m${suffix}\x1b[0m` : ""}`);
}

function inferTvEpisodeTargets(item: ImportItem, media: Awaited<ReturnType<typeof resolveImportMedia>>) {
  if (media.mediaType !== "tv") return [media];
  const searchSpace = [item.sourcePath, item.completedPath, item.title].filter(Boolean).join(" ");
  const multiEpisode = searchSpace.match(/\bS(?<season>\d{1,2})E(?<episode1>\d{1,4})(?:E(?<episode2a>\d{1,4})|[- .]E?(?<episode2b>\d{1,4}))\b/i);
  if (multiEpisode?.groups) {
    const season = media.season ?? Number(multiEpisode.groups.season);
    const firstEpisode = Number(multiEpisode.groups.episode1);
    const lastEpisode = Number(multiEpisode.groups.episode2a ?? multiEpisode.groups.episode2b);
    if (Number.isInteger(season) && Number.isInteger(firstEpisode) && Number.isInteger(lastEpisode) && firstEpisode > 0 && lastEpisode >= firstEpisode && lastEpisode - firstEpisode <= 20) {
      return Array.from({ length: lastEpisode - firstEpisode + 1 }, (_unused, index) => ({
        ...media,
        season,
        episode: firstEpisode + index
      }));
    }
  }
  return [media];
}

function validateMediaForLibraryPath(item: ImportItem, targets: Array<Awaited<ReturnType<typeof resolveImportMedia>>>) {
  for (const media of targets) {
    if (media.mediaType !== "tv") continue;
    if (
      !Number.isInteger(media.season) ||
      !Number.isInteger(media.episode) ||
      media.season === undefined ||
      media.episode === undefined ||
      media.season < 0 ||
      media.episode <= 0
    ) {
      throw new Error(`TV import ${item.id} cannot be symlinked without a valid season and episode`);
    }
  }
}

async function validateTvTargetsAgainstSeriesStructure(targets: Array<Awaited<ReturnType<typeof resolveImportMedia>>>) {
  const tvTargets = targets.filter((target) => target.mediaType === "tv");
  if (tvTargets.length === 0) return;
  const settings = await getSettings();
  const first = tvTargets[0]!;
  const structure = await fetchSeriesStructure(settings, {
    mediaType: "tv",
    title: first.title,
    year: first.year,
    tmdbId: first.tmdbId,
    tvdbId: first.tvdbId
  }).catch(() => undefined);
  if (!structure || structure.seasons.length === 0) return;
  for (const target of tvTargets) {
    if (!seriesStructureAllowsEpisode(target.season, target.episode, structure)) {
      throw new Error(
        `TV import for ${target.title} rejected because season/episode is outside known series structure (season=${target.season ?? "?"} episode=${target.episode ?? "?"})`
      );
    }
  }
}

async function validateImportPlayable(item: ImportItem) {
  if (item.completedPath.startsWith("/mounted/")) {
    return;
  }
  const sourcePath = sourcePathForImport(item);
  const probe = await probeMediaFile(sourcePath);
  if (probe.ok && probe.hasVideo) return;
  await prisma.importItem.update({
    where: { id: item.id },
    data: { status: "import_failed" }
  }).catch(() => undefined);
  throw new Error(`media probe failed before symlink: ${probe.reason ?? "unknown ffprobe failure"}`);
}

export async function createLibraryEntryForImport(
  item: ImportItem,
  options?: { refreshPlex?: boolean; changedPaths?: Set<string> }
) {
  const policies = await getPolicySettings();
  const naming = await getNamingSettings();
  const strategy = policies.importStrategy;
  const media = await resolveImportMedia(item);
  const targets = inferTvEpisodeTargets(item, media);
  validateMediaForLibraryPath(item, targets);
  await validateTvTargetsAgainstSeriesStructure(targets);
  await validateImportPlayable(item);
  const mountedContentPath = item.completedPath.startsWith("/mounted/")
    ? await ensureMountedContentPath(item, targets[0]!, naming)
    : null;
  const mountedContentLinkPath = mountedContentPath
    ? join(env.FUSE_MOUNT_PATH, "content", relative(env.VFS_COMPLETED_DIR, mountedContentPath))
    : null;
  if (item.completedPath.startsWith("/mounted/")) {
    await stagedSourcePathForImport(item).catch(() => undefined);
  }
  const desiredLinkPaths = targets.map((target) => libraryPathFor({ media: target, completedPath: item.completedPath, naming, strategy }));

  const staleLinks = await prisma.symlink.findMany({
    where: {
      importId: item.id,
      NOT: { linkPath: { in: desiredLinkPaths } }
    }
  });
  let refreshRequired = staleLinks.length > 0;
  for (const stale of staleLinks) {
    await unlink(stale.linkPath).catch(() => undefined);
    await pruneEmptyParents(stale.linkPath, item.mediaType === "tv" ? env.MEDIA_TV_DIR : env.MEDIA_MOVIES_DIR);
    await prisma.symlink.delete({ where: { id: stale.id } }).catch(() => undefined);
    void forgetRcloneVfsPaths(libraryForgetPaths(stale.linkPath, stale.sourcePath))
      .catch(() => undefined);
  }

  const links = [];
  for (let index = 0; index < desiredLinkPaths.length; index += 1) {
    const linkPath = desiredLinkPaths[index]!;
    const targetMedia = targets[index]!;
    await mkdir(dirname(linkPath), { recursive: true });
    const existingLink = await prisma.symlink.findUnique({ where: { linkPath } }).catch(() => null);
    let persistedSourcePath = mountedContentLinkPath ?? sourcePathForImport(item);
    let linkRefreshRequired = false;

    if (strategy === "copy") {
      if (item.completedPath.startsWith("/mounted/")) throw new Error("mounted streaming imports cannot use copy strategy");
      const existed = await lstat(linkPath).then((stats) => stats.isFile()).catch(() => false);
      linkRefreshRequired = !existed
        || existingLink?.sourcePath !== persistedSourcePath
        || existingLink?.importId !== item.id
        || existingLink?.status !== strategy;
      await removeExisting(linkPath);
      await copyFile(item.completedPath, linkPath);
    } else if (strategy === "strm") {
      const nextContents = strmContents({
        ...item,
        episode: targetMedia.episode ?? item.episode,
        season: targetMedia.season ?? item.season
      });
      const contents = await readFile(linkPath, "utf8").catch(() => null as string | null);
      linkRefreshRequired = contents !== nextContents
        || existingLink?.sourcePath !== persistedSourcePath
        || existingLink?.importId !== item.id
        || existingLink?.status !== strategy;
      await removeExisting(linkPath);
      await writeFile(linkPath, nextContents);
    } else {
      const target = relative(dirname(linkPath), persistedSourcePath);
      const existingTarget = await currentSymlinkTarget(linkPath);
      linkRefreshRequired = existingTarget !== target
        || existingLink?.sourcePath !== persistedSourcePath
        || existingLink?.importId !== item.id
        || existingLink?.status !== strategy;
      await ensureSymlinkTarget(linkPath, target);
    }

    const link = await prisma.symlink.upsert({
      where: { linkPath },
      update: { sourcePath: persistedSourcePath, importId: item.id, status: strategy },
      create: { sourcePath: persistedSourcePath, linkPath, importId: item.id, status: strategy }
    });
    links.push(link);
    refreshRequired = refreshRequired || linkRefreshRequired;
    if (linkRefreshRequired) options?.changedPaths?.add(link.linkPath);
    if ((options?.refreshPlex ?? true) && linkRefreshRequired) {
      void refreshPlexPath(link.linkPath)
        .then((result) => {
          if (!result.skipped) plexLog("info", "plex targeted refresh triggered", { path: basename(link.linkPath), ok: true });
          else if (!["not_configured", "deduped", "section_refreshing"].includes(String(result.reason))) plexLog("warn", "plex targeted refresh skipped", result);
        })
        .catch((error) => plexLog("warn", "plex targeted refresh failed", { error: error instanceof Error ? error.message : error }));
    }
    if (linkRefreshRequired) {
      void forgetRcloneVfsPaths(libraryForgetPaths(link.linkPath, persistedSourcePath))
        .catch(() => undefined);
    }
    void scheduleSubtitleSyncForLibraryPath(link.linkPath, {
      mediaType: targetMedia.mediaType === "tv" ? "tv" : "movie",
      title: targetMedia.title,
      year: targetMedia.year,
      tmdbId: targetMedia.tmdbId,
      tvdbId: targetMedia.tvdbId,
      season: targetMedia.season,
      episode: targetMedia.episode
    });
  }
  return links[0]!;
}

export const createSymlinkForImport = createLibraryEntryForImport;

export async function listSymlinks() {
  const links = await prisma.symlink.findMany({ orderBy: { createdAt: "desc" }, include: { importItem: true } });
  return Promise.all(
    links.map(async (link) => {
      try {
        const stats = await lstat(link.linkPath);
        if (link.status === "strm") {
          const contents = await readFile(link.linkPath, "utf8").catch(() => "");
          return { ...link, exists: stats.isFile() && contents.length > 0 };
        }
        return { ...link, exists: link.status === "copy" ? stats.isFile() : stats.isSymbolicLink() };
      } catch {
        return { ...link, exists: false, status: "broken" };
      }
    })
  );
}

export async function repairSymlinks() {
  const imports = await prisma.importItem.findMany();
  const repaired = [];
  const skipped: Array<{ importId: string; reason: string }> = [];
  for (const item of imports) {
    try {
      repaired.push(await createLibraryEntryForImport(item, { refreshPlex: false }));
    } catch (error) {
      skipped.push({
        importId: item.id,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { repaired: repaired.length, skipped: skipped.length, failures: skipped.slice(0, 50) };
}

export async function cleanupSymlinks() {
  const links = await prisma.symlink.findMany();
  let removed = 0;
  for (const link of links) {
    try {
      await lstat(link.sourcePath);
    } catch {
      await prisma.symlink.update({ where: { id: link.id }, data: { status: "orphaned" } });
      removed += 1;
    }
  }
  return { orphaned: removed };
}

async function pruneEmptyTree(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await pruneEmptyTree(`${root}/${entry.name}`);
  }
  const remaining = await readdir(root).catch(() => null);
  if (!remaining || remaining.length > 0) return;
  await rmdir(root).catch(() => undefined);
}

async function removeUntrackedLibraryEntries(root: string, trackedPaths: Set<string>) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      removed += await removeUntrackedLibraryEntries(path, trackedPaths);
      const remaining = await readdir(path).catch(() => null);
      if (remaining && remaining.length === 0) {
        await rmdir(path).catch(() => undefined);
      }
      continue;
    }
    if (trackedPaths.has(path)) continue;
    await rm(path, { force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

export async function pruneLibraryDirectories() {
  await pruneEmptyTree(env.MEDIA_MOVIES_DIR);
  await pruneEmptyTree(env.MEDIA_TV_DIR);
  return { ok: true };
}

export async function removeStaleLibraryFilesystemEntries() {
  const links = await prisma.symlink.findMany({ select: { linkPath: true } });
  const trackedPaths = new Set(links.map((link) => link.linkPath));
  const removedMovies = await removeUntrackedLibraryEntries(env.MEDIA_MOVIES_DIR, trackedPaths);
  const removedTv = await removeUntrackedLibraryEntries(env.MEDIA_TV_DIR, trackedPaths);
  await pruneEmptyTree(env.MEDIA_MOVIES_DIR);
  await pruneEmptyTree(env.MEDIA_TV_DIR);
  return { removed: removedMovies + removedTv, removedMovies, removedTv };
}

export async function revalidateLibrarySymlinks(options: { limit?: number; offset?: number } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  const offset = Math.max(0, options.offset ?? 0);
  const imports = await prisma.importItem.findMany({
    where: {
      symlinks: { some: {} },
      status: { in: ["imported", "streaming_import"] }
    },
    include: { symlinks: true },
    orderBy: { updatedAt: "asc" },
    skip: offset,
    take: limit
  });

  let validated = 0;
  let removed = 0;
  const failures: Array<{ importId: string; reason: string }> = [];
  const affectedRequestIds = new Set<string>();

  for (const item of imports) {
    const sourcePath = sourcePathForImport(item);
    const probe = await probeMediaFile(sourcePath).catch((error) => ({
      ok: false,
      hasVideo: false,
      reason: error instanceof Error ? error.message : String(error)
    }));
    if (probe.ok && probe.hasVideo) {
      validated += 1;
      continue;
    }

    for (const link of item.symlinks) {
      await rm(link.linkPath, { force: true }).catch(() => undefined);
      void forgetRcloneVfsPaths(libraryForgetPaths(link.linkPath, link.sourcePath)).catch(() => undefined);
      await prisma.symlink.update({
        where: { id: link.id },
        data: { status: "broken" }
      }).catch(() => undefined);
      removed += 1;
    }

    if (item.completedPath.startsWith("/mounted/")) {
      const stagedPath = join(env.VFS_COMPLETED_SYMLINKS_DIR, `${item.id}${extname(item.completedPath) || ".mkv"}`);
      const sourceReferencedElsewhere = await prisma.symlink.count({
        where: {
          sourcePath: stagedPath,
          importId: { not: item.id }
        }
      }).catch(() => 0);
      if (sourceReferencedElsewhere === 0) {
      await rm(stagedPath, { force: true }).catch(() => undefined);
      void forgetRcloneVfsPaths(libraryForgetPaths(stagedPath, sourcePath)).catch(() => undefined);
      }
    }

    await prisma.importItem.update({
      where: { id: item.id },
      data: { status: "import_failed" }
    }).catch(() => undefined);

    if (item.requestId) {
      const linkedRequest = await prisma.mediaRequest.findUnique({ where: { id: item.requestId } }).catch(() => null);
      if (linkedRequest) {
        await blocklistSelectedRelease(linkedRequest, probe.reason ?? "import validation failed", "import-revalidate").catch(() => undefined);
        await prisma.mediaRequest.update({
          where: { id: linkedRequest.id },
          data: {
            status: "approved",
            downloadId: null,
            selectedRelease: Prisma.JsonNull
          }
        }).catch(() => undefined);
        affectedRequestIds.add(linkedRequest.id);
        if (item.mediaType === "tv" && item.season !== null && item.episode !== null) {
          await grabTvEpisodeForRequest(linkedRequest.id, item.season, item.episode).catch(() => undefined);
        } else if (item.mediaType === "tv") {
          await grabMissingTvForRequest(linkedRequest.id, { skipFallback: true }).catch(() => undefined);
        } else {
          await grabBestForRequest(linkedRequest.id, { skipFallback: true }).catch(() => undefined);
        }
      }
    }

    failures.push({
      importId: item.id,
      reason: probe.reason ?? "ffprobe failed"
    });
  }

  await pruneLibraryDirectories();
  if (affectedRequestIds.size > 0) {
    const requestIds = [...affectedRequestIds];
    await prisma.mediaLibraryItem.updateMany({
      where: { requestId: { in: requestIds } },
      data: {
        libraryStatus: "requested",
        streamStatus: "unknown",
        healthStatus: "unknown"
      }
    }).catch(() => undefined);
  }
  return {
    offset,
    scanned: imports.length,
    validated,
    removed,
    failed: failures.length,
    nextOffset: offset + imports.length,
    failures: failures.slice(0, 100)
  };
}
