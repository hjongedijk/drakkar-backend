import { countAdminUsers, createInitialAdminUser } from "../services/authService.js";
import {
  countEnabledRequestProviders,
  countEnabledUsenetServers,
  createRequestProvider,
  createUsenetServer,
  findExistingRequestProvider,
  findExistingUsenetServer,
  getFirstRequestProvider,
  getFirstUsenetServer,
  getSetupCompletedSetting,
  markSetupCompleted,
  updateRequestProvider,
  updateUsenetServer
} from "../repositories/setupRepository.js";
import { getSettings, syncRuntimeSettingsFromDatabase, updateSettings } from "../services/settings/settingsStore.js";

export async function getSetupStatus() {
  const [settings, usenetServers, requestProviders, setupRow, adminUsers, firstUsenet, firstRequestProvider] = await Promise.all([
    getSettings(),
    countEnabledUsenetServers(),
    countEnabledRequestProviders(),
    getSetupCompletedSetting(),
    countAdminUsers(),
    getFirstUsenetServer(),
    getFirstRequestProvider()
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
      plexLibraryPath: settings.plexLibraryPath ?? "/mnt/drakkar/media",
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

type CompleteSetupInput = {
  admin?: {
    username: string;
    displayName?: string;
    password: string;
  };
  settings?: {
    nzbhydraUrl?: string;
    nzbhydraApiKey?: string;
    tmdbApiKey?: string;
    tvdbApiKey?: string;
    plexServerUrl?: string;
    plexToken?: string;
    plexLibraryPath?: string;
    plexSectionId?: string;
  };
  usenet?: {
    name: string;
    host: string;
    port: number;
    ssl: boolean;
    username?: string;
    password?: string;
    connections: number;
    priority: number;
    enabled: boolean;
    isBackup: boolean;
  };
  requestProvider?: {
    name: string;
    baseUrl: string;
    apiKey: string;
    enabled: boolean;
    syncIntervalMinutes: number;
    defaultMovieProfile?: string;
    defaultTvProfile?: string;
  };
};

export async function completeSetup(input: CompleteSetupInput) {
  const status = await getSetupStatus();
  if (status.completed) {
    return {
      conflict: true as const
    };
  }

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
    const existing = await findExistingUsenetServer(input.usenet);
    const data = {
      ...input.usenet,
      username: input.usenet.username || null,
      password: input.usenet.password || null
    };
    if (existing) await updateUsenetServer(existing.id, data);
    else await createUsenetServer(data);
  }
  if (input.requestProvider) {
    const existing = await findExistingRequestProvider(input.requestProvider);
    const data = {
      type: "seerr" as const,
      ...input.requestProvider
    };
    if (existing) await updateRequestProvider(existing.id, data);
    else await createRequestProvider(data);
  }
  await markSetupCompleted();
  await syncRuntimeSettingsFromDatabase();
  return {
    conflict: false as const,
    status: await getSetupStatus()
  };
}
