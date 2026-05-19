import { access, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import type { FastifyBaseLogger } from "fastify";
import { requiredDirectories } from "../config/env.js";

export async function validateRequiredFolders(logger: FastifyBaseLogger): Promise<string[]> {
  const resolvedPaths: string[] = [];

  for (const directory of requiredDirectories) {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.R_OK | constants.W_OK);
    resolvedPaths.push(await realpath(directory));
  }

  logger.info({ directories: resolvedPaths }, "required folders are ready");
  return resolvedPaths;
}
