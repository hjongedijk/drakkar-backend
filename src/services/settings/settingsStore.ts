import { z } from "zod";
import { prisma } from "../../repositories/db/prisma.js";
import { updateRuntimeSettings } from "../config/runtimeSettings.js";
import { registerCoreTasks, REQUEST_RECOVERY_TASK_ID } from "../../workers/tasks/coreTasks.js";

const DEFAULT_NZBHYDRA_CATEGORIES = ["2030", "2040", "2045", "2050", "2060", "5030", "5040", "5045", "5080"];

export const settingsSchema = z.object({
  nzbhydraUrl: z.string().url().optional().or(z.literal("")),
  nzbhydraApiKey: z.string().optional(),
  nzbhydraCategories: z.array(z.string()).default(DEFAULT_NZBHYDRA_CATEGORIES),
  nzbhydraTimeoutMs: z.number().int().positive().default(45000),
  nzbhydraCacheTtlSeconds: z.number().int().positive().default(3600),
  nzbhydraFeedCacheTtlSeconds: z.number().int().positive().default(3600),
  nzbhydraFeedMaxResults: z.number().int().positive().default(1200),
  backupNzbFiles: z.boolean().default(false),
  tmdbApiKey: z.string().optional(),
  tvdbApiKey: z.string().optional(),
  metadataLanguage: z.string().default("en-US"),
  metadataCacheTtlHours: z.number().int().positive().default(168),
  defaultMovieProfile: z.string().default("Movie Standard"),
  defaultTvProfile: z.string().default("TV Standard"),
  monitorQueueSeedTarget: z.number().int().positive().default(12),
  plexServerUrl: z.string().url().optional().or(z.literal("")),
  plexToken: z.string().optional(),
  plexLibraryPath: z.string().default("/mnt/drakkar/media"),
  plexSectionId: z.string().optional(),
  plexClientIdentifier: z.string().default("drakkar"),
  subtitlesEnabled: z.boolean().default(false),
  subtitlesProvider: z.enum(["subdl", "opensubtitlescom"]).default("subdl"),
  subtitlesApiKey: z.string().optional(),
  subtitlesUsername: z.string().optional(),
  subtitlesPassword: z.string().optional(),
  subtitleProviderOrder: z.array(z.enum(["subdl", "opensubtitlescom"])).default(["subdl", "opensubtitlescom"]),
  subtitleProviders: z.object({
    subdl: z.object({
      enabled: z.boolean().default(false),
      apiKey: z.string().optional()
    }).default({}),
    opensubtitlescom: z.object({
      enabled: z.boolean().default(false),
      apiKey: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional()
    }).default({})
  }).default({}),
  subtitleLanguages: z.array(z.string()).default(["EN"]),
  taskIntervals: z.record(z.string(), z.number().int().positive().nullable()).default({})
});

export type AppSettings = z.infer<typeof settingsSchema>;

const DEFAULT_SETTINGS: AppSettings = {
  nzbhydraUrl: "",
  nzbhydraApiKey: "",
  nzbhydraCategories: DEFAULT_NZBHYDRA_CATEGORIES,
  nzbhydraTimeoutMs: 45000,
  nzbhydraCacheTtlSeconds: 3600,
  nzbhydraFeedCacheTtlSeconds: 3600,
  nzbhydraFeedMaxResults: 1200,
  backupNzbFiles: false,
  tmdbApiKey: "",
  tvdbApiKey: "",
  metadataLanguage: "en-US",
  metadataCacheTtlHours: 168,
  defaultMovieProfile: "Movie Standard",
  defaultTvProfile: "TV Standard",
  monitorQueueSeedTarget: 12,
  plexServerUrl: "",
  plexToken: "",
  plexLibraryPath: "/mnt/drakkar/media",
  plexSectionId: "",
  plexClientIdentifier: "drakkar",
  subtitlesEnabled: false,
  subtitlesProvider: "subdl",
  subtitlesApiKey: "",
  subtitlesUsername: "",
  subtitlesPassword: "",
  subtitleProviderOrder: ["subdl", "opensubtitlescom"],
  subtitleProviders: {
    subdl: {
      enabled: false,
      apiKey: ""
    },
    opensubtitlescom: {
      enabled: false,
      apiKey: "",
      username: "",
      password: ""
    }
  },
  subtitleLanguages: ["EN"],
  taskIntervals: {}
};

