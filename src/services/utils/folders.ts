import { access, lstat, mkdir, readdir, realpath, rmdir, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import { env, requiredDirectories } from "../config/env.js";

const execFileAsync = promisify(execFile);

function isStaleFuseMountError(error: unknown) {
  return error instanceof Error && /ENOTCONN|Transport endpoint is not connected|socket is not connected/i.test(error.message);
}

async function unmountStaleFuse(mountPath: string, logger: FastifyBaseLogger) {
  for (const command of ["fusermount", "fusermount3", "umount"]) {
    try {
      const args = command === "umount" ? ["-l", mountPath] : ["-uz", mountPath];
      await execFileAsync(command, args);
      logger.info({ mountPath, command }, "stale FUSE mount detached during folder validation");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ENOENT|not mounted|no mount point|not found|Invalid argument/i.test(message)) {
        logger.debug({ err: error, mountPath, command }, "stale FUSE cleanup skipped during folder validation");
      }
    }
  }
}

async function ensureLegacyMountAlias(logger: FastifyBaseLogger) {
  if (env.FUSE_MOUNT_ENABLED || env.FUSE_MOUNT_PATH === "/mnt/fuse") return;
  const legacyPath = "/mnt/fuse";
  try {
    const existing = await lstat(legacyPath).catch(() => null);
    if (!existing) {
      await symlink(env.FUSE_MOUNT_PATH, legacyPath);
      logger.info({ legacyPath, targetPath: env.FUSE_MOUNT_PATH }, "legacy mount alias ready");
      return;
    }
    if (existing.isSymbolicLink()) return;
    if (existing.isDirectory()) {
      const entries = await readdir(legacyPath).catch(() => ["busy"]);
      if (entries.length === 0) {
        await rmdir(legacyPath);
        await symlink(env.FUSE_MOUNT_PATH, legacyPath);
        logger.info({ legacyPath, targetPath: env.FUSE_MOUNT_PATH }, "legacy mount alias ready");
      }
      return;
    }
  } catch (error) {
    logger.debug({ err: error, legacyPath, targetPath: env.FUSE_MOUNT_PATH }, "legacy mount alias skipped");
  }
}

export async function validateRequiredFolders(logger: FastifyBaseLogger): Promise<string[]> {
  const resolvedPaths: string[] = [];

  for (const directory of requiredDirectories) {
    if (directory === env.FUSE_MOUNT_PATH && !env.FUSE_MOUNT_ENABLED) continue;
    try {
      await mkdir(directory, { recursive: true });
      await access(directory, constants.R_OK | constants.W_OK);
    } catch (error) {
      if (directory === env.FUSE_MOUNT_PATH && isStaleFuseMountError(error)) {
        await unmountStaleFuse(directory, logger);
        await mkdir(directory, { recursive: true });
        await access(directory, constants.R_OK | constants.W_OK);
      } else {
        throw error;
      }
    }
    resolvedPaths.push(await realpath(directory));
  }

  await ensureLegacyMountAlias(logger);
  logger.info({ count: resolvedPaths.length }, "required folders are ready");
  return resolvedPaths;
}
