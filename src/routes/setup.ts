import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { countAdminUsers, createInitialAdminUser } from "../auth/service.js";
import { prisma } from "../db/prisma.js";
import { getSettings, updateSettings } from "../settings/settingsStore.js";

export async function getSetupStatus() {
  const [settings, usenetServers, requestProviders, setupRow, adminUsers, firstUsenet, firstRequestProvider] = await Promise.all([
    getSettings(),
    prisma.usenetServer.count({ where: { enabled: true } }),
    prisma.requestProvider.count({ where: { enabled: true } }),
    prisma.setting.findUnique({ where: { key: "setup.completed" } }),
    countAdminUsers(),
    prisma.usenetServer.findFirst({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }] }),
    prisma.requestProvider.findFirst({ orderBy: { createdAt: "asc" } })
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
    checks,
    prefill: {
      nzbhydraUrl: settings.nzbhydraUrl ?? "",
      nzbhydraApiKey: settings.nzbhydraApiKey ?? "",
      tmdbApiKey: settings.tmdbApiKey ?? "",
      tvdbApiKey: settings.tvdbApiKey ?? "",
      plexServerUrl: settings.plexServerUrl ?? "",
      plexToken: settings.plexToken ?? "",
      plexLibraryPath: settings.plexLibraryPath ?? "/mnt/media",
      plexSectionId: settings.plexSectionId ?? "",
      usenet: firstUsenet ? {
        name: firstUsenet.name,
        host: firstUsenet.host,
        port: firstUsenet.port,
        ssl: firstUsenet.ssl,
        username: firstUsenet.username ?? "",
        password: firstUsenet.password ?? "",
        connections: firstUsenet.connections,
        priority: firstUsenet.priority,
        enabled: firstUsenet.enabled,
        isBackup: firstUsenet.isBackup
      } : null,
      requestProvider: firstRequestProvider ? {
        name: firstRequestProvider.name,
        baseUrl: firstRequestProvider.baseUrl,
        apiKey: firstRequestProvider.apiKey,
        enabled: firstRequestProvider.enabled,
        syncIntervalMinutes: firstRequestProvider.syncIntervalMinutes,
        defaultMovieProfile: firstRequestProvider.defaultMovieProfile ?? "",
        defaultTvProfile: firstRequestProvider.defaultTvProfile ?? ""
      } : null
    }
  };
}

const completeSetupSchema = z.object({
  admin: z.object({
    username: z.string().trim().min(1),
    displayName: z.string().trim().optional(),
    password: z.string().min(8)
  }).optional(),
  settings: z.object({
    nzbhydraUrl: z.string().trim().optional(),
    nzbhydraApiKey: z.string().trim().optional(),
    tmdbApiKey: z.string().trim().optional(),
    tvdbApiKey: z.string().trim().optional(),
    plexServerUrl: z.string().trim().optional(),
    plexToken: z.string().trim().optional(),
    plexLibraryPath: z.string().trim().optional(),
    plexSectionId: z.string().trim().optional()
  }).optional(),
  usenet: z.object({
    name: z.string().trim().min(1),
    host: z.string().trim().min(1),
    port: z.number().int().positive().default(563),
    ssl: z.boolean().default(true),
    username: z.string().trim().optional(),
    password: z.string().trim().optional(),
    connections: z.number().int().positive().default(10),
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
    isBackup: z.boolean().default(false)
  }).optional(),
  requestProvider: z.object({
    name: z.string().trim().min(1),
    baseUrl: z.string().trim().min(1),
    apiKey: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    syncIntervalMinutes: z.number().int().positive().default(15),
    defaultMovieProfile: z.string().trim().optional(),
    defaultTvProfile: z.string().trim().optional()
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
    if (input.settings) {
      const current = await getSettings();
      await updateSettings({
        ...current,
        ...(input.settings.nzbhydraUrl ? { nzbhydraUrl: input.settings.nzbhydraUrl } : {}),
        ...(input.settings.nzbhydraApiKey ? { nzbhydraApiKey: input.settings.nzbhydraApiKey } : {}),
        ...(input.settings.tmdbApiKey ? { tmdbApiKey: input.settings.tmdbApiKey } : {}),
        ...(input.settings.tvdbApiKey ? { tvdbApiKey: input.settings.tvdbApiKey } : {}),
        ...(input.settings.plexServerUrl ? { plexServerUrl: input.settings.plexServerUrl } : {}),
        ...(input.settings.plexToken ? { plexToken: input.settings.plexToken } : {}),
        ...(input.settings.plexLibraryPath ? { plexLibraryPath: input.settings.plexLibraryPath } : {}),
        ...(input.settings.plexSectionId ? { plexSectionId: input.settings.plexSectionId } : {})
      });
    }
    if (input.usenet) {
      const existing = await prisma.usenetServer.findFirst({
        where: {
          OR: [
            { name: input.usenet.name },
            { host: input.usenet.host, port: input.usenet.port }
          ]
        }
      });
      const data = {
        ...input.usenet,
        username: input.usenet.username || null,
        password: input.usenet.password || null
      };
      if (existing) await prisma.usenetServer.update({ where: { id: existing.id }, data });
      else await prisma.usenetServer.create({ data });
    }
    if (input.requestProvider) {
      const existing = await prisma.requestProvider.findFirst({
        where: {
          OR: [
            { name: input.requestProvider.name },
            { baseUrl: input.requestProvider.baseUrl }
          ]
        }
      });
      const data = {
        type: "seerr" as const,
        ...input.requestProvider
      };
      if (existing) await prisma.requestProvider.update({ where: { id: existing.id }, data });
      else await prisma.requestProvider.create({ data });
    }
    await prisma.setting.upsert({
      where: { key: "setup.completed" },
      update: { value: true },
      create: { key: "setup.completed", value: true }
    });
    return { ok: true, status: await getSetupStatus() };
  });
}
