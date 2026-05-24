import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { detectArchive, isJunkFile, isMediaFile } from "../extract/detect.js";
import { extractArchiveFiles, extractArchivesInPath } from "../extract/extractService.js";
import { writeImportMetadata } from "../metadata/metadataService.js";
import { inferMediaIdentity, mediaIdentityKey } from "../media-library/identity.js";
import { refreshMediaLibrary } from "../media-library/libraryService.js";
import { completedPathFor, getNamingSettings } from "../naming/namingService.js";
import { getIgnoredPatterns, matchesIgnoredPattern } from "../policies/policyService.js";
import { createLibraryEntryForImport, resolveImportMedia } from "../symlinks/symlinkService.js";
import { filenameFromSubject } from "../usenet/filename.js";
import { listMountedFiles } from "../vfs/mountedNzbService.js";
import { readMountedFileRange } from "../streaming/mountedStream.service.js";
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
    .replace(/\s*[\[(]\s*$/, "")
    .replace(/^\s*[\])]\s*/, "")
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

function decodeMountedName(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function bestMountedMediaFilename(input: { selectedName: string; subjectName: string; requestMediaType?: string }) {
  const selectedName = normalizeMountedFilename(decodeMountedName(input.selectedName).replace(/^[-_\s]+|[_\s]+$/g, ""));
  const selectedIdentity = inferMediaIdentity(selectedName);
  if (input.requestMediaType === "tv" || selectedIdentity.mediaType === "tv") {
    if (selectedIdentity.mediaType === "tv" && selectedIdentity.title && !suspiciousImportTitle(selectedIdentity.title)) return selectedName;
  }
  return input.subjectName;
}

function suspiciousImportTitle(value: string) {
  const compact = value.trim();
  return !value
    || value.includes("&quot;")
    || /^\s*\d+\]\s*/.test(value)
    || /^[a-z0-9]{20,}$/i.test(value)
    || (/^[a-z0-9]{8,19}$/i.test(compact) && /[a-z]/.test(compact) && /[A-Z]/.test(compact) && /\d/.test(compact))
    || (/\bS\d{1,2}E\d{1,4}(?:E\d{1,4}|[- .]E?\d{1,4})?\b/i.test(value) && /\b(2160p|1080p|720p|web-?dl|webrip|bluray|h\.?264|x264|x265|hevc|ddp|dts)\b/i.test(value))
    || (/\bS\d{1,2}\s*-\s*\d{1,2}\b/i.test(value) && /\b(2160p|1080p|720p|web-?dl|webrip|bluray|h\.?264|x264|x265|hevc)\b/i.test(value))
    || /^[a-z0-9]+-[a-z0-9-]+$/i.test(value);
}

function inferMedia(path: string) {
  const name = basename(path, extname(path));
  const multiEpisode = name.match(/\bS(?<season>\d{1,2})E(?<episode>\d{1,4})(?:E\d{1,4}|[- .]E?\d{1,4})\b/i);
  const seasonEpisode = name.match(/\bS(?<season>\d{1,2})E(?<episode>\d{1,4})\b/i);
  const seasonOnly = name.match(/\bS(?<season>\d{1,2})\b/i);
  const year = name.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  const titleBase = name.split(/\b(19\d{2}|20\d{2}|S\d{1,2}(?:E\d{1,4})?)\b/i)[0] ?? name;
  return {
    mediaType: multiEpisode || seasonEpisode || seasonOnly ? "tv" : "movie",
    title: cleanTitle(titleBase),
    year: year ? Number(year) : undefined,
    season: multiEpisode?.groups?.season
      ? Number(multiEpisode.groups.season)
      : seasonEpisode?.groups?.season
        ? Number(seasonEpisode.groups.season)
        : seasonOnly?.groups?.season
          ? Number(seasonOnly.groups.season)
          : undefined,
    episode: multiEpisode?.groups?.episode
      ? Number(multiEpisode.groups.episode)
      : seasonEpisode?.groups?.episode
        ? Number(seasonEpisode.groups.episode)
        : undefined,
    tmdbId: undefined as string | undefined,
    tvdbId: undefined as string | undefined
  };
}

