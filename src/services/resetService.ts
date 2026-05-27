import { mkdir, rm } from "node:fs/promises";
import { env } from "../services/config/env.js";
import { prisma, Prisma } from "../repositories/db/prisma.js";
import { refreshMediaLibrary } from "../services/libraryService.js";

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

  await prisma.$transaction(async (tx) => {
    await tx.blocklistItem.deleteMany({});
    await tx.failedRelease.deleteMany({});
    await tx.repairJob.deleteMany({});
    await tx.symlink.deleteMany({});
    await tx.importItem.deleteMany({});
    await tx.mediaLibraryItem.deleteMany({});
    await tx.download.deleteMany({});
    await tx.vfsMount.deleteMany({});
    await tx.nzbSegment.deleteMany({});
    await tx.nzbFile.deleteMany({});
    await tx.nzbDocument.deleteMany({});
    await tx.mediaRequest.updateMany({
      data: {
        downloadId: null,
        selectedRelease: Prisma.JsonNull,
        status: "approved"
      }
    });
  });

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
