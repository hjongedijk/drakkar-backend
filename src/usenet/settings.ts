import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { invalidatePolicyCache } from "../policies/policyService.js";
import { syncRuntimeSettingsFromDatabase } from "../settings/settingsStore.js";

let usenetRuntimeVersion = 0;

export const usenetServerSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  ssl: z.boolean().default(true),
  username: z.string().optional(),
  password: z.string().optional(),
  connections: z.number().int().positive().default(10),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  isBackup: z.boolean().default(false),
  retentionDays: z.number().int().positive().optional()
});

export function listUsenetServers() {
  return prisma.usenetServer.findMany({ orderBy: [{ priority: "asc" }, { name: "asc" }] });
}

export function getUsenetRuntimeVersion() {
  return usenetRuntimeVersion;
}

function bumpUsenetRuntimeVersion() {
  usenetRuntimeVersion += 1;
}

export async function createUsenetServer(input: unknown) {
  invalidatePolicyCache();
  bumpUsenetRuntimeVersion();
  const server = await prisma.usenetServer.create({ data: usenetServerSchema.parse(input) });
  await syncRuntimeSettingsFromDatabase();
  return server;
}

export async function updateUsenetServer(id: string, input: unknown) {
  invalidatePolicyCache();
  bumpUsenetRuntimeVersion();
  const server = await prisma.usenetServer.update({ where: { id }, data: usenetServerSchema.partial().parse(input) });
  await syncRuntimeSettingsFromDatabase();
  return server;
}

export async function deleteUsenetServer(id: string) {
  invalidatePolicyCache();
  bumpUsenetRuntimeVersion();
  const server = await prisma.usenetServer.delete({ where: { id } });
  await syncRuntimeSettingsFromDatabase();
  return server;
}
