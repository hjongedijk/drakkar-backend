import { createReadStream } from "node:fs";
import { mkdir, open, readdir, stat, lstat, readlink, rename, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { env } from "../services/config/env.js";
import { redis } from "../repositories/db/redis.js";
import { getIgnoredPatterns, matchesIgnoredPattern } from "../services/policyService.js";
import { readMountedFileRange, streamMountedFile } from "../services/mountedStream.service.js";
import { isMountedPath, listMountedFiles, listMounts, statMountedPath } from "./mountedNzbService.js";

export type VfsNodeType =
  | "file"
  | "folder"
  | "symlink"
  | "virtual-release"
  | "nzb-document"
  | "completed-item"
  | "streamable-file";

const hiddenSystemFolders = new Set([".failed", ".tmp"]);
const VFS_LIST_CACHE_TTL_SECONDS = 30;
const VFS_STAT_CACHE_TTL_SECONDS = 30;

const rootFolders = [
  { name: "content", path: "/content", target: env.VFS_COMPLETED_DIR },
  { name: "completed-symlinks", path: "/completed-symlinks", target: env.VFS_COMPLETED_SYMLINKS_DIR },
  { name: "nzbs", path: "/nzbs", target: env.VFS_NZB_DIR }
] as const;

const mediaFolders = [
  { name: "movies", path: "/media/movies", target: env.MEDIA_MOVIES_DIR },
  { name: "tv", path: "/media/tv", target: env.MEDIA_TV_DIR }
] as const;

export function resolveVfsPath(input = "/") {
  const clean = normalize(`/${input}`).replace(/^\/+/, "");
  const resolved = join(env.VFS_ROOT, clean);
  const rel = relative(env.VFS_ROOT, resolved);
  if (rel.startsWith("..") || rel === ".." || normalize(resolved) === normalize(env.VFS_ROOT) + "/..") {
    throw new Error("unsafe VFS path");
  }
  return resolved;
}

function safeJoin(root: string, subPath = "") {
  const clean = normalize(`/${subPath}`).replace(/^\/+/, "");
  const resolved = join(root, clean);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel === ".." || normalize(resolved) === normalize(root) + "/..") {
    throw new Error("unsafe VFS path");
  }
  return resolved;
}

function virtualPhysicalRoot(input = "/") {
  const path = normalize(`/${input}`).replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "downloads") return { root: env.VFS_DOWNLOADS_DIR, subPath: parts.slice(1).join("/"), virtualRoot: "/downloads" };
  if (parts[0] === "content" || parts[0] === "completed") return { root: env.VFS_COMPLETED_DIR, subPath: parts.slice(1).join("/"), virtualRoot: "/content" };
  if (parts[0] === "completed-symlinks") return { root: env.VFS_COMPLETED_SYMLINKS_DIR, subPath: parts.slice(1).join("/"), virtualRoot: "/completed-symlinks" };
  if (parts[0] === "nzbs" || parts[0] === "nzb") return { root: env.VFS_NZB_DIR, subPath: parts.slice(1).join("/"), virtualRoot: "/nzbs" };
  if (parts[0] === "media") {
    const media = mediaFolders.find((folder) => folder.name === parts[1] || (folder.name === "tv" && parts[1] === "tv shows"));
    if (!media) return null;
    return { root: media.target, subPath: parts.slice(2).join("/"), virtualRoot: media.path };
  }
  return null;
}

function resolveVirtualPhysicalPath(input = "/") {
  const mapping = virtualPhysicalRoot(input);
  if (!mapping) return null;
  return { ...mapping, resolved: safeJoin(mapping.root, mapping.subPath) };
}

async function mountedTargetForSymlink(resolved: string) {
  const linkTarget = await readlink(resolved).catch(() => null);
  if (!linkTarget) return null;
  const physicalTarget = linkTarget.startsWith("/")
    ? normalize(linkTarget)
    : normalize(resolve(dirname(resolved), linkTarget));
  if (!physicalTarget.startsWith(env.FUSE_MOUNT_PATH)) return null;
  return normalize(`/${physicalTarget.slice(env.FUSE_MOUNT_PATH.length)}`).replace(/\/+$/, "") || "/";
}

