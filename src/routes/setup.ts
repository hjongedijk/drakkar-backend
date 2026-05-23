import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { countAdminUsers, createInitialAdminUser } from "../auth/service.js";
import { prisma } from "../db/prisma.js";
import { getSettings } from "../settings/settingsStore.js";

export async function getSetupStatus() {
  const [settings, usenetServers, requestProviders, setupRow, adminUsers] = await Promise.all([
    getSettings(),
    prisma.usenetServer.count({ where: { enabled: true } }),
    prisma.requestProvider.count({ where: { enabled: true } }),
    prisma.setting.findUnique({ where: { key: "setup.completed" } }),
    countAdminUsers()
  ]);
  const checks = {
    admin: adminUsers > 0,
    nzbhydra: Boolean(settings.nzbhydraUrl && settings.nzbhydraApiKey),
    metadata: Boolean(settings.tmdbApiKey || settings.tvdbApiKey),
    requestProvider: requestProviders > 0,
    usenet: usenetServers > 0,
    plex: Boolean(settings.plexServerUrl && settings.plexToken)
  };
  return {
    completed: Boolean(setupRow?.value) && checks.admin,
    adminRequired: !checks.admin,
    checks
  };
}

const completeSetupSchema = z.object({
  admin: z.object({
    username: z.string().trim().min(1),
    displayName: z.string().trim().optional(),
    password: z.string().min(8)
  }).optional()
});

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/setup/status", async () => {
    return getSetupStatus();
  });

  app.post("/api/setup/complete", async (request) => {
    const input = completeSetupSchema.parse(request.body ?? {});
    const adminUsers = await countAdminUsers();
    if (adminUsers === 0) {
      if (!input.admin) throw new Error("admin user is required");
      await createInitialAdminUser(input.admin);
    }
    await prisma.setting.upsert({
      where: { key: "setup.completed" },
      update: { value: true },
      create: { key: "setup.completed", value: true }
    });
    return { ok: true };
  });
}
