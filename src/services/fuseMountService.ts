import { constants } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fuse, { type OPERATIONS, type Stats } from "@zkochan/fuse-native";
import type { FastifyBaseLogger } from "fastify";
import { LocalTtlCache } from "../services/cache/localTtlCache.js";
import { env } from "../services/config/env.js";
import { getPolicySettings } from "../services/policyService.js";
import { closeMountedReadSession } from "../services/mountedStream.service.js";
import { listVfs, readVfsBytes, statVfs, type VfsNodeType } from "./vfsService.js";

let fuseInstance: Fuse | null = null;
let lastError: string | null = null;
let loggerRef: FastifyBaseLogger | null = null;
let nextFd = 10;
const FUSE_METADATA_CACHE_SECONDS = 45;
const FUSE_LOCAL_STAT_CACHE_MS = 8_000;
const FUSE_LOCAL_READDIR_CACHE_MS = 8_000;
const fuseStatCache = new LocalTtlCache<StatLikeNode>();
const fuseReaddirCache = new LocalTtlCache<{ names: string[]; stats: Stats[] }>();

const execFileAsync = promisify(execFile);
const fileHandles = new Map<number, string>();

type StatLikeNode = {
  path: string;
  type: VfsNodeType | "folder" | string;
  size?: number | null;
  modifiedAt?: string;
  isDirectory?: boolean;
};

function modeForNode(node: StatLikeNode) {
  const isDirectory = Boolean(node.isDirectory) || node.type === "folder" || node.type === "virtual-release";
  return (isDirectory ? constants.S_IFDIR | 0o755 : constants.S_IFREG | 0o444);
}

function inodeForPath(path: string) {
  let hash = 2166136261;
  for (const char of path) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) || 1;
}

