import { prisma } from "../repositories/db/prisma.js";
import { getStoredArchiveEntryByPath, listStoredArchiveEntries } from "../services/archive/rarStoredIndex.js";
import { detectArchive, isPar2File } from "../services/extract/detect.js";
import { filenameFromSubject } from "../services/usenet/filename.js";

export type MountedVfsNode = {
  name: string;
  path: string;
  type: "folder" | "virtual-release" | "streamable-file" | "archive-file";
  size: number;
  modifiedAt: string;
  mountId?: string;
  nzbDocumentId?: string;
  status?: string;
};

type MountedPathStat = {
  path: string;
  type: "folder" | "virtual-release" | "streamable-file" | "archive-file";
  size: number;
  modifiedAt: string;
  isDirectory: boolean;
  requiresStreaming?: boolean;
  requiresExtract?: boolean;
  status?: string;
};

type MountSummary = Awaited<ReturnType<typeof loadMountSummaryByDocumentId>>;
type MountWithFileSegments = Awaited<ReturnType<typeof loadMountWithFileSegments>>;
type MountMeta = Awaited<ReturnType<typeof loadMountMetaByDocumentId>>;
type MountedFileMeta = Awaited<ReturnType<typeof loadMountedFileMetaByDocumentIdAndFileId>>;

const MOUNT_CACHE_TTL_MS = 30_000;
const MOUNT_NOT_FOUND_TTL_MS = 15_000;
const MOUNT_STAT_CACHE_TTL_MS = 60_000;
const MOUNT_LIST_CACHE_TTL_MS = 5 * 60_000;
const MOUNT_DIR_CACHE_TTL_MS = 5 * 60_000;
const ENSURE_MOUNTS_INTERVAL_MS = 5 * 60_000;
const mountSummaryCache = new Map<string, { value: NonNullable<MountSummary>; expiresAt: number }>();
const mountFileCache = new Map<string, { value: NonNullable<MountWithFileSegments>; expiresAt: number }>();
const mountMetaCache = new Map<string, { value: NonNullable<MountMeta>; expiresAt: number }>();
const mountedFileMetaCache = new Map<string, { value: NonNullable<MountedFileMeta>; expiresAt: number }>();
const mountedPathStatCache = new Map<string, { value: MountedPathStat; expiresAt: number }>();
const mountedListCache = new Map<string, { value: MountedVfsNode[]; expiresAt: number }>();
const mountedDirCache = new Map<string, { value: MountedVfsNode[]; expiresAt: number }>();
const missingMountedPathCache = new Map<string, number>();
let mountsEnsuredAt = 0;
let ensureMountsPromise: Promise<void> | null = null;

function isCachedMissingMountedPath(path: string) {
  const expiresAt = missingMountedPathCache.get(path);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    missingMountedPathCache.delete(path);
    return false;
  }
  return true;
}

function cacheMissingMountedPath(path: string) {
  missingMountedPathCache.set(path, Date.now() + MOUNT_NOT_FOUND_TTL_MS);
}

function clearMissingMountedPath(path: string) {
  missingMountedPathCache.delete(path);
}

function cachedMapGet<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.value;
}