function virtualFolderNode(name: string, path: string) {
  return {
    name,
    path,
    type: "folder" as const,
    size: 0,
    modifiedAt: new Date().toISOString()
  };
}

function nodeType(path: string, isDirectory: boolean, isSymlink = false): VfsNodeType {
  if (isSymlink) return "symlink";
  if (isDirectory) return "folder";
  if (extname(path).toLowerCase() === ".nzb") return "nzb-document";
  if (path.includes("/completed/")) return "completed-item";
  return "file";
}

function sortNodes<T extends { name: string; type: string }>(nodes: T[]) {
  return nodes.sort((a, b) => {
    const aFolder = a.type === "folder" || a.type === "virtual-release";
    const bFolder = b.type === "folder" || b.type === "virtual-release";
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export async function listVfs(path = "/", showHidden = false) {
  const normalizedPath = normalize(`/${path}`).replace(/\/+$/, "") || "/";
  const cacheKey = `vfs:list:${showHidden ? "hidden" : "visible"}:${normalizedPath}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  if (normalizedPath === "/") return rootFolders.map((folder) => virtualFolderNode(folder.name, folder.path));
  if (normalizedPath === "/media") return mediaFolders.map((folder) => virtualFolderNode(folder.name, folder.path));
  if (normalizedPath === "/mounted") return [];
  if (normalizedPath === "/mounted/releases") return listMounts("/mounted/releases");
  if (normalizedPath.startsWith("/mounted/releases/")) return listMountedFiles(normalizedPath);
  if (isMountedPath(normalizedPath)) return listMountedFiles(normalizedPath);

  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  const entries = await readdir(resolved, { withFileTypes: true });
  const ignoredPatterns = await getIgnoredPatterns();
  const nodes = await Promise.all(
    entries
      .filter((entry) => showHidden || !hiddenSystemFolders.has(entry.name))
      .filter((entry) => showHidden || !entry.name.startsWith("."))
      .filter((entry) => showHidden || !matchesIgnoredPattern(join(path, entry.name), ignoredPatterns))
      .map(async (entry) => {
        const fullPath = join(resolved, entry.name);
        const linkStats = await lstat(fullPath);
        const isSymlink = linkStats.isSymbolicLink();
        const mountedTarget = isSymlink ? await mountedTargetForSymlink(fullPath) : null;
        const mountedStats = mountedTarget ? await statMountedPath(mountedTarget).catch(() => null) : null;
        const stats = mountedStats
          ? { size: mountedStats.size, mtime: new Date(mountedStats.modifiedAt), isDirectory: () => mountedStats.isDirectory }
          : isSymlink
            ? await stat(fullPath).catch(() => linkStats)
            : linkStats;
        const vfsPath = virtual ? `${virtual.virtualRoot}/${relative(virtual.root, fullPath)}` : `/${relative(env.VFS_ROOT, fullPath)}`;
        return {
          name: entry.name,
          path: vfsPath,
          type: nodeType(vfsPath, stats.isDirectory(), isSymlink),
          size: stats.size,
          modifiedAt: stats.mtime.toISOString()
        };
      })
  );
  const sorted = sortNodes(nodes);
  await redis.set(cacheKey, JSON.stringify(sorted), "EX", VFS_LIST_CACHE_TTL_SECONDS);
  return sorted;
}

export type VfsTreeNode = {
  name: string;
  path: string;
  type: "folder" | "virtual-release";
  children: VfsTreeNode[];
};

export async function treeVfs(path = "/", maxDepth = 4, showHidden = false): Promise<VfsTreeNode> {
  const normalizedPath = normalize(`/${path}`).replace(/\/+$/, "") || "/";
  const rootName = normalizedPath === "/" ? "root" : normalizedPath.split("/").filter(Boolean).at(-1) ?? "root";
  const root: VfsTreeNode = { name: rootName, path: normalizedPath, type: normalizedPath.startsWith("/mounted/") ? "virtual-release" : "folder", children: [] };
  if (maxDepth <= 0) return root;

  const children = await listVfs(normalizedPath, showHidden);
  const folderChildren = children.filter(
    (node: Awaited<ReturnType<typeof listVfs>>[number]): node is Awaited<ReturnType<typeof listVfs>>[number] =>
      node.type === "folder" || node.type === "virtual-release"
  );
  root.children = await Promise.all(folderChildren.map((node: Awaited<ReturnType<typeof listVfs>>[number]) => treeVfs(node.path, maxDepth - 1, showHidden)));
  return root;
}

export async function statVfs(path = "/") {
  const normalizedPath = normalize(`/${path}`).replace(/\/+$/, "") || "/";
  const cacheKey = `vfs:stat:${normalizedPath}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as { path: string; type: VfsNodeType; size: number; modifiedAt: string; isDirectory: boolean };
  if (normalizedPath === "/" || normalizedPath === "/mounted" || normalizedPath === "/media") {
    const value = { path: normalizedPath, type: "folder" as const, size: 0, modifiedAt: new Date().toISOString(), isDirectory: true };
    await redis.set(cacheKey, JSON.stringify(value), "EX", VFS_STAT_CACHE_TTL_SECONDS);
    return value;
  }
  if (normalizedPath === "/mounted/releases" || normalizedPath.startsWith("/mounted/releases/") || isMountedPath(normalizedPath)) {
    const mounted = await statMountedPath(normalizedPath);
    await redis.set(cacheKey, JSON.stringify(mounted), "EX", VFS_STAT_CACHE_TTL_SECONDS);
    return mounted;
  }

  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  const linkStats = await lstat(resolved);
  if (linkStats.isSymbolicLink()) {
    const mountedTarget = await mountedTargetForSymlink(resolved);
    if (mountedTarget) {
      const mounted = await statMountedPath(mountedTarget);
      await redis.set(cacheKey, JSON.stringify(mounted), "EX", VFS_STAT_CACHE_TTL_SECONDS);
      return mounted;
    }
  }
  const stats = linkStats.isSymbolicLink() ? await stat(resolved) : linkStats;
  const value = {
    path: normalizedPath,
    type: nodeType(normalizedPath, stats.isDirectory(), linkStats.isSymbolicLink()),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    isDirectory: stats.isDirectory()
  };
  await redis.set(cacheKey, JSON.stringify(value), "EX", VFS_STAT_CACHE_TTL_SECONDS);
  return value;
}

export async function streamVfsFile(path: string, range?: string, signal?: AbortSignal) {
  const normalizedPath = normalize(`/${path}`).replace(/\/+$/, "") || "/";
  const playbackPath = await resolveVfsPlaybackPath(normalizedPath).catch(() => null);
  if (playbackPath) {
    const playbackStats = await stat(playbackPath).catch(() => null);
    if (playbackStats && !playbackStats.isDirectory()) {
      if (!range) {
        return { stream: createReadStream(playbackPath), start: 0, end: playbackStats.size - 1, size: playbackStats.size, partial: false };
      }

      const match = range.match(/bytes=(\d*)-(\d*)/);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : playbackStats.size - 1;
      return {
        stream: createReadStream(playbackPath, { start, end }),
        start,
        end,
        size: playbackStats.size,
        partial: true
      };
    }
  }

  if (normalizedPath === "/mounted/releases" || normalizedPath.startsWith("/mounted/releases/") || isMountedPath(normalizedPath)) {
    return streamMountedFile(normalizedPath, range, { source: "http", signal });
  }

  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  const linkStats = await lstat(resolved);
  const stats = linkStats.isSymbolicLink() ? await stat(resolved) : linkStats;
  if (stats.isDirectory()) throw new Error("cannot stream a directory");
  if (!range) return { stream: createReadStream(resolved), start: 0, end: stats.size - 1, size: stats.size, partial: false };
  const match = range.match(/bytes=(\d*)-(\d*)/);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : stats.size - 1;
  return { stream: createReadStream(resolved, { start, end }), start, end, size: stats.size, partial: true };
}

export async function resolveVfsPlaybackPath(path: string) {
  const normalizedPath = normalize(`/${path}`).replace(/\/+$/, "") || "/";
  if (normalizedPath === "/mounted/releases" || normalizedPath.startsWith("/mounted/releases/") || isMountedPath(normalizedPath)) {
    return join(env.FUSE_MOUNT_PATH, normalizedPath);
  }

  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  const linkStats = await lstat(resolved);
  if (linkStats.isSymbolicLink()) {
    const mountedTarget = await mountedTargetForSymlink(resolved);
    if (mountedTarget) return join(env.FUSE_MOUNT_PATH, mountedTarget);
  }
  return resolved;
}

export async function readVfsBytes(path: string, start: number, length: number, sessionId?: string) {
  const normalizedPath = normalize(`/${path}`).replace(/\/+$/, "") || "/";
  if (length <= 0) return Buffer.alloc(0);
  const playbackPath = await resolveVfsPlaybackPath(normalizedPath).catch(() => null);
  if (playbackPath) {
    const playbackHandle = await open(playbackPath, "r").catch(() => null);
    if (playbackHandle) {
      try {
        const buffer = Buffer.alloc(length);
        const result = await playbackHandle.read(buffer, 0, length, start);
        return buffer.subarray(0, result.bytesRead);
      } finally {
        await playbackHandle.close();
      }
    }
  }
  if (normalizedPath === "/mounted/releases" || normalizedPath.startsWith("/mounted/releases/") || isMountedPath(normalizedPath)) {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < length) {
      const chunk = await readMountedFileRange({
        path: normalizedPath,
        start: start + total,
        length: length - total,
        sessionId,
        source: "fuse"
      });
      if (!chunk.length) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
  }

  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  const handle = await open(resolved, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export async function refreshVfs() {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "vfs:list:*", "COUNT", 200);
    if (keys.length > 0) await redis.del(...keys);
    cursor = nextCursor;
  } while (cursor !== "0");
  await redis.set("vfs:last-refresh", new Date().toISOString());
  return { ok: true };
}

function assertEditableVfsPath(path: string) {
  const normalizedPath = normalize(`/${path}`).replace(/\/+$/, "") || "/";
  if (normalizedPath.startsWith("/mounted")) throw new Error("Mounted release paths are read-only.");
  if (isMountedPath(normalizedPath)) throw new Error("Mounted release paths are read-only.");
  return normalizedPath;
}

export async function createVfsFolder(path: string) {
  const normalizedPath = assertEditableVfsPath(path);
  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  await mkdir(resolved, { recursive: true });
  await refreshVfs();
  return statVfs(normalizedPath);
}

export async function createVfsFile(path: string, content = "") {
  const normalizedPath = assertEditableVfsPath(path);
  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  await refreshVfs();
  return statVfs(normalizedPath);
}

export async function readVfsTextFile(path: string) {
  const normalizedPath = assertEditableVfsPath(path);
  const stats = await statVfs(normalizedPath);
  if (stats.isDirectory) throw new Error("Cannot edit a directory.");
  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  return {
    path: normalizedPath,
    content: await readFile(resolved, "utf8")
  };
}

export async function updateVfsFile(path: string, content: string) {
  const normalizedPath = assertEditableVfsPath(path);
  const stats = await statVfs(normalizedPath);
  if (stats.isDirectory) throw new Error("Cannot edit a directory.");
  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  await writeFile(resolved, content, "utf8");
  await refreshVfs();
  return statVfs(normalizedPath);
}

export async function renameVfsPath(path: string, nextPath: string) {
  const normalizedPath = assertEditableVfsPath(path);
  const normalizedNextPath = assertEditableVfsPath(nextPath);
  const sourceVirtual = resolveVirtualPhysicalPath(normalizedPath);
  const targetVirtual = resolveVirtualPhysicalPath(normalizedNextPath);
  const sourceResolved = sourceVirtual?.resolved ?? resolveVfsPath(normalizedPath);
  const targetResolved = targetVirtual?.resolved ?? resolveVfsPath(normalizedNextPath);
  await mkdir(dirname(targetResolved), { recursive: true });
  await rename(sourceResolved, targetResolved);
  await refreshVfs();
  return statVfs(normalizedNextPath);
}

export async function deleteVfsPath(path: string) {
  const normalizedPath = assertEditableVfsPath(path);
  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  await rm(resolved, { recursive: true, force: true });
  await refreshVfs();
  return { ok: true };
}
