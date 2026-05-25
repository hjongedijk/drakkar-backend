import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { Prisma, type ImportItem } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { canonicalizeDisplayTitle, inferMediaIdentity, normalizeTitleForIdentity, titlesLikelyMatch } from "../media-library/identity.js";
import { fetchMediaMetadata, fetchSeriesStructure } from "../metadata/metadataService.js";
import { completedPathToVfsPath, getNamingSettings, libraryPathFor } from "../naming/namingService.js";
import { getPolicySettings } from "../policies/policyService.js";
import { refreshPlexPath } from "../plex/plexService.js";
import { getSettings } from "../settings/settingsStore.js";
import { scheduleSubtitleSyncForLibraryPath } from "../subtitles/subtitleService.js";
import type { AppSettings } from "../settings/settingsStore.js";

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
  const request = item.requestId ? await prisma.mediaRequest.findUnique({ where: { id: item.requestId } }) : null;
  const download = item.downloadId ? await prisma.download.findUnique({ where: { id: item.downloadId } }) : null;
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
  const media = {
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
    await prisma.$transaction([
      prisma.importItem.update({ where: { id: item.id }, data: { requestId: null } }),
      prisma.mediaRequest.update({
        where: { id: request.id },
        data: { status: "approved", downloadId: null, selectedRelease: Prisma.JsonNull }
      })
    ]).catch(() => undefined);
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
  const [libraryCandidates, requestCandidates] = await Promise.all([
    prisma.mediaLibraryItem.findMany({
      where: {
        mediaType: media.mediaType,
        year: media.year ?? undefined,
        OR: [{ tmdbId: { not: null } }, { tvdbId: { not: null } }]
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
  for (const candidate of [...libraryCandidates, ...requestCandidates]) {
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
  if (!candidate.tmdbId && !candidate.tvdbId) return true;
  const structure = await fetchSeriesStructure(settings, {
    mediaType: "tv",
    title: candidate.title ?? media.title,
    year: candidate.year ?? media.year,
    tmdbId: candidate.tmdbId ?? undefined,
    tvdbId: candidate.tvdbId ?? undefined,
    season: media.season,
    episode: media.episode
  }).catch(() => undefined);
  return seriesStructureAllowsEpisode(media.season, media.episode, structure);
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

async function stagedSourcePathForImport(item: ImportItem) {
  const sourcePath = sourcePathForImport(item);
  const ext = extname(item.completedPath) || ".mkv";
  const stagedPath = join(dirname(env.MEDIA_SYMLINKS_DIR), "completed", ".staging", "imports", `${item.id}${ext}`);
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
  }

  let stagedSourcePath: string | null = null;
  const links = [];
  for (let index = 0; index < desiredLinkPaths.length; index += 1) {
    const linkPath = desiredLinkPaths[index]!;
    const targetMedia = targets[index]!;
    await mkdir(dirname(linkPath), { recursive: true });
    const existingLink = await prisma.symlink.findUnique({ where: { linkPath } }).catch(() => null);
    let persistedSourcePath = sourcePathForImport(item);
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
      stagedSourcePath ??= await stagedSourcePathForImport(item);
      persistedSourcePath = stagedSourcePath;
      const target = relative(dirname(linkPath), stagedSourcePath);
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
          if (!result.skipped) plexLog("info", "plex targeted refresh triggered", result);
          else if (result.reason !== "not_configured" && result.reason !== "deduped") plexLog("warn", "plex targeted refresh skipped", result);
        })
        .catch((error) => plexLog("warn", "plex targeted refresh failed", { error: error instanceof Error ? error.message : error }));
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