function basenameForFusePath(path: string) {
  const trimmed = path.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return "";
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

function toFuseStats(node: StatLikeNode): Stats {
  const isDirectory = Boolean(node.isDirectory) || node.type === "folder" || node.type === "virtual-release";
  const size = isDirectory ? 0 : Number(node.size ?? 0);
  const modified = node.modifiedAt ? new Date(node.modifiedAt) : new Date();
  return {
    mode: modeForNode(node),
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    size,
    dev: 0,
    nlink: isDirectory ? 2 : 1,
    ino: inodeForPath(node.path),
    rdev: 0,
    blksize: 4096,
    blocks: 0,
    atime: modified,
    mtime: modified,
    ctime: modified
  };
}

function asyncFuse<T>(
  task: () => Promise<T>,
  onSuccess: (value: T) => void,
  onError: (errorCode: number) => void,
  fallbackCode = Fuse.EIO
) {
  void task()
    .then((value) => process.nextTick(onSuccess, value))
    .catch((error) => {
      const code = errorToFuseCode(error, fallbackCode);
      if (code !== Fuse.ENOENT) loggerRef?.debug({ err: error }, "native FUSE operation failed");
      process.nextTick(onError, code);
    });
}

function errorToFuseCode(error: unknown, fallbackCode: number) {
  if (error instanceof Error && /ENOENT|not found|no such file/i.test(error.message)) return Fuse.ENOENT;
  if (error instanceof Error && /EISDIR|directory/i.test(error.message)) return Fuse.EISDIR;
  return fallbackCode;
}

function fuseOperations(): OPERATIONS {
  return {
    getattr(path, callback) {
      asyncFuse(
        async () => {
          const cached = fuseStatCache.get(path);
          if (cached) return cached;
          return fuseStatCache.set(path, await statVfs(path), FUSE_LOCAL_STAT_CACHE_MS);
        },
        (node) => callback(0, toFuseStats(node)),
        (code) => callback(code)
      );
    },

    readdir(path, callback) {
      asyncFuse(
        async () => {
          const cached = fuseReaddirCache.get(path);
          if (cached) return cached;
          const entries = await listVfs(path);
          const result = {
            // FUSE must return stable directory entry names that round-trip through getattr/open.
            names: entries.map((entry: Awaited<ReturnType<typeof listVfs>>[number]) => basenameForFusePath(entry.path) || entry.name),
            stats: entries.map((entry: Awaited<ReturnType<typeof listVfs>>[number]) =>
              toFuseStats({
                path: entry.path,
                type: entry.type,
                size: entry.size,
                modifiedAt: entry.modifiedAt,
                isDirectory: entry.type === "folder" || entry.type === "virtual-release"
              })
            )
          };
          return fuseReaddirCache.set(path, result, FUSE_LOCAL_READDIR_CACHE_MS);
        },
        ({ names, stats }) => callback(0, names, stats),
        (code) => callback(code)
      );
    },

    open(path, flags, callback) {
      const readOnly = (flags & 3) === constants.O_RDONLY;
      if (!readOnly) return process.nextTick(callback, Fuse.EROFS);
      asyncFuse(
        async () => {
          const node = await statVfs(path);
          if (node.isDirectory) throw new Error("EISDIR");
          const fd = nextFd++;
          fileHandles.set(fd, path);
          return fd;
        },
        (fd) => callback(0, fd),
        (code) => callback(code)
      );
    },

    read(path, fd, buffer, length, position, callback) {
      asyncFuse(
        async () => {
          const handlePath = fileHandles.get(fd) ?? path;
          const policies = await getPolicySettings();
          const maxReadLength = Math.max(512 * 1024, Math.min(policies.streamChunkSizeBytes, 4 * 1024 * 1024));
          const targetLength = Math.min(length, maxReadLength);
          let total = 0;
          while (total < targetLength) {
            const data = await readVfsBytes(handlePath, position + total, targetLength - total, String(fd));
            if (!data.length) break;
            data.copy(buffer, total, 0, data.length);
            total += data.length;
          }
          return total;
        },
        (bytesRead) => callback(bytesRead),
        (code) => callback(code)
      );
    },

    release(_path, fd, callback) {
      closeMountedReadSession(String(fd));
      fileHandles.delete(fd);
      process.nextTick(callback, 0);
    },

    statfs(_path, callback) {
      process.nextTick(callback, 0, {
        bsize: 4096,
        frsize: 4096,
        blocks: 1024 * 1024,
        bfree: 1024 * 1024,
        bavail: 1024 * 1024,
        files: 1024 * 1024,
        ffree: 1024 * 1024,
        favail: 1024 * 1024,
        fsid: 0,
        flag: 0,
        namemax: 255
      });
    }
  };
}

export async function startFuseMount(logger: FastifyBaseLogger) {
  loggerRef = logger;
  if (!env.FUSE_MOUNT_ENABLED) {
    logger.info("native mount disabled");
    return getFuseMountStatus();
  }
  if (fuseInstance) return getFuseMountStatus();

  try {
    const mountPath = env.FUSE_MOUNT_PATH;
    if (env.FUSE_FORCE_MOUNT) {
      await unmountStaleFuse(mountPath, logger);
    }
    await prepareMountPath(mountPath, logger);
    const instance = new Fuse(mountPath, fuseOperations(), {
      debug: env.FUSE_DEBUG,
      allowOther: env.FUSE_ALLOW_OTHER,
      defaultPermissions: true as never,
      // Short metadata caching absorbs Plex/Radarr repeat-stat bursts without hiding new imports for long.
      entryTimeout: FUSE_METADATA_CACHE_SECONDS,
      attrTimeout: FUSE_METADATA_CACHE_SECONDS,
      acAttrTimeout: FUSE_METADATA_CACHE_SECONDS,
      force: env.FUSE_FORCE_MOUNT,
      fsname: "drakkar"
    });

    await new Promise<void>((resolve, reject) => {
      instance.mount((error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    fuseInstance = instance;
    lastError = null;
    logger.info({ mountPath }, "native TypeScript FUSE mount ready");
    return { enabled: true, mounted: true, path: mountPath };
  } catch (error) {
    lastError = error instanceof Error ? error.message : "unknown";
    logger.warn({ err: error, mountPath: env.FUSE_MOUNT_PATH }, "native FUSE mount unavailable, continuing without it");
    fuseInstance = null;
    return { enabled: true, mounted: false, path: env.FUSE_MOUNT_PATH, error: lastError };
  }
}

export async function stopFuseMount(logger: FastifyBaseLogger) {
  const active = fuseInstance;
  fuseInstance = null;
  fileHandles.clear();
  fuseStatCache.clear();
  fuseReaddirCache.clear();
  if (active) {
    await new Promise<void>((resolve) => {
      active.unmount((error: Error | null) => {
        if (error) logger.warn({ err: error, mountPath: env.FUSE_MOUNT_PATH }, "native FUSE unmount failed");
        resolve();
      });
    });
  }
  if (env.FUSE_FORCE_MOUNT) {
    await unmountStaleFuse(env.FUSE_MOUNT_PATH, logger);
  }
  logger.info({ mountPath: env.FUSE_MOUNT_PATH }, "native TypeScript FUSE mount stopped");
}

export async function getFuseMountStatus() {
  const externalMounted = await probeExternalMount(env.FUSE_MOUNT_PATH);
  return {
    enabled: env.FUSE_MOUNT_ENABLED || externalMounted,
    mounted: Boolean(fuseInstance) || externalMounted,
    path: env.FUSE_MOUNT_PATH,
    error: externalMounted ? null : lastError
  };
}

async function prepareMountPath(mountPath: string, logger: FastifyBaseLogger) {
  try {
    await mkdir(mountPath, { recursive: true });
  } catch (error) {
    if (isStaleFuseMountError(error) && env.FUSE_FORCE_MOUNT) {
      await unmountStaleFuse(mountPath, logger);
      await mkdir(mountPath, { recursive: true });
    } else {
      throw error;
    }
  }
  try {
    const mountStat = await stat(mountPath);
    if (!mountStat.isDirectory()) throw new Error(`${mountPath} is not a directory`);
    if (mountStat.uid !== process.getuid?.()) {
      logger.warn({ mountPath, uid: mountStat.uid, processUid: process.getuid?.() }, "FUSE mount path is not owned by current user");
    }
  } catch (error) {
    if (isStaleFuseMountError(error) && env.FUSE_FORCE_MOUNT) {
      await unmountStaleFuse(mountPath, logger);
      await mkdir(mountPath, { recursive: true });
      return;
    }
    throw error;
  }

  if (env.FUSE_FORCE_MOUNT) {
    await unmountStaleFuse(mountPath, logger);
  }
}

function isStaleFuseMountError(error: unknown) {
  return error instanceof Error && /ENOTCONN|Transport endpoint is not connected/i.test(error.message);
}

async function unmountStaleFuse(mountPath: string, logger: FastifyBaseLogger) {
  for (const command of ["fusermount", "fusermount3", "umount"]) {
    try {
      const args = command === "umount" ? ["-l", mountPath] : ["-uz", mountPath];
      await execFileAsync(command, args);
      logger.info({ mountPath, command }, "stale FUSE mount detached");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ENOENT|not mounted|no mount point|not found|Invalid argument/i.test(message)) {
        logger.debug({ err: error, mountPath, command }, "FUSE pre-unmount skipped");
      }
    }
  }
}

async function probeExternalMount(mountPath: string) {
  try {
    await execFileAsync("mountpoint", ["-q", mountPath]);
    return true;
  } catch {
    return false;
  }
}