const SETTINGS_KEY = "app";
const SETTINGS_CACHE_MS = 30_000;
let cachedSettings: { value: AppSettings; expiresAt: number } | null = null;

export async function getSettings(): Promise<AppSettings> {
  if (cachedSettings && cachedSettings.expiresAt > Date.now()) return cachedSettings.value;
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  const stored = row?.value as Partial<AppSettings> | undefined;
  const migratedBase = stored?.nzbhydraTimeoutMs === 15000 ? { ...stored, nzbhydraTimeoutMs: DEFAULT_SETTINGS.nzbhydraTimeoutMs } : stored;
  const migratedProviders = sanitizeTaskIntervals(migrateLegacyPaths(migrateDefaultProfiles(migrateSubtitleProviders({ ...DEFAULT_SETTINGS, ...(migratedBase as object) }))));
  const value = !row ? DEFAULT_SETTINGS : settingsSchema.parse(migratedProviders);
  cachedSettings = { value, expiresAt: Date.now() + SETTINGS_CACHE_MS };
  return value;
}

function migrateLegacyPaths(input: Partial<AppSettings>): Partial<AppSettings> {
  return {
    ...input,
    plexLibraryPath: !input.plexLibraryPath || input.plexLibraryPath === "/mnt/media"
      ? DEFAULT_SETTINGS.plexLibraryPath
      : input.plexLibraryPath
  };
}

function migrateDefaultProfiles(input: Partial<AppSettings>): Partial<AppSettings> {
  const movie = input.defaultMovieProfile ?? "";
  const tv = input.defaultTvProfile ?? "";
  const normalizeMovieProfile = movie && ["Any", "Anime", "Remux Preferred", "WEB-DL Preferred", "Small Size"].includes(movie)
    ? DEFAULT_SETTINGS.defaultMovieProfile
    : movie;
  const normalizeTvProfile = tv && ["Any", "Anime", "Remux Preferred", "WEB-DL Preferred", "Small Size"].includes(tv)
    ? DEFAULT_SETTINGS.defaultTvProfile
    : tv;
  return {
    ...input,
    defaultMovieProfile: normalizeMovieProfile || DEFAULT_SETTINGS.defaultMovieProfile,
    defaultTvProfile: normalizeTvProfile || DEFAULT_SETTINGS.defaultTvProfile
  };
}

function sanitizeTaskIntervals(input: Partial<AppSettings>): Partial<AppSettings> {
  const taskIntervals = { ...(input.taskIntervals ?? {}) };
  // This task is the monitored-download engine. Blank UI values should mean
  // "use default interval", not "disable monitoring".
  if (taskIntervals[REQUEST_RECOVERY_TASK_ID] === null) delete taskIntervals[REQUEST_RECOVERY_TASK_ID];
  return {
    ...input,
    taskIntervals
  };
}

function migrateSubtitleProviders(input: Partial<AppSettings>): Partial<AppSettings> {
  const subdlEnabled = input.subtitleProviders?.subdl?.enabled
    ?? (input.subtitlesEnabled && input.subtitlesProvider === "subdl" && Boolean(input.subtitlesApiKey));
  const opensubsEnabled = input.subtitleProviders?.opensubtitlescom?.enabled
    ?? (input.subtitlesEnabled && input.subtitlesProvider === "opensubtitlescom" && Boolean(input.subtitlesApiKey) && Boolean(input.subtitlesUsername) && Boolean(input.subtitlesPassword));
  return {
    ...input,
    subtitleProviderOrder: Array.isArray(input.subtitleProviderOrder) && input.subtitleProviderOrder.length > 0
      ? [...new Set(input.subtitleProviderOrder)]
      : ["subdl", "opensubtitlescom"],
    subtitleProviders: {
      subdl: {
        enabled: Boolean(subdlEnabled),
        apiKey: input.subtitleProviders?.subdl?.apiKey ?? input.subtitlesApiKey ?? ""
      },
      opensubtitlescom: {
        enabled: Boolean(opensubsEnabled),
        apiKey: input.subtitleProviders?.opensubtitlescom?.apiKey ?? (input.subtitlesProvider === "opensubtitlescom" ? input.subtitlesApiKey : "") ?? "",
        username: input.subtitleProviders?.opensubtitlescom?.username ?? input.subtitlesUsername ?? "",
        password: input.subtitleProviders?.opensubtitlescom?.password ?? input.subtitlesPassword ?? ""
      }
    }
  };
}

