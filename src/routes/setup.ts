import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { getSettings } from "../settings/settingsStore.js";

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/setup/status", async () => {
    const [settings, usenetServers, requestProviders, setupRow] = await Promise.all([
      getSettings(),
      prisma.usenetServer.count({ where: { enabled: true } }),
      prisma.requestProvider.count({ where: { enabled: true } }),
      prisma.setting.findUnique({ where: { key: "setup.completed" } })
    ]);
    const checks = {
      nzbhydra: Boolean(settings.nzbhydraUrl && settings.nzbhydraApiKey),
      metadata: Boolean(settings.tmdbApiKey || settings.tvdbApiKey),
      requestProvider: requestProviders > 0,
      usenet: usenetServers > 0,
      plex: Boolean(settings.plexServerUrl && settings.plexToken)
    };
    return {
      completed: Boolean(setupRow?.value) || Object.values(checks).every(Boolean),
      checks
    };
  });

  app.post("/api/setup/complete", async () => {
    await prisma.setting.upsert({
      where: { key: "setup.completed" },
      update: { value: true },
      create: { key: "setup.completed", value: true }
    });
    return { ok: true };
  });
}
