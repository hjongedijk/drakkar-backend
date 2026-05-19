import { z } from "zod";
import { prisma } from "../db/prisma.js";

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

export function createUsenetServer(input: unknown) {
  return prisma.usenetServer.create({ data: usenetServerSchema.parse(input) });
}

export function updateUsenetServer(id: string, input: unknown) {
  return prisma.usenetServer.update({ where: { id }, data: usenetServerSchema.partial().parse(input) });
}

export function deleteUsenetServer(id: string) {
  return prisma.usenetServer.delete({ where: { id } });
}
