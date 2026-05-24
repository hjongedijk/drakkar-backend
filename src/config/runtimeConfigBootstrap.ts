import { ensureRuntimeSettings } from "./runtimeSettings.js";
import { prisma } from "../db/prisma.js";
import { getSettings, syncRuntimeSettingsFromDatabase, updateSettings } from "../settings/settingsStore.js";
import { countAdminUsers, createInitialAdminUser } from "../auth/service.js";

type Logger = { info: (input: unknown, msg?: string) => void; warn: (input: unknown, msg?: string) => void };

function hasValue(value?: string | null) {
  return Boolean(value && value.trim());
}

function runtimeHasCompleteSetup(runtime: ReturnType<typeof ensureRuntimeSettings>) {
  const hasUsenet = runtime.usenetProviders.some((item) => item.enabled && hasValue(item.name) && hasValue(item.host));
  const hasRequestProvider = runtime.requestProviders.some((item) => item.enabled && hasValue(item.name) && hasValue(item.baseUrl) && hasValue(item.apiKey));
  const hasNzbhydra = runtime.nzbhydra.enabled && hasValue(runtime.nzbhydra.url) && hasValue(runtime.nzbhydra.apiKey);
  const hasMetadata = hasValue(runtime.metadata.tmdbApiKey) || hasValue(runtime.metadata.tvdbApiKey);
  const hasPlex = runtime.plex.enabled && hasValue(runtime.plex.serverUrl) && hasValue(runtime.plex.token);
  return hasUsenet && hasRequestProvider && hasNzbhydra && hasMetadata && hasPlex;
}

export async function bootstrapRuntimeConfiguredServices(log: Logger) {
  const runtime = ensureRuntimeSettings();
  const current = await getSettings();
  const nzbhydra = runtime.nzbhydra.enabled && hasValue(runtime.nzbhydra.url) && hasValue(runtime.nzbhydra.apiKey)
    ? runtime.nzbhydra
    : runtime.indexers.find((item) => item.enabled && item.type.toLowerCase() === "nzbhydra2" && hasValue(item.url) && hasValue(item.apiKey));

  const nextSettings = {
    ...current,
    ...(nzbhydra ? {
      nzbhydraUrl: "url" in nzbhydra ? nzbhydra.url : "",
      nzbhydraApiKey: "apiKey" in nzbhydra ? nzbhydra.apiKey : "",
      nzbhydraCategories: "categories" in nzbhydra ? nzbhydra.categories : current.nzbhydraCategories,
      nzbhydraTimeoutMs: "timeoutMs" in nzbhydra ? nzbhydra.timeoutMs : current.nzbhydraTimeoutMs,
      nzbhydraCacheTtlSeconds: "searchCacheTtlSeconds" in nzbhydra ? nzbhydra.searchCacheTtlSeconds : current.nzbhydraCacheTtlSeconds,
      nzbhydraFeedCacheTtlSeconds: "feedCacheTtlSeconds" in nzbhydra ? nzbhydra.feedCacheTtlSeconds : current.nzbhydraFeedCacheTtlSeconds,
      nzbhydraFeedMaxResults: "feedMaxResults" in nzbhydra ? nzbhydra.feedMaxResults : current.nzbhydraFeedMaxResults
    } : {}),
    ...(runtime.plex.enabled && hasValue(runtime.plex.serverUrl) ? {
      plexServerUrl: runtime.plex.serverUrl,
      plexToken: runtime.plex.token,
      plexLibraryPath: runtime.plex.libraryPath,
      plexSectionId: runtime.plex.sectionId
    } : {}),
    ...(hasValue(runtime.metadata.tmdbApiKey) ? { tmdbApiKey: runtime.metadata.tmdbApiKey } : {}),
    ...(hasValue(runtime.metadata.tvdbApiKey) ? { tvdbApiKey: runtime.metadata.tvdbApiKey } : {}),
    metadataLanguage: runtime.metadata.language || current.metadataLanguage,
    metadataCacheTtlHours: runtime.metadata.cacheTtlHours || current.metadataCacheTtlHours
  };
  await updateSettings(nextSettings);

  let usenetSynced = 0;
  for (const server of runtime.usenetProviders.filter((item) => item.enabled && hasValue(item.name) && hasValue(item.host))) {
    const existing = await prisma.usenetServer.findFirst({ where: { OR: [{ name: server.name }, { host: server.host, port: server.port }] } });
    const data = {
      name: server.name,
      host: server.host,
      port: server.port,
      ssl: server.ssl,
      username: server.username || null,
      password: server.password || null,
      connections: server.connections,
      priority: server.priority,
      enabled: server.enabled,
      isBackup: server.isBackup,
      retentionDays: server.retentionDays ?? null
    };
    if (existing) await prisma.usenetServer.update({ where: { id: existing.id }, data });
    else await prisma.usenetServer.create({ data });
    usenetSynced += 1;
  }

  let requestProvidersSynced = 0;
  for (const provider of runtime.requestProviders.filter((item) => item.enabled && hasValue(item.baseUrl) && hasValue(item.apiKey))) {
    const existing = await prisma.requestProvider.findFirst({ where: { OR: [{ name: provider.name }, { baseUrl: provider.baseUrl }] } });
    const data = {
      type: provider.type,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      enabled: provider.enabled,
      syncIntervalMinutes: provider.syncIntervalMinutes,
      defaultMovieProfile: provider.defaultMovieProfile || current.defaultMovieProfile,
      defaultTvProfile: provider.defaultTvProfile || current.defaultTvProfile
    };
    if (existing) await prisma.requestProvider.update({ where: { id: existing.id }, data });
    else await prisma.requestProvider.create({ data });
    requestProvidersSynced += 1;
  }

  const setupCompletedRow = await prisma.setting.findUnique({ where: { key: "setup.completed" } });
  const adminUsers = await countAdminUsers();
  if (!setupCompletedRow?.value && adminUsers === 0 && runtimeHasCompleteSetup(runtime)) {
    await createInitialAdminUser({
      username: "admin",
      displayName: "admin",
      password: "password1234",
      mustChangePassword: true
    });
    await prisma.setting.upsert({
      where: { key: "setup.completed" },
      update: { value: true },
      create: { key: "setup.completed", value: true }
    });
    log.warn({ username: "admin" }, "default admin created from settings.json; change password on first login");
  }

  await syncRuntimeSettingsFromDatabase();
  log.info({ settingsFile: true, usenetProviders: usenetSynced, requestProviders: requestProvidersSynced, nzbhydra: Boolean(nzbhydra) }, "runtime settings.json synced");
}
