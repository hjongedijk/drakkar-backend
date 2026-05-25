import { ensureRuntimeSettings } from "./runtimeSettings.js";
import { prisma } from "../db/prisma.js";
import { getSettings, syncRuntimeSettingsFromDatabase, updateSettings } from "../settings/settingsStore.js";
import { countAdminUsers, createInitialAdminUser } from "../auth/service.js";

type Logger = { info: (input: unknown, msg?: string) => void; warn: (input: unknown, msg?: string) => void };

function hasValue(value?: string | null) {
  return Boolean(value && value.trim());
}

function hasConfiguredValue(value?: string | null) {
  if (!hasValue(value)) return false;
  return value!.trim().toLowerCase() !== "fill-me";
}

function runtimeHasCompleteSetup(runtime: ReturnType<typeof ensureRuntimeSettings>) {
  const hasUsenet = runtime.usenetProviders.some((item) => item.enabled && hasConfiguredValue(item.name) && hasConfiguredValue(item.host));
  const hasRequestProvider = runtime.requestProviders.some((item) => item.enabled && hasConfiguredValue(item.name) && hasConfiguredValue(item.baseUrl) && hasConfiguredValue(item.apiKey));
  const hasNzbhydra = runtime.nzbhydra.enabled && hasConfiguredValue(runtime.nzbhydra.url) && hasConfiguredValue(runtime.nzbhydra.apiKey);
  const hasMetadata = hasConfiguredValue(runtime.metadata.tmdbApiKey) || hasConfiguredValue(runtime.metadata.tvdbApiKey);
  const hasPlex = runtime.plex.enabled && hasConfiguredValue(runtime.plex.serverUrl) && hasConfiguredValue(runtime.plex.token);
  return hasUsenet && hasRequestProvider && hasNzbhydra && hasMetadata && hasPlex;
}

export async function bootstrapRuntimeConfiguredServices(log: Logger) {
  const runtime = ensureRuntimeSettings();
  const current = await getSettings();
  const nzbhydra = runtime.nzbhydra.enabled && hasConfiguredValue(runtime.nzbhydra.url) && hasConfiguredValue(runtime.nzbhydra.apiKey)
    ? runtime.nzbhydra
    : undefined;

  const nextSettings = {
    ...current,
    nzbhydraUrl: nzbhydra ? ("url" in nzbhydra ? nzbhydra.url : "") : "",
    nzbhydraApiKey: nzbhydra ? ("apiKey" in nzbhydra ? nzbhydra.apiKey : "") : "",
    nzbhydraCategories: nzbhydra && "categories" in nzbhydra ? nzbhydra.categories : current.nzbhydraCategories,
    nzbhydraTimeoutMs: nzbhydra && "timeoutMs" in nzbhydra ? nzbhydra.timeoutMs : current.nzbhydraTimeoutMs,
    nzbhydraCacheTtlSeconds: nzbhydra && "searchCacheTtlSeconds" in nzbhydra ? nzbhydra.searchCacheTtlSeconds : current.nzbhydraCacheTtlSeconds,
    nzbhydraFeedCacheTtlSeconds: nzbhydra && "feedCacheTtlSeconds" in nzbhydra ? nzbhydra.feedCacheTtlSeconds : current.nzbhydraFeedCacheTtlSeconds,
    nzbhydraFeedMaxResults: nzbhydra && "feedMaxResults" in nzbhydra ? nzbhydra.feedMaxResults : current.nzbhydraFeedMaxResults,
    plexServerUrl: runtime.plex.enabled && hasConfiguredValue(runtime.plex.serverUrl) ? runtime.plex.serverUrl : "",
    plexToken: runtime.plex.enabled && hasConfiguredValue(runtime.plex.token) ? runtime.plex.token : "",
    plexLibraryPath: runtime.plex.libraryPath || current.plexLibraryPath,
    plexSectionId: runtime.plex.enabled ? runtime.plex.sectionId : "",
    ...(hasConfiguredValue(runtime.metadata.tmdbApiKey) ? { tmdbApiKey: runtime.metadata.tmdbApiKey } : {}),
    ...(hasConfiguredValue(runtime.metadata.tvdbApiKey) ? { tvdbApiKey: runtime.metadata.tvdbApiKey } : {}),
    metadataLanguage: runtime.metadata.language || current.metadataLanguage,
    metadataCacheTtlHours: runtime.metadata.cacheTtlHours || current.metadataCacheTtlHours,
    subtitlesEnabled: runtime.subtitles.enabled,
    subtitleProviderOrder: runtime.subtitles.providerOrder?.length ? runtime.subtitles.providerOrder : current.subtitleProviderOrder,
    subtitleProviders: {
      subdl: {
        enabled: runtime.subtitles.providers?.subdl?.enabled ?? current.subtitleProviders.subdl.enabled,
        apiKey: runtime.subtitles.providers?.subdl?.apiKey || current.subtitleProviders.subdl.apiKey
      },
      opensubtitlescom: {
        enabled: runtime.subtitles.providers?.opensubtitlescom?.enabled ?? current.subtitleProviders.opensubtitlescom.enabled,
        apiKey: runtime.subtitles.providers?.opensubtitlescom?.apiKey || current.subtitleProviders.opensubtitlescom.apiKey,
        username: runtime.subtitles.providers?.opensubtitlescom?.username || current.subtitleProviders.opensubtitlescom.username,
        password: runtime.subtitles.providers?.opensubtitlescom?.password || current.subtitleProviders.opensubtitlescom.password
      }
    },
    subtitlesProvider: current.subtitlesProvider,
    subtitlesApiKey: current.subtitlesApiKey,
    subtitlesUsername: current.subtitlesUsername,
    subtitlesPassword: current.subtitlesPassword,
    subtitleLanguages: runtime.subtitles.languages?.length ? runtime.subtitles.languages : current.subtitleLanguages
  };
  await updateSettings(nextSettings);

  let usenetSynced = 0;
  const configuredUsenetNames = new Set<string>();
  for (const server of runtime.usenetProviders.filter((item) => hasConfiguredValue(item.name) && hasConfiguredValue(item.host))) {
    configuredUsenetNames.add(server.name.trim().toLowerCase());
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
  if (configuredUsenetNames.size > 0) {
    const existingServers = await prisma.usenetServer.findMany();
    for (const server of existingServers) {
      if (configuredUsenetNames.has(server.name.trim().toLowerCase())) continue;
      if (!server.enabled) continue;
      await prisma.usenetServer.update({
        where: { id: server.id },
        data: { enabled: false }
      });
    }
  }

  let requestProvidersSynced = 0;
  const configuredRequestProviderNames = new Set<string>();
  for (const provider of runtime.requestProviders.filter((item) => hasConfiguredValue(item.name) && hasConfiguredValue(item.baseUrl) && hasConfiguredValue(item.apiKey))) {
    configuredRequestProviderNames.add(provider.name.trim().toLowerCase());
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
  const existingProviders = await prisma.requestProvider.findMany();
  for (const provider of existingProviders) {
    if (configuredRequestProviderNames.has(provider.name.trim().toLowerCase())) continue;
    if (!provider.enabled) continue;
    await prisma.requestProvider.update({
      where: { id: provider.id },
      data: { enabled: false }
    });
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