function cachedMapSet<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string, value: T, ttlMs = MOUNT_CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function safeFileName(value: string, index: number) {
  const extracted = filenameFromSubject(value, index);
  if (/\.(mkv|mp4|avi|mov|m4v|ts|srt|ass|ssa|vtt|sub|par2|zip|7z(?:\.\d+)?|rar|part\d+\.rar)$/i.test(extracted)) return extracted;
  const stripped = value
    .replace(/\byEnc\b.*$/i, "")
    .replace(/^\[\d+\/\d+\]\s*/i, "")
    .replace(/^"+|"+$/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || `file-${index + 1}`;
}

export async function ensureMountsForExistingNzbs() {
  if (mountsEnsuredAt > Date.now() - ENSURE_MOUNTS_INTERVAL_MS) return;
  if (ensureMountsPromise) return ensureMountsPromise;
  ensureMountsPromise = (async () => {
    const documents = await prisma.nzbDocument.findMany({
      where: {
        mounts: {
          none: {}
        }
      },
      select: {
        id: true,
        title: true
      }
    });
    for (const document of documents) {
      await prisma.vfsMount.upsert({
        where: { path: `/mounted/${document.id}` },
        update: {
          streamable: false,
          status: "pending"
        },
        create: {
          nzbDocumentId: document.id,
          name: document.title.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").slice(0, 180) || document.id,
          path: `/mounted/${document.id}`,
          status: "pending",
          streamable: false
        }
      });
    }
    mountsEnsuredAt = Date.now();
  })().finally(() => {
    ensureMountsPromise = null;
  });
  return ensureMountsPromise;
}

function cacheMountSummary(mount: NonNullable<MountSummary>) {
  cachedMapSet(mountSummaryCache, mount.nzbDocumentId, mount);
}

function cacheMountFile(mount: NonNullable<MountWithFileSegments>) {
  const file = mount.nzbDocument.files[0];
  if (!file) return;
  cachedMapSet(mountFileCache, `${mount.nzbDocumentId}:${file.id}`, mount);
}

function cacheMountMeta(mount: NonNullable<MountMeta>) {
  cachedMapSet(mountMetaCache, mount.nzbDocumentId, mount);
}

function cacheMountedPathStat(path: string, value: MountedPathStat) {
  cachedMapSet(mountedPathStatCache, path, value, MOUNT_STAT_CACHE_TTL_MS);
  return value;
}

async function loadMountSummaryByDocumentId(documentId: string) {
  return prisma.vfsMount.findFirst({
    where: { OR: [{ path: `/mounted/${documentId}` }, { nzbDocumentId: documentId }, { id: documentId }] },
    include: {
      nzbDocument: {
        include: {
          files: {
            select: {
              id: true,
              subject: true,
              size: true,
              date: true
            }
          }
        }
      }
    }
  });
}

async function loadMountMetaByDocumentId(documentId: string) {
  return prisma.vfsMount.findFirst({
    where: { OR: [{ path: `/mounted/${documentId}` }, { nzbDocumentId: documentId }, { id: documentId }] },
    select: {
      id: true,
      name: true,
      path: true,
      status: true,
      streamable: true,
      createdAt: true,
      updatedAt: true,
      nzbDocumentId: true,
      nzbDocument: {
        select: {
          id: true,
          title: true,
          totalSize: true
        }
      }
    }
  });
}

async function loadMountWithFileSegments(documentId: string, fileId: string) {
  return prisma.vfsMount.findFirst({
    where: { OR: [{ path: `/mounted/${documentId}` }, { nzbDocumentId: documentId }, { id: documentId }] },
    include: {
      nzbDocument: {
        include: {
          files: {
            where: { id: fileId },
            include: {
              segments: { orderBy: { number: "asc" } }
            }
          }
        }
      }
    }
  });
}

async function loadMountedFileMetaByDocumentIdAndFileId(documentId: string, fileId: string) {
  return prisma.nzbFile.findFirst({
    where: {
      id: fileId,
      nzbDocumentId: documentId
    },
    select: {
      id: true,
      subject: true,
      size: true,
      date: true,
      nzbDocumentId: true
    }
  });
}

export function parseMountedPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "mounted") return null;
  const isReleasePath = parts[1] === "releases";
  const documentId = isReleasePath ? parts[2] : parts[1];
  if (!documentId || ["completed", "downloads", "nzb"].includes(documentId)) return null;
  const fileIndex = isReleasePath ? 3 : 2;
  const rawSegment = parts[fileIndex] ?? "";
  const decodedSegment = decodeMountedPathSegment(rawSegment);
  const fileId = decodeURIComponent(decodedSegment.split("-")[0] ?? "");
  return {
    parts,
    documentId,
    mountPath: isReleasePath ? `/mounted/releases/${documentId}` : `/${parts.slice(0, 2).join("/")}`,
    isReleasePath,
    isRoot: parts.length === (isReleasePath ? 3 : 2),
    isArchivePath: parts[fileIndex] === "archive",
    fileIndex,
    rawSegment,
    decodedSegment,
    fileId
  };
}

