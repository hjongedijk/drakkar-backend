import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { prisma } from "../db/prisma.js";
import { isJunkFile, isMediaFile } from "../extract/detect.js";
import { extractArchivesInPath } from "../extract/extractService.js";
import { writeImportMetadata } from "../metadata/metadataService.js";
import { mediaIdentityKey } from "../media-library/identity.js";
import { refreshMediaLibrary } from "../media-library/libraryService.js";
import { completedPathFor, getNamingSettings } from "../naming/namingService.js";
import { getIgnoredPatterns, matchesIgnoredPattern } from "../policies/policyService.js";
import { createLibraryEntryForImport } from "../symlinks/symlinkService.js";
import { filenameFromSubject } from "../usenet/filename.js";
import { listMountedFiles } from "../vfs/mountedNzbService.js";
import { getSettings } from "../settings/settingsStore.js";
import { fetchMediaMetadata } from "../metadata/metadataService.js";

async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) return walk(fullPath);
      return [fullPath];
    })
  );
  return files.flat();
}

function cleanTitle(value: string) {
  return value
    .replace(/&quot;/gi, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/^\s*\[\s*\d+\s*(?:\/|\s)\s*\d+\s*\]\s*-?\s*/i, "")
    .replace(/^\s*\d+\]\s*-?\s*/i, "")
    .replace(/^"+|"+$/g, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodePathBasename(path: string) {
  const file = basename(path);
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
}

function normalizeMountedFilename(value: string) {
  return value
    .replace(/^[a-z0-9]{10,}-/i, "")
    .replace(/^\s*\[\s*\d+\s*(?:\/|\s)\s*\d+\s*\]\s*-?\s*/i, "")
    .replace(/^\s*\d+\]\s*-?\s*/i, "")
    .replace(/^"+|"+$/g, "")
    .trim();
}

function suspiciousImportTitle(value: string) {
  return /&quot;|^\s*\d+\]\s*|^[a-z0-9]{20,}$/i.test(value);
}

function inferMedia(path: string) {
  const name = basename(path, extname(path));
  const seasonEpisode = name.match(/\bS(?<season>\d{1,2})E(?<episode>\d{1,3})\b/i);
  const seasonOnly = name.match(/\bS(?<season>\d{1,2})\b/i);
  const year = name.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  const titleBase = name.split(/\b(19\d{2}|20\d{2}|S\d{1,2}(?:E\d{1,3})?)\b/i)[0] ?? name;
  return {
    mediaType: seasonEpisode || seasonOnly ? "tv" : "movie",
    title: cleanTitle(titleBase),
    year: year ? Number(year) : undefined,
    season: seasonEpisode?.groups?.season ? Number(seasonEpisode.groups.season) : seasonOnly?.groups?.season ? Number(seasonOnly.groups.season) : undefined,
    episode: seasonEpisode?.groups?.episode ? Number(seasonEpisode.groups.episode) : undefined,
    tmdbId: undefined as string | undefined,
    tvdbId: undefined as string | undefined
  };
}

type ImportMedia = ReturnType<typeof inferMedia>;

async function requestMetadata(requestId?: string): Promise<Partial<ImportMedia>> {
  if (!requestId) return {};
  const request = await prisma.mediaRequest.findUnique({ where: { id: requestId } });
  if (!request) return {};
  return {
    mediaType: request.mediaType,
    title: request.title,
    year: request.year ?? undefined,
    tmdbId: request.tmdbId ?? undefined,
    tvdbId: request.tvdbId ?? undefined
  };
}

export async function importCompletedPath(input: { sourcePath: string; downloadId?: string; requestId?: string }) {
  const stats = await stat(input.sourcePath);
  const extracted = await extractArchivesInPath(input.sourcePath);
  const candidateRoots = stats.isDirectory() ? [input.sourcePath, ...extracted.map((result) => result.outputDir)] : extracted.length > 0 ? extracted.map((result) => result.outputDir) : [input.sourcePath];
  const candidates = (await Promise.all(candidateRoots.map((path) => walk(path)))).flat();
  const ignoredPatterns = await getIgnoredPatterns();
  const mediaFiles = candidates.filter((path) => isMediaFile(path) && !isJunkFile(path) && !matchesIgnoredPattern(path, ignoredPatterns));
  const imported = [];
  const requestInfo = await requestMetadata(input.requestId);
  const naming = await getNamingSettings();

  for (const sourcePath of mediaFiles) {
    const inferred = { ...inferMedia(sourcePath), ...requestInfo };
    const completedPath = completedPathFor({ media: inferred, sourcePath, naming });
    await mkdir(dirname(completedPath), { recursive: true });
    await rename(sourcePath, completedPath);

    const item = await prisma.importItem.create({
      data: {
        downloadId: input.downloadId,
        requestId: input.requestId,
        mediaType: inferred.mediaType,
        title: inferred.title,
        year: inferred.year,
        season: inferred.season,
        episode: inferred.episode,
        sourcePath,
        completedPath,
        status: "imported"
      }
    });
    const metadata = await writeImportMetadata({
      importId: item.id,
      title: item.title,
      completedPath: item.completedPath,
      mediaType: item.mediaType,
      year: item.year,
      season: item.season,
      episode: item.episode
    });
    const updated = await prisma.importItem.update({ where: { id: item.id }, data: metadata });
    await createLibraryEntryForImport(updated);
    imported.push(updated);
  }

  return imported;
}

