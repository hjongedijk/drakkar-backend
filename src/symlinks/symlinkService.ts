import { copyFile, lstat, mkdir, readFile, readdir, readlink, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { ImportItem } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { inferMediaIdentity } from "../media-library/identity.js";
import { fetchMediaMetadata } from "../metadata/metadataService.js";
import { completedPathToVfsPath, getNamingSettings, libraryPathFor } from "../naming/namingService.js";
import { getPolicySettings } from "../policies/policyService.js";
import { refreshPlexPath } from "../plex/plexService.js";
import { getSettings } from "../settings/settingsStore.js";

function fallbackMediaTitle(value?: string | null) {
  if (!value) return undefined;
  const prefix = value.split(/\bS\d{1,2}E\d{1,3}\b/i)[0] ?? value;
  const cleaned = prefix
    .replace(/[._]+/g, " ")
    .replace(/\s+-\s+[A-Za-z0-9]+$/, "")
    .trim();
  return cleaned || undefined;
}

function normalizeLookupTitle(value?: string | null) {
  if (!value) return undefined;
  return value
    .replace(/\(\d{4}\)\s*$/g, "")
    .replace(/\($/g, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || undefined;
}

async function mediaFromImport(item: ImportItem) {
  const request = item.requestId ? await prisma.mediaRequest.findUnique({ where: { id: item.requestId } }) : null;
  const download = item.downloadId ? await prisma.download.findUnique({ where: { id: item.downloadId } }) : null;
  const compactTitle = item.title.trim();
  const suspiciousTitle = !item.title
    || /^[a-z0-9]+-[a-z0-9-]+$/i.test(item.title)
    || (/^[a-z0-9]{8,19}$/i.test(compactTitle) && /[a-z]/.test(compactTitle) && /[A-Z]/.test(compactTitle) && /\d/.test(compactTitle))
    || (!request && /^[a-z]{10,19}$/i.test(compactTitle) && /[a-z]/.test(compactTitle) && /[A-Z]/.test(compactTitle))
    || /\($/.test(item.title.trim());
  const downloadIdentity = download?.title ? inferMediaIdentity(download.title) : null;
  const shouldTrustDownloadIdentity = suspiciousTitle
    || (item.mediaType === "movie" && (item.season !== null || item.episode !== null))
    || downloadIdentity?.mediaType === "tv";
  const inferredIdentity = item.mediaType === "tv" || shouldTrustDownloadIdentity || downloadIdentity?.mediaType === "tv"
    ? inferMediaIdentity(`${item.completedPath} ${download?.title ?? ""}`)
    : downloadIdentity;
  const titleFallback = suspiciousTitle
    ? downloadIdentity?.title ?? fallbackMediaTitle(download?.title) ?? item.title
    : item.title;
  const media = {
    mediaType: shouldTrustDownloadIdentity && downloadIdentity?.mediaType !== "unknown" ? downloadIdentity?.mediaType ?? item.mediaType : item.mediaType,
    title: titleFallback,
    year: item.year ?? (inferredIdentity?.mediaType === "movie" ? inferredIdentity.year : undefined),
    season: item.season ?? (inferredIdentity?.mediaType === "tv" ? inferredIdentity.season : undefined),
    episode: item.episode ?? (inferredIdentity?.mediaType === "tv" ? inferredIdentity.episode : undefined),
    tmdbId: request?.tmdbId,
    tvdbId: request?.tvdbId
  };

  const needsMetadata = !media.year || (media.mediaType === "movie" ? !media.tmdbId : !media.tvdbId);
  if (!needsMetadata) return media;
  const lookupTitle = normalizeLookupTitle(titleFallback) ?? normalizeLookupTitle(media.title) ?? media.title;
  const lookupYear = request?.year
    ?? (media.mediaType === "tv" && !media.tvdbId ? undefined : suspiciousTitle ? undefined : media.year);

  const settings = await getSettings();
  const metadata = await fetchMediaMetadata(settings, {
    mediaType: media.mediaType,
    title: lookupTitle,
    year: lookupYear,
    season: media.season,
    episode: media.episode,
    tmdbId: media.tmdbId,
    tvdbId: media.tvdbId,
    imdbId: request?.imdbId
  }).catch(() => undefined);

  if (!metadata) {
    if ((titleFallback && titleFallback !== item.title) || media.season !== item.season || media.episode !== item.episode) {
      await prisma.importItem.update({
        where: { id: item.id },
        data: {
          mediaType: media.mediaType,
          title: titleFallback,
          season: media.season,
          episode: media.episode
        }
      }).catch(() => undefined);
    }
    return media;
  }

  const nextMedia = {
    ...media,
    title: metadata.title ?? media.title,
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

async function removeExisting(path: string) {
  try {
    await unlink(path);
  } catch {
    // Missing paths are fine; mismatched existing files get replaced by the selected strategy.
  }
}

function strmContents(item: ImportItem) {
  const vfsPath = item.completedPath.startsWith("/mounted/") ? item.completedPath : completedPathToVfsPath(item.completedPath);
  if (!vfsPath) return item.completedPath;
  const base = env.APP_BASE_URL.replace(/\/+$/, "");
  const params = new URLSearchParams({
    path: vfsPath,
    apiToken: env.FRONTEND_API_TOKEN
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
  const stagedPath = join(env.VFS_COMPLETED_DIR, ".staging", "imports", `${item.id}${ext}`);
  await mkdir(dirname(stagedPath), { recursive: true });
  try {
    const existing = await readlink(stagedPath);
    if (existing === sourcePath) return stagedPath;
    await unlink(stagedPath);
  } catch {
    await removeExisting(stagedPath);
  }
  await symlink(sourcePath, stagedPath);
  return stagedPath;
}

function plexLog(level: "info" | "warn", message: string, fields: Record<string, unknown>) {
  const color = level === "warn" ? "\x1b[33m" : "\x1b[32m";
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}="${String(value).replace(/\s+/g, " ").trim()}"`)
    .join(" ");
  console[level](`\x1b[2m${new Date().toISOString()}\x1b[0m ${color}${level.toUpperCase().padEnd(5)}\x1b[0m ${message}${suffix ? ` \x1b[2m${suffix}\x1b[0m` : ""}`);
}

function validateMediaForLibraryPath(item: ImportItem, media: Awaited<ReturnType<typeof mediaFromImport>>) {
  if (media.mediaType !== "tv") return;
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

export async function createLibraryEntryForImport(item: ImportItem) {
  const policies = await getPolicySettings();
  const naming = await getNamingSettings();
  const strategy = policies.importStrategy;
  const media = await mediaFromImport(item);
  validateMediaForLibraryPath(item, media);
  const linkPath = libraryPathFor({ media, completedPath: item.completedPath, naming, strategy });
  await mkdir(dirname(linkPath), { recursive: true });

  const staleLinks = await prisma.symlink.findMany({
    where: {
      importId: item.id,
      NOT: { linkPath }
    }
  });
  for (const stale of staleLinks) {
    await unlink(stale.linkPath).catch(() => undefined);
    await prisma.symlink.delete({ where: { id: stale.id } }).catch(() => undefined);
  }

  let persistedSourcePath = sourcePathForImport(item);
  if (strategy === "copy") {
    if (item.completedPath.startsWith("/mounted/")) throw new Error("mounted streaming imports cannot use copy strategy");
    await removeExisting(linkPath);
    await copyFile(item.completedPath, linkPath);
  } else if (strategy === "strm") {
    await removeExisting(linkPath);
    await writeFile(linkPath, strmContents(item));
  } else {
    const sourcePath = await stagedSourcePathForImport(item);
    persistedSourcePath = sourcePath;
    try {
      const existing = await readlink(linkPath);
      if (existing !== sourcePath) {
        await unlink(linkPath);
        await symlink(sourcePath, linkPath);
      }
    } catch {
      await removeExisting(linkPath);
      await symlink(sourcePath, linkPath);
    }
  }

  const link = await prisma.symlink.upsert({
    where: { linkPath },
    update: { sourcePath: persistedSourcePath, importId: item.id, status: strategy },
    create: { sourcePath: persistedSourcePath, linkPath, importId: item.id, status: strategy }
  });
  void refreshPlexPath(link.linkPath)
    .then((result) => {
      if (!result.skipped) plexLog("info", "plex targeted refresh triggered", result);
      else if (result.reason !== "not_configured" && result.reason !== "deduped") plexLog("warn", "plex targeted refresh skipped", result);
    })
    .catch((error) => plexLog("warn", "plex targeted refresh failed", { error: error instanceof Error ? error.message : error }));
  return link;
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
  for (const item of imports) repaired.push(await createLibraryEntryForImport(item));
  return { repaired: repaired.length };
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

export async function pruneLibraryDirectories() {
  await pruneEmptyTree(env.MEDIA_MOVIES_DIR);
  await pruneEmptyTree(env.MEDIA_TV_DIR);
  return { ok: true };
}