function decodeMountedPathSegment(value?: string) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mountedFileForPath(
  mount: NonNullable<MountSummary> | NonNullable<MountWithFileSegments>,
  path: string
) {
  const parts = path.split("/").filter(Boolean);
  const fileIndex = parts[1] === "releases" ? 3 : 2;
  const rawSegment = parts[fileIndex] ?? "";
  const decodedSegment = decodeMountedPathSegment(rawSegment);
  const fileIdPrefix = decodedSegment.split("-")[0] ?? "";
  const directIndex = mount.nzbDocument.files.findIndex((item) => item.id === fileIdPrefix);
  if (directIndex >= 0) {
    const file = mount.nzbDocument.files[directIndex];
    return { file, index: directIndex };
  }

  const byNameIndex = mount.nzbDocument.files.findIndex((item, index) => {
    const name = safeFileName(item.subject, index);
    return name === decodedSegment;
  });
  if (byNameIndex >= 0) {
    const file = mount.nzbDocument.files[byNameIndex];
    return { file, index: byNameIndex };
  }

  return { file: undefined, index: -1 };
}

export async function listMounts(basePath = "/mounted"): Promise<MountedVfsNode[]> {
  const cached = cachedMapGet(mountedListCache, basePath);
  if (cached) return cached;
  await ensureMountsForExistingNzbs();
  const mounts = await prisma.vfsMount.findMany({
    orderBy: { createdAt: "desc" },
    include: { nzbDocument: true }
  });
  return cachedMapSet(mountedListCache, basePath, mounts.map((mount) => ({
    name: mount.name,
    path: `${basePath}/${mount.nzbDocumentId}`,
    type: "virtual-release" as const,
    size: mount.nzbDocument.totalSize,
    modifiedAt: mount.updatedAt.toISOString(),
    mountId: mount.id,
    nzbDocumentId: mount.nzbDocumentId,
    status: mount.status
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })), MOUNT_LIST_CACHE_TTL_MS);
}

export async function getMountByPath(path: string) {
  const parsed = parseMountedPath(path);
  if (!parsed) return null;
  await ensureMountsForExistingNzbs();
  const cached = cachedMapGet(mountSummaryCache, parsed.documentId);
  if (cached) return cached;
  const mount = await loadMountSummaryByDocumentId(parsed.documentId);
  if (mount) cacheMountSummary(mount);
  return mount;
}

export async function getMountFileByPath(path: string) {
  const parsed = parseMountedPath(path);
  if (!parsed?.fileId) return null;
  await ensureMountsForExistingNzbs();
  const cacheKey = `${parsed.documentId}:${parsed.fileId || parsed.decodedSegment}`;
  const cached = cachedMapGet(mountFileCache, cacheKey);
  if (cached) return cached;

  let mount = parsed.fileId ? await loadMountWithFileSegments(parsed.documentId, parsed.fileId) : null;
  if (mount && mount.nzbDocument.files.length === 0) mount = null;
  let resolvedFileId = parsed.fileId;
  if (!mount) {
    const mountSummary = await getMountByPath(parsed.mountPath);
    if (!mountSummary) return null;
    resolvedFileId = mountedFileForPath(mountSummary, path).file?.id ?? "";
    mount = resolvedFileId ? await loadMountWithFileSegments(parsed.documentId, resolvedFileId) : null;
    if (mount && mount.nzbDocument.files.length === 0) mount = null;
  }

  if (mount) {
    cacheMountSummary({
      ...mount,
      nzbDocument: {
        ...mount.nzbDocument,
        files: mount.nzbDocument.files.map((file) => ({
          id: file.id,
          subject: file.subject,
          size: file.size,
          date: file.date
        }))
      }
    });
    cacheMountFile(mount);
    if (cacheKey !== `${parsed.documentId}:${resolvedFileId}`) {
      cachedMapSet(mountFileCache, cacheKey, mount);
    }
  }
  return mount;
}