type ImportMedia = ReturnType<typeof inferMedia>;

const TV_ACTIVE_DOWNLOAD_STATUSES = new Set(["queued", "fetching_nzb", "verifying", "prepared", "waiting_for_provider", "waiting_for_nzb", "downloading", "paused"]);

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

function enrichMountedTvMedia(media: ImportMedia, downloadTitle: string, requestInfo: Partial<ImportMedia>): ImportMedia {
  if (requestInfo.mediaType !== "tv" && media.mediaType !== "tv") return media;
  if (media.season && media.episode) return media;
  const fromDownload = inferMedia(downloadTitle);
  return {
    ...media,
    mediaType: "tv",
    title: requestInfo.title ?? media.title,
    year: requestInfo.year ?? media.year,
    season: media.season ?? fromDownload.season,
    episode: media.episode ?? fromDownload.episode
  };
}

export async function reconcileRequestStatusAfterImport(requestId?: string, downloadId?: string | null) {
  if (!requestId) return;
  const request = await prisma.mediaRequest.findUnique({ where: { id: requestId } });
  if (!request) return;
  if (request.mediaType !== "tv") {
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: { status: "available", downloadId: downloadId ?? request.downloadId }
    }).catch(() => undefined);
    return;
  }

  const [{ getRequestMonitor }, activeDownload] = await Promise.all([
    import("../requests/sync/service.js"),
    request.downloadId
      ? prisma.download.findUnique({
          where: { id: request.downloadId },
          select: { id: true, status: true }
        })
      : Promise.resolve(null)
  ]);
  const monitor = await getRequestMonitor(requestId).catch(() => null);
  const hasMissingEpisodes = monitor?.seasons.some((season) => season.missingCount > 0) ?? false;
  const hasAvailableEpisodes = monitor?.seasons.some((season) => season.availableCount > 0) ?? false;
  const nextStatus = hasMissingEpisodes
    ? hasAvailableEpisodes || (activeDownload ? TV_ACTIVE_DOWNLOAD_STATUSES.has(activeDownload.status) : false)
      ? "grabbed"
      : "approved"
    : hasAvailableEpisodes
      ? "available"
      : request.status;

  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status: nextStatus,
      downloadId: hasMissingEpisodes && (!activeDownload || !TV_ACTIVE_DOWNLOAD_STATUSES.has(activeDownload.status))
        ? null
        : downloadId ?? request.downloadId
    }
  }).catch(() => undefined);
}

function fallbackMediaTitle(value?: string | null) {
  if (!value) return undefined;
  const prefix = value.split(/\bS\d{1,2}E\d{1,4}\b/i)[0] ?? value;
  const cleaned = prefix
    .replace(/[._]+/g, " ")
    .replace(/\s+-\s+[A-Za-z0-9]+$/, "")
    .trim();
  return cleaned || undefined;
}

function mountedFileIdFromPath(path: string) {
  const match = path.match(/\/mounted\/releases\/[^/]+\/([^/-]+)-/);
  return match?.[1] ?? null;
}

