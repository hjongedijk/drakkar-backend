import { prisma } from "../db/prisma.js";
import { detectArchive } from "../extract/detect.js";
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

function safeFileName(value: string, index: number) {
  const extracted = filenameFromSubject(value, index);
  if (/\.(mkv|mp4|avi|mov|m4v|ts|srt|ass|ssa|vtt|sub)$/i.test(extracted)) return extracted;
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
  return prisma.vfsMount.findFirst({
    where: { OR: [{ path: `/mounted/${documentId}` }, { nzbDocumentId: documentId }, { id: documentId }] },
    include: { nzbDocument: { include: { files: { include: { segments: { orderBy: { number: "asc" } } } } } } }
  });
}

export async function listMountedFiles(path: string): Promise<MountedVfsNode[]> {
  const parts = path.split("/").filter(Boolean);
  const mountPath = parts[1] === "releases" ? `/mounted/releases/${parts[2]}` : `/${parts.slice(0, 2).join("/")}`;
  const mount = await getMountByPath(mountPath);
  if (!mount) throw new Error("mounted NZB not found");
  const basePath = parts[1] === "releases" ? `/mounted/releases/${mount.nzbDocumentId}` : mount.path;
  return mount.nzbDocument.files.map((file, index) => {
    const name = safeFileName(file.subject, index);
    const archive = detectArchive(name) !== "none";
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
  if (path === "/mounted/releases") {
    const mounts = await listMounts("/mounted/releases");
    return { path, type: "folder", size: mounts.length, modifiedAt: new Date().toISOString(), isDirectory: true };
  }

  const parts = path.split("/").filter(Boolean);
  const mountPath = parts[1] === "releases" ? `/mounted/releases/${parts[2]}` : `/${parts.slice(0, 2).join("/")}`;
  const mount = await getMountByPath(mountPath);
  if (!mount) throw new Error("mounted VFS path not found");
  if (path === mount.path || path === `/mounted/${mount.nzbDocumentId}` || path === `/mounted/${mount.id}` || path === `/mounted/releases/${mount.nzbDocumentId}` || path === `/mounted/releases/${mount.id}`) {
    return {
      path,
      type: "virtual-release",
      size: mount.nzbDocument.totalSize,
      modifiedAt: mount.updatedAt.toISOString(),
      isDirectory: true
    };
  }

  const fileIndex = parts[1] === "releases" ? 3 : 2;
  const fileId = decodeURIComponent(parts[fileIndex]?.split("-")[0] ?? "");
  const subjectIndex = mount.nzbDocument.files.findIndex((item) => item.id === fileId);
  const file = subjectIndex >= 0 ? mount.nzbDocument.files[subjectIndex] : undefined;
  if (!file) throw new Error("mounted NZB file not found");
  const name = safeFileName(file.subject, subjectIndex);
  const archive = detectArchive(name) !== "none";
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
