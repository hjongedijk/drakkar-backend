import { prisma } from "../db/prisma.js";
import { detectArchive, isPar2File } from "../extract/detect.js";
import { filenameFromSubject } from "../usenet/filename.js";

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

type MountSummary = Awaited<ReturnType<typeof loadMountSummaryByDocumentId>>;
type MountWithFileSegments = Awaited<ReturnType<typeof loadMountWithFileSegments>>;

const MOUNT_CACHE_TTL_MS = 30_000;
const MOUNT_NOT_FOUND_TTL_MS = 15_000;
const mountSummaryCache = new Map<string, { value: NonNullable<MountSummary>; expiresAt: number }>();
const mountFileCache = new Map<string, { value: NonNullable<MountWithFileSegments>; expiresAt: number }>();
const missingMountedPathCache = new Map<string, number>();
let mountsEnsuredAt = 0;

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
  if (mountsEnsuredAt > Date.now() - MOUNT_CACHE_TTL_MS) return;
  const documents = await prisma.nzbDocument.findMany({ include: { mounts: true } });
  for (const document of documents) {
    if (document.mounts.length > 0) continue;
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
}

function cacheMountSummary(mount: NonNullable<MountSummary>) {
  mountSummaryCache.set(mount.nzbDocumentId, { value: mount, expiresAt: Date.now() + MOUNT_CACHE_TTL_MS });
}

function cacheMountFile(mount: NonNullable<MountWithFileSegments>) {
  const file = mount.nzbDocument.files[0];
  if (!file) return;
  mountFileCache.set(`${mount.nzbDocumentId}:${file.id}`, { value: mount, expiresAt: Date.now() + MOUNT_CACHE_TTL_MS });
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
  await ensureMountsForExistingNzbs();
  const mounts = await prisma.vfsMount.findMany({
    orderBy: { createdAt: "desc" },
    include: { nzbDocument: true }
  });
  return mounts.map((mount) => ({
    name: mount.name,
    path: `${basePath}/${mount.nzbDocumentId}`,
    type: "virtual-release" as const,
    size: mount.nzbDocument.totalSize,
    modifiedAt: mount.updatedAt.toISOString(),
    mountId: mount.id,
    nzbDocumentId: mount.nzbDocumentId,
    status: mount.status
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export async function getMountByPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "mounted") return null;
  const documentId = parts[1] === "releases" ? parts[2] : parts[1];
  if (!documentId || ["completed", "downloads", "nzb"].includes(documentId)) return null;
  await ensureMountsForExistingNzbs();
  const cached = mountSummaryCache.get(documentId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const mount = await loadMountSummaryByDocumentId(documentId);
  if (mount) cacheMountSummary(mount);
  return mount;
}

export async function getMountFileByPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "mounted") return null;
  const documentId = parts[1] === "releases" ? parts[2] : parts[1];
  const fileIndex = parts[1] === "releases" ? 3 : 2;
  const fileId = decodeURIComponent(parts[fileIndex]?.split("-")[0] ?? "");
  if (!documentId || !fileId || ["completed", "downloads", "nzb"].includes(documentId)) return null;
  await ensureMountsForExistingNzbs();
  const rawSegment = parts[fileIndex] ?? "";
  const decodedSegment = decodeMountedPathSegment(rawSegment);
  const cacheKey = `${documentId}:${fileId || decodedSegment}`;
  const cached = mountFileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let mount = fileId ? await loadMountWithFileSegments(documentId, fileId) : null;
  if (mount && mount.nzbDocument.files.length === 0) mount = null;
  let resolvedFileId = fileId;
  if (!mount) {
    const mountSummary = await getMountByPath(parts[1] === "releases" ? `/mounted/releases/${documentId}` : `/mounted/${documentId}`);
    if (!mountSummary) return null;
    resolvedFileId = mountedFileForPath(mountSummary, path).file?.id ?? "";
    mount = resolvedFileId ? await loadMountWithFileSegments(documentId, resolvedFileId) : null;
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
    if (cacheKey !== `${documentId}:${resolvedFileId}`) {
      mountFileCache.set(cacheKey, { value: mount, expiresAt: Date.now() + MOUNT_CACHE_TTL_MS });
    }
  }
  return mount;
}

export async function listMountedFiles(path: string): Promise<MountedVfsNode[]> {
  const parts = path.split("/").filter(Boolean);
  const mountPath = parts[1] === "releases" ? `/mounted/releases/${parts[2]}` : `/${parts.slice(0, 2).join("/")}`;
  const mount = await getMountByPath(mountPath);
  if (!mount) throw new Error("mounted NZB not found");
  const basePath = parts[1] === "releases" ? `/mounted/releases/${mount.nzbDocumentId}` : mount.path;
  return mount.nzbDocument.files.map((file, index) => {
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
}

export async function statMountedPath(path: string) {
  if (isCachedMissingMountedPath(path)) throw new Error("mounted NZB file not found");
  if (path === "/mounted/releases") {
    const mounts = await listMounts("/mounted/releases");
    return { path, type: "folder", size: mounts.length, modifiedAt: new Date().toISOString(), isDirectory: true };
  }

  const parts = path.split("/").filter(Boolean);
  const mountPath = parts[1] === "releases" ? `/mounted/releases/${parts[2]}` : `/${parts.slice(0, 2).join("/")}`;
  const mount = await getMountByPath(mountPath);
  if (!mount) {
    cacheMissingMountedPath(path);
    throw new Error("mounted VFS path not found");
  }
  if (path === mount.path || path === `/mounted/${mount.nzbDocumentId}` || path === `/mounted/${mount.id}` || path === `/mounted/releases/${mount.nzbDocumentId}` || path === `/mounted/releases/${mount.id}`) {
    clearMissingMountedPath(path);
    return {
      path,
      type: "virtual-release",
      size: mount.nzbDocument.totalSize,
      modifiedAt: mount.updatedAt.toISOString(),
      isDirectory: true
    };
  }

  const { file, index: subjectIndex } = mountedFileForPath(mount, path);
  if (!file) {
    cacheMissingMountedPath(path);
    throw new Error("mounted NZB file not found");
  }
  clearMissingMountedPath(path);
  const name = safeFileName(file.subject, subjectIndex);
  const archive = detectArchive(name) !== "none" || isPar2File(name);
  return {
    path,
    type: archive ? "archive-file" : "streamable-file",
    size: file.size,
    modifiedAt: (file.date ?? mount.updatedAt).toISOString(),
    isDirectory: false,
    requiresStreaming: false,
    requiresExtract: archive,
    status: archive ? "requires_extract" : mount.streamable ? "streamable" : "not_streamable"
  };
}

export function isMountedPath(path = "/") {
  if (path === "/mounted/releases" || path.startsWith("/mounted/releases/")) return true;
  const first = path.split("/").filter(Boolean)[1];
  return path.startsWith("/mounted/") && Boolean(first) && !["completed", "downloads", "nzb"].includes(first ?? "");
}
