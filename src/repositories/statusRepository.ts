import { prisma } from "../repositories/db/prisma.js";

export function groupActiveDownloadStatuses() {
  return prisma.download.groupBy({
    by: ["status"],
    where: {
      status: {
        in: ["queued", "fetching_nzb", "verifying", "downloading", "prepared", "waiting_for_provider", "waiting_for_nzb", "paused"]
      }
    },
    _count: { status: true }
  });
}

export function listEnabledRequestProviderIds() {
  return prisma.requestProvider.findMany({ where: { enabled: true }, select: { id: true } });
}

export function countEnabledUsenetProviders() {
  return prisma.usenetServer.count({ where: { enabled: true } });
}

export function groupDownloadsByStatus() {
  return prisma.download.groupBy({ by: ["status"], _count: { status: true } });
}

export function listEnabledUsenetProviderDebugRows() {
  return prisma.usenetServer.findMany({
    where: { enabled: true },
    orderBy: [{ isBackup: "asc" }, { priority: "asc" }],
    select: {
      id: true,
      name: true,
      host: true,
      port: true,
      connections: true,
      priority: true,
      enabled: true,
      isBackup: true
    }
  });
}