async function materializeMountedArchive(input: { mountedPath: string; archiveName: string; outputDir: string; size: number }) {
  const outputPath = join(input.outputDir, input.archiveName);
  await mkdir(dirname(outputPath), { recursive: true });
  const handle = await open(outputPath, "w");
  const chunkSize = 4 * 1024 * 1024;
  try {
    let offset = 0;
    while (offset < input.size) {
      const length = Math.min(chunkSize, input.size - offset);
      const chunk = await readMountedFileRange({
        path: input.mountedPath,
        start: offset,
        length,
        source: "api"
      });
      if (chunk.length === 0) break;
      await handle.write(chunk, 0, chunk.length, offset);
      offset += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return outputPath;
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
    .filter((file) => file.type === "streamable-file")
    .filter((file) => /\.(mkv|mp4|avi|mov|m4v|ts)(?:[_\s)]|$)/i.test(file.name))
    .filter((file) => !isJunkFile(file.name) && !matchesIgnoredPattern(file.path, ignoredPatterns))
    .sort((a, b) => b.size - a.size)[0];
}

function mediaVideoFiles(files: Awaited<ReturnType<typeof listMountedFiles>>, ignoredPatterns: string[]) {
  return files
    .filter((file) => file.type === "streamable-file")
    .filter((file) => /\.(mkv|mp4|avi|mov|m4v|ts)(?:[_\s)]|$)/i.test(file.name))
    .filter((file) => !isJunkFile(file.name) && !matchesIgnoredPattern(file.path, ignoredPatterns))
    .filter((file) => file.size > 50 * 1024 * 1024)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function looksLikeMountedTvPack(downloadTitle: string, files: Awaited<ReturnType<typeof listMountedFiles>>) {
  if (/\bS\d{1,2}\s*-\s*\d{1,2}\b/i.test(downloadTitle)) return true;
  return files.some((file) => file.type === "streamable-file" && /\bS\d{1,2}E\d{1,3}\b/i.test(file.name));
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
  const selectedFiles = requestInfo.mediaType === "tv" || looksLikeMountedTvPack(download.title, mountedFiles)
    ? mediaVideoFiles(mountedFiles, ignoredPatterns)
    : [mainVideoFile(mountedFiles, ignoredPatterns)].filter((file): file is NonNullable<typeof file> => Boolean(file));
  if (selectedFiles.length === 0) throw new Error("mounted NZB contains no streamable video file after ignored/sample filtering");

  const imported = [];
  for (const selected of selectedFiles) {
    const nzbFile = download.nzbDocument.files.find((file) => selected.path.includes(file.id));
    const subjectName = nzbFile
      ? filenameFromSubject(nzbFile.subject, 0)
      : normalizeMountedFilename(selected.name.replace(/^[-_\s]+|[_\s]+$/g, ""));
    const filename = bestMountedMediaFilename({
      selectedName: selected.name,
      subjectName,
      requestMediaType: requestInfo.mediaType
    });
    const downloadFallback = !input.requestId && suspiciousImportTitle(inferMedia(filename).title)
      ? inferMedia(download.title)
      : {};
    const inferred = enrichMountedTvMedia({ ...inferMedia(filename), ...downloadFallback, ...requestInfo }, download.title, requestInfo);
    const matchingImport = await findWorkingImportByIdentity(inferred);

    const existing = await prisma.importItem.findFirst({
      where: { downloadId: download.id, completedPath: selected.path },
      include: { symlinks: true }
    });
    const repairable = existing ? null : await findRepairableMountedImport(download.id, input.requestId, inferred);
    if (!existing && matchingImport) {
      const attached = input.requestId && matchingImport.requestId !== input.requestId
        ? await prisma.importItem.update({
            where: { id: matchingImport.id },
            data: {
              requestId: input.requestId,
              title: inferred.title || matchingImport.title,
              year: inferred.year ?? matchingImport.year,
              season: inferred.season ?? matchingImport.season,
              episode: inferred.episode ?? matchingImport.episode
            },
            include: { symlinks: true }
          })
        : matchingImport;
      imported.push({ item: attached, link: attached.symlinks[0], streamPath: attached.completedPath });
      continue;
    }
    const item = existing
      ?? repairable
      ?? await prisma.importItem.create({
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
    const shouldUpdateExisting = existing && (
      existing.requestId !== input.requestId
      || existing.mediaType !== inferred.mediaType
      || existing.title !== (inferred.title || download.title)
      || existing.year !== (inferred.year ?? null)
      || existing.season !== (inferred.season ?? null)
      || existing.episode !== (inferred.episode ?? null)
    );
    const ensured = shouldUpdateExisting || repairable
      ? await prisma.importItem.update({
          where: { id: item.id },
          data: {
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
        })
      : item;

    const link = await createLibraryEntryForImport(ensured);
    imported.push({ item: ensured, link, streamPath: selected.path });
  }
  await prisma.download.update({
    where: { id: download.id },
    data: { status: "available", progress: 100, downloaded: 0, speedBytesSec: 0, etaSeconds: 0, completedAt: new Date(), error: null }
  });
  await reconcileRequestStatusAfterImport(input.requestId, download.id);
  await refreshMediaLibrary();
  return { downloadId: download.id, import: imported[0]?.item, symlink: imported[0]?.link, imports: imported.map((item) => item.item), streamPath: imported[0]?.streamPath };
}

export async function importMountedDownloadByExtraction(input: { downloadId: string; requestId?: string }) {
  const download = await prisma.download.findUniqueOrThrow({
    where: { id: input.downloadId },
    include: { nzbDocument: true }
  });
  if (!download.nzbDocumentId || !download.nzbDocument) throw new Error("download has no mounted NZB document");

  const mountedFiles = await listMountedFiles(`/mounted/releases/${download.nzbDocumentId}`);
  const materializeFiles = mountedFiles
    .filter((file) => file.type === "archive-file")
    .map((file) => ({ file, kind: detectArchive(file.name) }))
    .filter((entry): entry is { file: typeof mountedFiles[number]; kind: "rar" | "rar-part" | "zip" | "7z" } => entry.kind !== "none")
    .sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: "base" }));
  const tempExtractPath = join(env.VFS_TMP_DIR, "mounted-extract", download.id);
  const tempArchivePath = join(tempExtractPath, ".archives");
  await rm(tempExtractPath, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(tempExtractPath, { recursive: true });
  await mkdir(tempArchivePath, { recursive: true });

  try {
    const materializedArchives = await Promise.all(
      materializeFiles.map(async (entry) => ({
        archivePath: await materializeMountedArchive({
          mountedPath: entry.file.path,
          archiveName: entry.file.name,
          outputDir: tempArchivePath,
          size: entry.file.size
        }),
        kind: entry.kind
      }))
    );
    const extracted = await extractArchiveFiles(
      materializedArchives.filter((entry) =>
        entry.kind === "zip"
        || entry.kind === "7z"
        || entry.kind === "rar-part"
        || (entry.kind === "rar" && !/\.part\d+\.rar$/i.test(entry.archivePath))
      ),
      { outputRootDir: tempExtractPath }
    );
    if (extracted.length === 0) throw new Error("mounted NZB contains no extractable archive files");

    const imported = await importCompletedPath({
      sourcePath: tempExtractPath,
      downloadId: download.id,
      requestId: input.requestId
    });
    if (imported.length === 0) throw new Error("mounted archive extraction produced no importable media files");

    await prisma.download.update({
      where: { id: download.id },
      data: { status: "available", progress: 100, speedBytesSec: 0, etaSeconds: 0, completedAt: new Date(), error: null }
    });
    if (input.requestId) {
      await reconcileRequestStatusAfterImport(input.requestId, download.id);
    } else {
      await prisma.mediaRequest.updateMany({ where: { downloadId: download.id }, data: { status: "available" } });
    }
    await refreshMediaLibrary();
    return { downloadId: download.id, imports: imported };
  } finally {
    await rm(tempExtractPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function repairSuspiciousImports(options: { limit?: number } = {}) {
  const settings = await getSettings();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const imports = (await prisma.importItem.findMany({
    include: { request: true, download: true, symlinks: true },
    orderBy: { updatedAt: "asc" },
    take: limit * 4
  })).filter((item) => suspiciousImportTitle(item.title));

  let repaired = 0;
  let hidden = 0;
  for (const item of imports.slice(0, limit)) {
    const requestInfo = item.requestId ? await requestMetadata(item.requestId) : {};
    const filename = normalizeMountedFilename(decodePathBasename(item.completedPath));
    const downloadFallback = !item.requestId && suspiciousImportTitle(inferMedia(filename).title)
      ? inferMedia(item.download?.title ?? fallbackMediaTitle(item.download?.title) ?? item.title)
      : {};
    const inferred = { ...inferMedia(filename), ...downloadFallback, ...requestInfo };
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
  return { scanned: Math.min(imports.length, limit), remainingEstimate: Math.max(0, imports.length - limit), repaired, hidden };
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
  for (const item of candidates) {
    if (mediaIdentityKey(item) !== key) continue;
    if (!item.completedPath.startsWith("/mounted/")) return item;
    const fileId = mountedFileIdFromPath(item.completedPath);
    if (!fileId) continue;
    const nzbFile = await prisma.nzbFile.findUnique({ where: { id: fileId }, select: { subject: true } });
    if (!nzbFile?.subject || /\.par2\b/i.test(nzbFile.subject)) continue;
    return item;
  }
  return null;
}

async function isPar2MountedImportPath(path: string) {
  if (!path.startsWith("/mounted/")) return false;
  const fileId = mountedFileIdFromPath(path);
  if (!fileId) return false;
  const nzbFile = await prisma.nzbFile.findUnique({ where: { id: fileId }, select: { subject: true } });
  return Boolean(nzbFile?.subject && /\.par2\b/i.test(nzbFile.subject));
}

async function findRepairableMountedImport(downloadId: string, requestId: string | undefined, media: Partial<ImportMedia>) {
  const items = await prisma.importItem.findMany({
    where: { downloadId, completedPath: { startsWith: "/mounted/" } },
    include: { symlinks: true },
    orderBy: { createdAt: "asc" }
  });
  const expectedKey = media.mediaType && media.title
    ? mediaIdentityKey({
        mediaType: media.mediaType,
        title: media.title,
        year: media.year,
        season: media.season,
        episode: media.episode
      })
    : null;
  for (const item of items) {
    if (requestId && item.requestId && item.requestId !== requestId) continue;
    if (expectedKey && mediaIdentityKey(item) !== expectedKey) continue;
    if (await isPar2MountedImportPath(item.completedPath)) return item;
  }
  return null;
}

export function listImports() {
  return prisma.importItem.findMany({ orderBy: { createdAt: "desc" }, include: { symlinks: true } });
}

export function getImport(id: string) {
  return prisma.importItem.findUniqueOrThrow({ where: { id }, include: { symlinks: true } });
}

export async function reprocessImport(id: string) {
  const item = await getImport(id);
  const resolved = await resolveImportMedia(item);
  const updated = await prisma.importItem.update({
    where: { id: item.id },
    data: {
      mediaType: resolved.mediaType,
      title: resolved.title,
      year: resolved.year,
      season: resolved.season,
      episode: resolved.episode
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
  await createLibraryEntryForImport(updated);
  await refreshMediaLibrary();
  return getImport(id);
}

export async function migrateImportsToCurrentNaming(options?: { refreshPlex?: boolean; changedPaths?: Set<string> }) {
  const naming = await getNamingSettings();
  const imports = await prisma.importItem.findMany({
    include: { request: true, symlinks: true }
  });
  let moved = 0;
  let relinked = 0;
  const failures: Array<{ importId: string; reason: string }> = [];

  for (const item of imports) {
    try {
      const resolvedMedia = await resolveImportMedia(item);
      const media = {
        mediaType: resolvedMedia.mediaType,
        title: resolvedMedia.title,
        year: resolvedMedia.year,
        season: resolvedMedia.season,
        episode: resolvedMedia.episode,
        tmdbId: resolvedMedia.tmdbId ?? item.request?.tmdbId ?? undefined,
        tvdbId: resolvedMedia.tvdbId ?? item.request?.tvdbId ?? undefined
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

      await createLibraryEntryForImport(updated, {
        refreshPlex: options?.refreshPlex ?? false,
        changedPaths: options?.changedPaths
      });
      relinked += 1;
    } catch (error) {
      failures.push({
        importId: item.id,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await refreshMediaLibrary();
  return { moved, relinked, skipped: failures.length, failures: failures.slice(0, 50) };
}
