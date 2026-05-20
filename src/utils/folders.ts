import { access, mkdir, realpath } from "node:fs/promises";
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

export async function validateRequiredFolders(logger: FastifyBaseLogger): Promise<string[]> {
  const resolvedPaths: string[] = [];

  for (const directory of requiredDirectories) {
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

  logger.info({ directories: resolvedPaths }, "required folders are ready");
  return resolvedPaths;
}
