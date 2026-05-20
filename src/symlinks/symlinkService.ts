import { copyFile, lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ImportItem } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { fetchMediaMetadata } from "../metadata/metadataService.js";
import { completedPathToVfsPath, getNamingSettings, libraryPathFor } from "../naming/namingService.js";
import { getPolicySettings } from "../policies/policyService.js";
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

async function mediaFromImport(item: ImportItem) {
  const request = item.requestId ? await prisma.mediaRequest.findUnique({ where: { id: item.requestId } }) : null;
  const download = item.downloadId ? await prisma.download.findUnique({ where: { id: item.downloadId } }) : null;
  const suspiciousTitle = !item.title || /^[a-z0-9]+-[a-z0-9-]+$/i.test(item.title);
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

  if (media.year) return media;

  const settings = await getSettings();
  const metadata = await fetchMediaMetadata(settings, {
    mediaType: media.mediaType,
    title: media.title,
    year: media.year,
    season: media.season,
    episode: media.episode,
    tmdbId: media.tmdbId,
    tvdbId: media.tvdbId,
    imdbId: request?.imdbId
  }).catch(() => undefined);

  if (!metadata?.year) {
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
    year: metadata.year,
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

export async function createLibraryEntryForImport(item: ImportItem) {
  const policies = await getPolicySettings();
  const naming = await getNamingSettings();
  const strategy = policies.importStrategy;
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

  return prisma.symlink.upsert({
    where: { linkPath },
    update: { sourcePath: sourcePathForImport(item), importId: item.id, status: strategy },
    create: { sourcePath: sourcePathForImport(item), linkPath, importId: item.id, status: strategy }
  });
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
