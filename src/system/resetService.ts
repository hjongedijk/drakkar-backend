import { mkdir, rm } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { refreshMediaLibrary } from "../media-library/libraryService.js";

const RESET_DIRECTORIES = [
  env.VFS_DOWNLOADS_DIR,
  env.VFS_COMPLETED_DIR,
  env.VFS_NZB_DIR,
  env.NZB_BACKUPS_DIR,
  env.VFS_TMP_DIR,
  env.VFS_FAILED_DIR,
  env.MEDIA_MOVIES_DIR,
  env.MEDIA_TV_DIR
] as const;

export async function resetEnvironment() {
  for (const path of RESET_DIRECTORIES) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(path, { recursive: true });
  }

  await prisma.$transaction([
    prisma.blocklistItem.deleteMany({}),
    prisma.failedRelease.deleteMany({}),
    prisma.repairJob.deleteMany({}),
    prisma.symlink.deleteMany({}),
    prisma.importItem.deleteMany({}),
    prisma.mediaLibraryItem.deleteMany({}),
    prisma.download.deleteMany({}),
    prisma.vfsMount.deleteMany({}),
    prisma.nzbSegment.deleteMany({}),
    prisma.nzbFile.deleteMany({}),
    prisma.nzbDocument.deleteMany({}),
    prisma.mediaRequest.updateMany({
      data: {
        downloadId: null,
        selectedRelease: Prisma.JsonNull,
        status: "approved"
      }
    })
  ]);

  await refreshMediaLibrary();

  return {
    ok: true,
    cleared: {
      blocklist: true,
      downloads: true,
      imports: true,
      library: true,
      symlinks: true,
      mediaDirectories: [...RESET_DIRECTORIES]
    }
  };
}
