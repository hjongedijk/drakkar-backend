import { prisma } from "../repositories/db/prisma.js";

export function pingDatabase() {
  return prisma.$queryRaw`SELECT 1`;
}

export function listRecentImportsForHealth() {
  return prisma.importItem.findMany({
    include: {
      symlinks: { orderBy: { updatedAt: "desc" }, take: 1 }
    },
    orderBy: { createdAt: "desc" }
  });
}

export function listAvailableDownloadsForHealth() {
  return prisma.download.findMany({
    where: {
      status: { in: ["available", "completed"] }
    },
    include: {
      imports: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          symlinks: { orderBy: { updatedAt: "desc" }, take: 1 }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });
}

export function listRecentRepairJobs() {
  return prisma.repairJob.findMany({
    orderBy: { createdAt: "desc" }
  });
}