function mainVideoFile(files: Awaited<ReturnType<typeof listMountedFiles>>, ignoredPatterns: string[]) {
  return files
    .filter((file) => /\.(mkv|mp4|avi|mov|m4v|ts)(?:[_\s)]|$)/i.test(file.name))
    .filter((file) => !isJunkFile(file.name) && !matchesIgnoredPattern(file.path, ignoredPatterns))
    .sort((a, b) => b.size - a.size)[0];
}

function mediaVideoFiles(files: Awaited<ReturnType<typeof listMountedFiles>>, ignoredPatterns: string[]) {
  return files
    .filter((file) => /\.(mkv|mp4|avi|mov|m4v|ts)(?:[_\s)]|$)/i.test(file.name))
    .filter((file) => !isJunkFile(file.name) && !matchesIgnoredPattern(file.path, ignoredPatterns))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function makeMountedDownloadAvailable(input: { downloadId: string; requestId?: string }) {
  const download = await prisma.download.findUniqueOrThrow({
    where: { id: input.downloadId },
    include: {
      nzbDocument: { include: { files: true, mounts: true } }
    }
  });
  if (!download.nzbDocumentId || !download.nzbDocument) throw new Error("download has no mounted NZB document");

  const mountedFiles = await listMountedFiles(`/mounted/releases/${download.nzbDocumentId}`);
  const ignoredPatterns = await getIgnoredPatterns();
  const requestInfo = await requestMetadata(input.requestId);
  const selectedFiles = requestInfo.mediaType === "tv"
    ? mediaVideoFiles(mountedFiles, ignoredPatterns)
    : [mainVideoFile(mountedFiles, ignoredPatterns)].filter((file): file is NonNullable<typeof file> => Boolean(file));
  if (selectedFiles.length === 0) throw new Error("mounted NZB contains no streamable video file after ignored/sample filtering");

  const imported = [];
  for (const selected of selectedFiles) {
    const nzbFile = download.nzbDocument.files.find((file) => selected.path.includes(file.id));
    const filename = nzbFile
      ? filenameFromSubject(nzbFile.subject, 0)
      : normalizeMountedFilename(selected.name.replace(/^[-_\s]+|[_\s]+$/g, ""));
    const inferred = { ...inferMedia(filename), ...requestInfo };
    const matchingImport = await findWorkingImportByIdentity(inferred);

    const existing = await prisma.importItem.findFirst({
      where: { downloadId: download.id, completedPath: selected.path },
      include: { symlinks: true }
    });
    if (!existing && matchingImport) {
      imported.push({ item: matchingImport, link: matchingImport.symlinks[0], streamPath: matchingImport.completedPath });
      continue;
    }
    const item = existing ?? await prisma.importItem.create({
      data: {
        downloadId: download.id,
        requestId: input.requestId,
        mediaType: inferred.mediaType,
        title: inferred.title || download.title,
        year: inferred.year,
        season: inferred.season,
        episode: inferred.episode,
        sourcePath: selected.path,
        completedPath: selected.path,
        status: "streaming_import"
      }
    });

    const link = await createLibraryEntryForImport(item);
    imported.push({ item, link, streamPath: selected.path });
  }
  await prisma.download.update({
    where: { id: download.id },
    data: { status: "available", progress: 100, downloaded: 0, speedBytesSec: 0, etaSeconds: 0, completedAt: new Date(), error: null }
  });
  if (input.requestId) await prisma.mediaRequest.update({ where: { id: input.requestId }, data: { status: "available", downloadId: download.id } });
  await refreshMediaLibrary();
  return { downloadId: download.id, import: imported[0]?.item, symlink: imported[0]?.link, imports: imported.map((item) => item.item), streamPath: imported[0]?.streamPath };
}

