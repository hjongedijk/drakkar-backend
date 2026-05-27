import { prisma } from "../repositories/db/prisma.js";

export function countEnabledUsenetServers() {
  return prisma.usenetServer.count({ where: { enabled: true } });
}

export function countEnabledRequestProviders() {
  return prisma.requestProvider.count({ where: { enabled: true } });
}

export function getSetupCompletedSetting() {
  return prisma.setting.findUnique({ where: { key: "setup.completed" } });
}

export function getFirstUsenetServer() {
  return prisma.usenetServer.findFirst({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
}

export function getFirstRequestProvider() {
  return prisma.requestProvider.findFirst({ orderBy: { createdAt: "asc" } });
}

export function findExistingUsenetServer(input: { name: string; host: string; port: number }) {
  return prisma.usenetServer.findFirst({
    where: {
      OR: [
        { name: input.name },
        { host: input.host, port: input.port }
      ]
    }
  });
}

export function updateUsenetServer(id: string, data: Parameters<typeof prisma.usenetServer.update>[0]["data"]) {
  return prisma.usenetServer.update({ where: { id }, data });
}

export function createUsenetServer(data: Parameters<typeof prisma.usenetServer.create>[0]["data"]) {
  return prisma.usenetServer.create({ data });
}

export function findExistingRequestProvider(input: { name: string; baseUrl: string }) {
  return prisma.requestProvider.findFirst({
    where: {
      OR: [
        { name: input.name },
        { baseUrl: input.baseUrl }
      ]
    }
  });
}

export function updateRequestProvider(id: string, data: Parameters<typeof prisma.requestProvider.update>[0]["data"]) {
  return prisma.requestProvider.update({ where: { id }, data });
}

export function createRequestProvider(data: Parameters<typeof prisma.requestProvider.create>[0]["data"]) {
  return prisma.requestProvider.create({ data });
}

export function markSetupCompleted() {
  return prisma.setting.upsert({
    where: { key: "setup.completed" },
    update: { value: true },
    create: { key: "setup.completed", value: true }
  });
}
