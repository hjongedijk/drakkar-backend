import { createReadStream } from "node:fs";
import { open, readdir, stat, lstat, readlink } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { env } from "../config/env.js";
import { redis } from "../db/redis.js";
import { getIgnoredPatterns, matchesIgnoredPattern } from "../policies/policyService.js";
import { readMountedFileRange, streamMountedFile } from "../streaming/mountedStream.service.js";
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

const rootFolders = [
  { name: "downloads", path: "/downloads", target: env.VFS_DOWNLOADS_DIR },
  { name: "completed", path: "/completed", target: env.VFS_COMPLETED_DIR },
  { name: "nzb", path: "/nzb", target: env.VFS_NZB_DIR },
  { name: "media", path: "/media", target: null },
  { name: "releases", path: "/mounted/releases", target: null }
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
  if (parts[0] === "completed") return { root: env.VFS_COMPLETED_DIR, subPath: parts.slice(1).join("/"), virtualRoot: "/completed" };
  if (parts[0] === "nzb") return { root: env.VFS_NZB_DIR, subPath: parts.slice(1).join("/"), virtualRoot: "/nzb" };
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
  if (!linkTarget?.startsWith(env.FUSE_MOUNT_PATH)) return null;
  return normalize(`/${linkTarget.slice(env.FUSE_MOUNT_PATH.length)}`).replace(/\/+$/, "") || "/";
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
  if (!showHidden) {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  if (normalizedPath === "/") return rootFolders.map((folder) => virtualFolderNode(folder.name, folder.path));
  if (normalizedPath === "/media") return mediaFolders.map((folder) => virtualFolderNode(folder.name, folder.path));
  if (normalizedPath === "/mounted") return [virtualFolderNode("releases", "/mounted/releases")];
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
  await redis.set(cacheKey, JSON.stringify(sorted), "EX", 30);
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
  if (normalizedPath === "/" || normalizedPath === "/mounted" || normalizedPath === "/media") {
    return { path: normalizedPath, type: "folder", size: 0, modifiedAt: new Date().toISOString(), isDirectory: true };
  }
  if (normalizedPath === "/mounted/releases" || normalizedPath.startsWith("/mounted/releases/") || isMountedPath(normalizedPath)) return statMountedPath(normalizedPath);

  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  const linkStats = await lstat(resolved);
  if (linkStats.isSymbolicLink()) {
    const mountedTarget = await mountedTargetForSymlink(resolved);
    if (mountedTarget) return statMountedPath(mountedTarget);
  }
  const stats = linkStats.isSymbolicLink() ? await stat(resolved) : linkStats;
  return {
    path: normalizedPath,
    type: nodeType(normalizedPath, stats.isDirectory(), linkStats.isSymbolicLink()),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    isDirectory: stats.isDirectory()
  };
}

export async function streamVfsFile(path: string, range?: string) {
  const normalizedPath = normalize(`/${path}`).replace(/\/+$/, "") || "/";
  if (normalizedPath === "/mounted/releases" || normalizedPath.startsWith("/mounted/releases/") || isMountedPath(normalizedPath)) {
    return streamMountedFile(normalizedPath, range, { source: "http" });
  }

  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  const linkStats = await lstat(resolved);
  if (linkStats.isSymbolicLink()) {
    const mountedTarget = await mountedTargetForSymlink(resolved);
    if (mountedTarget) return streamMountedFile(mountedTarget, range, { source: "http" });
  }
  const stats = linkStats.isSymbolicLink() ? await stat(resolved) : linkStats;
  if (stats.isDirectory()) throw new Error("cannot stream a directory");

  if (!range) {
    return { stream: createReadStream(resolved), start: 0, end: stats.size - 1, size: stats.size, partial: false };
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : stats.size - 1;
  return {
    stream: createReadStream(resolved, { start, end }),
    start,
    end,
    size: stats.size,
    partial: true
  };
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
  if (normalizedPath === "/mounted/releases" || normalizedPath.startsWith("/mounted/releases/") || isMountedPath(normalizedPath)) {
    return readMountedFileRange({ path: normalizedPath, start, length, sessionId, source: "fuse" });
  }

  const virtual = resolveVirtualPhysicalPath(normalizedPath);
  const resolved = virtual?.resolved ?? resolveVfsPath(normalizedPath);
  const linkStats = await lstat(resolved);
  if (linkStats.isSymbolicLink()) {
    const mountedTarget = await mountedTargetForSymlink(resolved);
    if (mountedTarget) return readMountedFileRange({ path: mountedTarget, start, length, sessionId, source: "fuse" });
  }
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
  const keys = await redis.keys("vfs:list:*");
  if (keys.length > 0) await redis.del(...keys);
  await redis.set("vfs:last-refresh", new Date().toISOString());
  return { ok: true };
}