export async function repairSuspiciousImports() {
  const settings = await getSettings();
  const imports = await prisma.importItem.findMany({
    where: {
      OR: [
        { title: { contains: "&quot;" } },
        { title: { startsWith: "[" } },
        { title: { startsWith: "7]" } },
        { title: { startsWith: "8]" } },
        { title: { startsWith: "9]" } },
        { title: { startsWith: "10]" } }
      ]
    },
    include: { request: true, symlinks: true }
  });

  let repaired = 0;
  let hidden = 0;
  for (const item of imports) {
    const requestInfo = item.requestId ? await requestMetadata(item.requestId) : {};
    const filename = normalizeMountedFilename(decodePathBasename(item.completedPath));
    const inferred = { ...inferMedia(filename), ...requestInfo };
    const metadata = inferred.title ? await fetchMediaMetadata(settings, {
      mediaType: inferred.mediaType,
      title: inferred.title,
      year: inferred.year,
      season: inferred.season,
      episode: inferred.episode,
      tmdbId: item.request?.tmdbId ?? undefined,
      tvdbId: item.request?.tvdbId ?? undefined
    }).catch(() => undefined) : undefined;

    const nextTitle = metadata?.title ?? inferred.title ?? item.title;
    if (!nextTitle || suspiciousImportTitle(nextTitle)) {
      await prisma.mediaLibraryItem.deleteMany({ where: { sourceKey: `import:${item.id}` } }).catch(() => undefined);
      hidden += 1;
      continue;
    }

    const updated = await prisma.importItem.update({
      where: { id: item.id },
      data: {
        mediaType: inferred.mediaType,
        title: nextTitle,
        year: metadata?.year ?? inferred.year,
        season: inferred.season,
        episode: inferred.episode
      }
    });
    await writeImportMetadata({
      importId: updated.id,
      title: updated.title,
      completedPath: updated.completedPath,
      mediaType: updated.mediaType,
      year: updated.year,
      season: updated.season,
      episode: updated.episode
    }).catch(() => undefined);
    await createLibraryEntryForImport(updated).catch(() => undefined);
    repaired += 1;
  }

  await refreshMediaLibrary();
  return { repaired, hidden };
}

async function findWorkingImportByIdentity(media: Partial<ImportMedia>) {
  if (!media.mediaType || !media.title) return null;
  const candidates = await prisma.importItem.findMany({
    where: {
      mediaType: media.mediaType,
      year: media.year ?? undefined,
      season: media.season ?? null,
      episode: media.episode ?? null,
      symlinks: { some: { status: { not: "broken" } } }
    },
    include: { symlinks: { orderBy: { updatedAt: "desc" } } }
  });
  const key = mediaIdentityKey({
    mediaType: media.mediaType,
    title: media.title,
    year: media.year,
    season: media.season,
    episode: media.episode
  });
  return candidates.find((item) => mediaIdentityKey(item) === key) ?? null;
}

export function listImports() {
  return prisma.importItem.findMany({ orderBy: { createdAt: "desc" }, include: { symlinks: true } });
}

export function getImport(id: string) {
  return prisma.importItem.findUniqueOrThrow({ where: { id }, include: { symlinks: true } });
}

export async function reprocessImport(id: string) {
  const item = await getImport(id);
  await createLibraryEntryForImport(item);
  return getImport(id);
}

export async function migrateImportsToCurrentNaming() {
  const naming = await getNamingSettings();
  const imports = await prisma.importItem.findMany({
    include: { request: true, symlinks: true }
  });
  let moved = 0;
  let relinked = 0;

  for (const item of imports) {
    const media = {
      mediaType: item.mediaType,
      title: item.title,
      year: item.year,
      season: item.season,
      episode: item.episode,
      tmdbId: item.request?.tmdbId ?? undefined,
      tvdbId: item.request?.tvdbId ?? undefined
    };

    let current = item.completedPath;
    if (!item.completedPath.startsWith("/mounted/")) {
      const target = completedPathFor({
        media,
        sourcePath: item.sourcePath || item.completedPath,
        naming
      });
      if (target !== item.completedPath) {
        await mkdir(dirname(target), { recursive: true });
        await rename(item.completedPath, target).catch(() => undefined);
        current = target;
        moved += 1;
      }
    }

    const updated = current === item.completedPath
      ? item
      : await prisma.importItem.update({
          where: { id: item.id },
          data: { completedPath: current }
        });

    await createLibraryEntryForImport(updated);
    relinked += 1;
  }

  await refreshMediaLibrary();
  return { moved, relinked };
}