async function getMountMetaByPath(path: string) {
  const parsed = parseMountedPath(path);
  if (!parsed) return null;
  await ensureMountsForExistingNzbs();
  const cached = cachedMapGet(mountMetaCache, parsed.documentId);
  if (cached) return cached;
  const mount = await loadMountMetaByDocumentId(parsed.documentId);
  if (mount) cacheMountMeta(mount);
  return mount;
}

async function getMountedFileMetaByPath(path: string) {
  const parsed = parseMountedPath(path);
  if (!parsed?.fileId) return null;
  const cacheKey = `${parsed.documentId}:${parsed.fileId}`;
  const cached = cachedMapGet(mountedFileMetaCache, cacheKey);
  if (cached) return cached;
  const file = await loadMountedFileMetaByDocumentIdAndFileId(parsed.documentId, parsed.fileId);
  if (!file) return null;
  return cachedMapSet(mountedFileMetaCache, cacheKey, file);
}

export async function listMountedFiles(path: string): Promise<MountedVfsNode[]> {
  const cached = cachedMapGet(mountedDirCache, path);
  if (cached) return cached;
  const parsed = parseMountedPath(path);
  if (!parsed) throw new Error("mounted NZB not found");
  const parts = path.split("/").filter(Boolean);
  const mountPath = parts[1] === "releases" ? `/mounted/releases/${parts[2]}` : `/${parts.slice(0, 2).join("/")}`;
  const mount = await getMountByPath(mountPath);
  if (!mount) throw new Error("mounted NZB not found");
  const basePath = parts[1] === "releases" ? `/mounted/releases/${mount.nzbDocumentId}` : mount.path;
  const directFiles = mount.nzbDocument.files.map((file, index) => {
    const name = safeFileName(file.subject, index);
    const archive = detectArchive(name) !== "none" || isPar2File(name);
    return {
      name,
      path: `${basePath}/${encodeURIComponent(file.id)}-${encodeURIComponent(name)}`,
      type: archive ? "archive-file" as const : "streamable-file" as const,
      size: file.size,
      modifiedAt: (file.date ?? mount.updatedAt).toISOString(),
      mountId: mount.id,
      nzbDocumentId: mount.nzbDocumentId,
      status: archive ? "requires_extract" : mount.streamable ? "streamable" : "not_streamable"
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const archiveFiles = await listStoredArchiveEntries(mount.nzbDocumentId);
  if (parsed.isArchivePath) {
    const virtualFiles = archiveFiles.map((file) => ({
      name: file.name,
      path: `${basePath}/archive/${encodeURIComponent(file.name)}`,
      type: "streamable-file" as const,
      size: file.size,
      modifiedAt: file.modifiedAt.toISOString(),
      mountId: mount.id,
      nzbDocumentId: mount.nzbDocumentId,
      status: "streamable_archive"
    }));
    return cachedMapSet(
      mountedDirCache,
      path,
      virtualFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
      MOUNT_DIR_CACHE_TTL_MS
    );
  }
  const hasArchiveFiles = archiveFiles.length > 0;
  const archiveFolder = hasArchiveFiles
    ? [{
        name: "archive",
        path: `${basePath}/archive`,
        type: "folder" as const,
        size: archiveFiles.length,
        modifiedAt: mount.updatedAt.toISOString(),
        mountId: mount.id,
        nzbDocumentId: mount.nzbDocumentId,
        status: "streamable_archive"
      }]
    : [];
  return cachedMapSet(
    mountedDirCache,
    path,
    [...archiveFolder, ...directFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
    MOUNT_DIR_CACHE_TTL_MS
  );
}

export async function statMountedPath(path: string) {
  const cachedStat = cachedMapGet(mountedPathStatCache, path);
  if (cachedStat) return cachedStat;
  if (isCachedMissingMountedPath(path)) throw new Error("mounted NZB file not found");
  if (path === "/mounted/releases") {
    const mounts = await listMounts("/mounted/releases");
    return cacheMountedPathStat(path, { path, type: "folder", size: mounts.length, modifiedAt: new Date().toISOString(), isDirectory: true });
  }

  const parsed = parseMountedPath(path);
  if (!parsed) {
    cacheMissingMountedPath(path);
    throw new Error("mounted VFS path not found");
  }
  const mount = await getMountMetaByPath(parsed.mountPath);
  if (!mount) {
    cacheMissingMountedPath(path);
    throw new Error("mounted VFS path not found");
  }
  if (path === mount.path || path === `/mounted/${mount.nzbDocumentId}` || path === `/mounted/${mount.id}` || path === `/mounted/releases/${mount.nzbDocumentId}` || path === `/mounted/releases/${mount.id}`) {
    clearMissingMountedPath(path);
    return cacheMountedPathStat(path, {
      path,
      type: "virtual-release",
      size: mount.nzbDocument.totalSize,
      modifiedAt: mount.updatedAt.toISOString(),
      isDirectory: true
    });
  }

  const archiveEntry = parsed.isArchivePath ? await getStoredArchiveEntryByPath(path).catch(() => null) : null;
  if (archiveEntry) {
    clearMissingMountedPath(path);
    return cacheMountedPathStat(path, {
      path,
      type: "streamable-file",
      size: archiveEntry.size,
      modifiedAt: archiveEntry.modifiedAt.toISOString(),
      isDirectory: false,
      requiresStreaming: true,
      requiresExtract: false,
      status: "streamable_archive"
    });
  }
  if (parsed.isArchivePath && path.endsWith("/archive")) {
    clearMissingMountedPath(path);
    return cacheMountedPathStat(path, {
      path,
      type: "folder",
      size: 0,
      modifiedAt: mount.updatedAt.toISOString(),
      isDirectory: true,
      status: "streamable_archive"
    });
  }

  const mountedFile = await getMountedFileMetaByPath(path);
  if (mountedFile) {
    clearMissingMountedPath(path);
    const name = safeFileName(mountedFile.subject, 0);
    const archive = detectArchive(name) !== "none" || isPar2File(name);
    return cacheMountedPathStat(path, {
      path,
      type: archive ? "archive-file" : "streamable-file",
      size: mountedFile.size,
      modifiedAt: (mountedFile.date ?? mount.updatedAt).toISOString(),
      isDirectory: false,
      requiresStreaming: false,
      requiresExtract: archive,
      status: archive ? "requires_extract" : mount.streamable ? "streamable" : "not_streamable"
    });
  }

  const mountSummary = await getMountByPath(parsed.mountPath);
  if (!mountSummary) {
    cacheMissingMountedPath(path);
    throw new Error("mounted NZB file not found");
  }
  const { file, index: subjectIndex } = mountedFileForPath(mountSummary, path);
  if (!file) {
    cacheMissingMountedPath(path);
    throw new Error("mounted NZB file not found");
  }
  clearMissingMountedPath(path);
  const name = safeFileName(file.subject, subjectIndex);
  const archive = detectArchive(name) !== "none" || isPar2File(name);
  return cacheMountedPathStat(path, {
    path,
    type: archive ? "archive-file" : "streamable-file",
    size: file.size,
    modifiedAt: (file.date ?? mountSummary.updatedAt).toISOString(),
    isDirectory: false,
    requiresStreaming: false,
    requiresExtract: archive,
    status: archive ? "requires_extract" : mountSummary.streamable ? "streamable" : "not_streamable"
  });
}

export function isMountedPath(path = "/") {
  if (path === "/mounted/releases" || path.startsWith("/mounted/releases/")) return true;
  const first = path.split("/").filter(Boolean)[1];
  return path.startsWith("/mounted/") && Boolean(first) && !["completed", "downloads", "nzb"].includes(first ?? "");
}
