import { constants } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fuse, { type OPERATIONS, type Stats } from "@zkochan/fuse-native";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { listVfs, readVfsBytes, statVfs, type VfsNodeType } from "./vfsService.js";

let fuseInstance: Fuse | null = null;
let lastError: string | null = null;
let loggerRef: FastifyBaseLogger | null = null;
let nextFd = 10;

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
      loggerRef?.debug({ err: error }, "native FUSE operation failed");
      process.nextTick(onError, errorToFuseCode(error, fallbackCode));
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
        () => statVfs(path),
        (node) => callback(0, toFuseStats(node)),
        (code) => callback(code)
      );
    },

    readdir(path, callback) {
      asyncFuse(
        async () => {
          const entries = await listVfs(path);
          return {
            names: entries.map((entry: Awaited<ReturnType<typeof listVfs>>[number]) => entry.name),
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
          const data = await readVfsBytes(handlePath, position, length, String(fd));
          data.copy(buffer, 0, 0, data.length);
          return data.length;
        },
        (bytesRead) => callback(bytesRead),
        (code) => callback(code)
      );
    },

    release(_path, fd, callback) {
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
    logger.info("FUSE mount disabled");
    return { enabled: false, mounted: false, path: env.FUSE_MOUNT_PATH };
  }
  if (fuseInstance) return getFuseMountStatus();

  try {
    const mountPath = env.FUSE_MOUNT_PATH;
    await prepareMountPath(mountPath, logger);
    const instance = new Fuse(mountPath, fuseOperations(), {
      debug: env.FUSE_DEBUG,
      allowOther: env.FUSE_ALLOW_OTHER,
      defaultPermissions: true as never,
      entryTimeout: 1,
      attrTimeout: 1,
      acAttrTimeout: 1,
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
  if (!fuseInstance) return;
  const active = fuseInstance;
  fuseInstance = null;
  fileHandles.clear();
  await new Promise<void>((resolve) => {
    active.unmount((error: Error | null) => {
      if (error) logger.warn({ err: error, mountPath: env.FUSE_MOUNT_PATH }, "native FUSE unmount failed");
      resolve();
    });
  });
  logger.info({ mountPath: env.FUSE_MOUNT_PATH }, "native TypeScript FUSE mount stopped");
}

export function getFuseMountStatus() {
  return {
    enabled: env.FUSE_MOUNT_ENABLED,
    mounted: Boolean(fuseInstance),
    path: env.FUSE_MOUNT_PATH,
    error: lastError
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
  for (const command of ["fusermount", "fusermount3"]) {
    try {
      await execFileAsync(command, ["-uz", mountPath]);
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
