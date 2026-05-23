import { z } from "zod";
import { prisma } from "../db/prisma.js";

const DEFAULT_NZBHYDRA_CATEGORIES = ["2030", "2040", "2045", "2050", "2060", "5030", "5040", "5045", "5080"];

export const settingsSchema = z.object({
  nzbhydraUrl: z.string().url().optional().or(z.literal("")),
  nzbhydraApiKey: z.string().optional(),
  nzbhydraCategories: z.array(z.string()).default(DEFAULT_NZBHYDRA_CATEGORIES),
  nzbhydraTimeoutMs: z.number().int().positive().default(45000),
  nzbhydraCacheTtlSeconds: z.number().int().positive().default(3600),
  nzbhydraFeedCacheTtlSeconds: z.number().int().positive().default(900),
  nzbhydraFeedMaxResults: z.number().int().positive().default(10000),
  backupNzbFiles: z.boolean().default(false),
  tmdbApiKey: z.string().optional(),
  tvdbApiKey: z.string().optional(),
  metadataLanguage: z.string().default("en-US"),
  metadataCacheTtlHours: z.number().int().positive().default(168),
  defaultMovieProfile: z.string().default("Movie Standard"),
  defaultTvProfile: z.string().default("TV Standard"),
  monitorQueueSeedTarget: z.number().int().positive().default(50),
  plexServerUrl: z.string().url().optional().or(z.literal("")),
  plexToken: z.string().optional(),
  plexLibraryPath: z.string().default("/mnt/media"),
  plexSectionId: z.string().optional(),
  plexClientIdentifier: z.string().default("drakkar")
});

export type AppSettings = z.infer<typeof settingsSchema>;

const DEFAULT_SETTINGS: AppSettings = {
  nzbhydraUrl: "",
  nzbhydraApiKey: "",
  nzbhydraCategories: DEFAULT_NZBHYDRA_CATEGORIES,
  nzbhydraTimeoutMs: 45000,
  nzbhydraCacheTtlSeconds: 3600,
  nzbhydraFeedCacheTtlSeconds: 900,
  nzbhydraFeedMaxResults: 10000,
  backupNzbFiles: false,
  tmdbApiKey: "",
  tvdbApiKey: "",
  metadataLanguage: "en-US",
  metadataCacheTtlHours: 168,
  defaultMovieProfile: "Movie Standard",
  defaultTvProfile: "TV Standard",
  monitorQueueSeedTarget: 50,
  plexServerUrl: "",
  plexToken: "",
  plexLibraryPath: "/mnt/media",
  plexSectionId: "",
  plexClientIdentifier: "drakkar"
};

const SETTINGS_KEY = "app";
const SETTINGS_CACHE_MS = 30_000;
let cachedSettings: { value: AppSettings; expiresAt: number } | null = null;

export async function getSettings(): Promise<AppSettings> {
  if (cachedSettings && cachedSettings.expiresAt > Date.now()) return cachedSettings.value;
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  const stored = row?.value as Partial<AppSettings> | undefined;
  const migrated = stored?.nzbhydraTimeoutMs === 15000 ? { ...stored, nzbhydraTimeoutMs: DEFAULT_SETTINGS.nzbhydraTimeoutMs } : stored;
  const value = !row ? DEFAULT_SETTINGS : settingsSchema.parse({ ...DEFAULT_SETTINGS, ...(migrated as object) });
  cachedSettings = { value, expiresAt: Date.now() + SETTINGS_CACHE_MS };
  return value;
}

export async function updateSettings(input: unknown): Promise<AppSettings> {
  const settings = settingsSchema.parse(input);
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: settings },
    create: { key: SETTINGS_KEY, value: settings }
  });
  cachedSettings = { value: settings, expiresAt: Date.now() + SETTINGS_CACHE_MS };
  return settings;
}