export async function syncRuntimeSettingsFromDatabase(settingsOverride?: AppSettings) {
  const settings = settingsOverride ?? await getSettings();
  const [usenetProviders, requestProviders] = await Promise.all([
    prisma.usenetServer.findMany({ orderBy: [{ priority: "asc" }, { name: "asc" }] }),
    prisma.requestProvider.findMany({ orderBy: { createdAt: "asc" } })
  ]);
  updateRuntimeSettings((current) => ({
    ...current,
    nzbhydra: {
      ...current.nzbhydra,
      enabled: Boolean(settings.nzbhydraUrl && settings.nzbhydraApiKey),
      url: settings.nzbhydraUrl ?? "",
      apiKey: settings.nzbhydraApiKey ?? "",
      categories: settings.nzbhydraCategories,
      timeoutMs: settings.nzbhydraTimeoutMs,
      searchCacheTtlSeconds: settings.nzbhydraCacheTtlSeconds,
      feedCacheTtlSeconds: settings.nzbhydraFeedCacheTtlSeconds,
      feedMaxResults: settings.nzbhydraFeedMaxResults
    },
    plex: {
      ...current.plex,
      enabled: Boolean(settings.plexServerUrl && settings.plexToken),
      serverUrl: settings.plexServerUrl ?? "",
      token: settings.plexToken ?? "",
      libraryPath: settings.plexLibraryPath,
      sectionId: settings.plexSectionId ?? ""
    },
    metadata: {
      ...current.metadata,
      tmdbApiKey: settings.tmdbApiKey ?? "",
      tvdbApiKey: settings.tvdbApiKey ?? "",
      language: settings.metadataLanguage,
      cacheTtlHours: settings.metadataCacheTtlHours
    },
    subtitles: {
      ...current.subtitles,
      enabled: settings.subtitlesEnabled,
      providerOrder: settings.subtitleProviderOrder,
      providers: {
        subdl: {
          enabled: settings.subtitleProviders.subdl.enabled,
          apiKey: settings.subtitleProviders.subdl.apiKey ?? ""
        },
        opensubtitlescom: {
          enabled: settings.subtitleProviders.opensubtitlescom.enabled,
          apiKey: settings.subtitleProviders.opensubtitlescom.apiKey ?? "",
          username: settings.subtitleProviders.opensubtitlescom.username ?? "",
          password: settings.subtitleProviders.opensubtitlescom.password ?? ""
        }
      },
      languages: settings.subtitleLanguages
    },
    usenetProviders: usenetProviders.map((server) => ({
      enabled: server.enabled,
      name: server.name,
      host: server.host,
      port: server.port,
      ssl: server.ssl,
      username: server.username ?? "",
      password: server.password ?? "",
      connections: server.connections,
      priority: server.priority,
      isBackup: server.isBackup,
      retentionDays: server.retentionDays ?? undefined
    })),
    requestProviders: requestProviders.map((provider) => ({
      type: provider.type === "seerr" ? "seerr" : "seerr",
      enabled: provider.enabled,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      syncIntervalMinutes: provider.syncIntervalMinutes,
      defaultMovieProfile: provider.defaultMovieProfile ?? "",
      defaultTvProfile: provider.defaultTvProfile ?? ""
    }))
  }));
}

export async function updateSettings(input: unknown): Promise<AppSettings> {
  const settings = settingsSchema.parse(sanitizeTaskIntervals(migrateSubtitleProviders(input as Partial<AppSettings>)));
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: settings },
    create: { key: SETTINGS_KEY, value: settings }
  });
  cachedSettings = { value: settings, expiresAt: Date.now() + SETTINGS_CACHE_MS };
  registerCoreTasks(settings);
  await syncRuntimeSettingsFromDatabase(settings);
  return settings;
}
