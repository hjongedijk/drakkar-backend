import { prisma, Prisma } from "../../repositories/db/prisma.js";

export function isMissingDownloadRecordError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

export async function safeUpdateDownload(downloadId: string, data: Parameters<typeof prisma.download.update>[0]["data"]) {
  try {
    await prisma.download.update({
      where: { id: downloadId },
      data
    });
    return true;
  } catch (error) {
    if (isMissingDownloadRecordError(error)) return false;
    throw error;
  }
}
