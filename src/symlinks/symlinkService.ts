import { copyFile, lstat, mkdir, readFile, readdir, readlink, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ImportItem } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
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
  const suspiciousTitle = !item.title || /^[a-z0-9]+-[a-z0-9-]+$/i.test(item.title) || /\($/.test(item.title.trim());
  const titleFallback = suspiciousTitle ? fallbackMediaTitle(download?.title) ?? item.title : item.title;
  const media = {
    mediaType: item.mediaType,
    title: titleFallback,
    year: item.year,
    season: item.season,
    episode: item.episode,
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
    if (titleFallback && titleFallback !== item.title) {
      await prisma.importItem.update({
        where: { id: item.id },
        data: { title: titleFallback }
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
      title: nextMedia.title,
      year: nextMedia.year
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
  return `${base}/api/vfs/stream?path=${encodeURIComponent(vfsPath)}\n`;
}

function sourcePathForImport(item: ImportItem) {
  return item.completedPath.startsWith("/mounted/") ? `${env.FUSE_MOUNT_PATH}${item.completedPath}` : item.completedPath;
}

function effectiveImportStrategy(configuredStrategy: string, item: ImportItem) {
  if (item.completedPath.startsWith("/mounted/") && !env.FUSE_MOUNT_ENABLED) return "strm";
  return configuredStrategy;
}

export async function createLibraryEntryForImport(item: ImportItem) {
  const policies = await getPolicySettings();
  const naming = await getNamingSettings();
  const strategy = effectiveImportStrategy(policies.importStrategy, item);
  const media = await mediaFromImport(item);
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

  if (strategy === "copy") {
    if (item.completedPath.startsWith("/mounted/")) throw new Error("mounted streaming imports cannot use copy strategy");
    await removeExisting(linkPath);
    await copyFile(item.completedPath, linkPath);
  } else if (strategy === "strm") {
    await removeExisting(linkPath);
    await writeFile(linkPath, strmContents(item));
  } else {
    const sourcePath = sourcePathForImport(item);
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
    update: { sourcePath: sourcePathForImport(item), importId: item.id, status: strategy },
    create: { sourcePath: sourcePathForImport(item), linkPath, importId: item.id, status: strategy }
  });
  void refreshPlexPath(link.linkPath)
    .then((result) => {
      if (!result.skipped) console.info("[plex] targeted refresh triggered", result);
      else if (result.reason !== "not_configured" && result.reason !== "deduped") console.warn("[plex] targeted refresh skipped", result);
    })
    .catch((error) => console.warn("[plex] targeted refresh failed", error instanceof Error ? error.message : error));
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
