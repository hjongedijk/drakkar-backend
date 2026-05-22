import { z } from "zod";
import { prisma } from "../db/prisma.js";

export const settingsSchema = z.object({
  nzbhydraUrl: z.string().url().optional().or(z.literal("")),
  nzbhydraApiKey: z.string().optional(),
  nzbhydraCategories: z.array(z.string()).default(["2000", "5000"]),
  nzbhydraTimeoutMs: z.number().int().positive().default(15000),
  nzbhydraCacheTtlSeconds: z.number().int().positive().default(3600),
  nzbhydraFeedCacheTtlSeconds: z.number().int().positive().default(900),
  backupNzbFiles: z.boolean().default(false),
  tmdbApiKey: z.string().optional(),
  tvdbApiKey: z.string().optional(),
  metadataLanguage: z.string().default("en-US"),
  metadataCacheTtlHours: z.number().int().positive().default(168),
  defaultMovieProfile: z.string().default("Movie Standard"),
  defaultTvProfile: z.string().default("TV Standard"),
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
  nzbhydraCategories: ["2000", "5000"],
  nzbhydraTimeoutMs: 15000,
  nzbhydraCacheTtlSeconds: 3600,
  nzbhydraFeedCacheTtlSeconds: 900,
  backupNzbFiles: false,
  tmdbApiKey: "",
  tvdbApiKey: "",
  metadataLanguage: "en-US",
  metadataCacheTtlHours: 168,
  defaultMovieProfile: "Movie Standard",
  defaultTvProfile: "TV Standard",
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
  const value = !row ? DEFAULT_SETTINGS : settingsSchema.parse({ ...DEFAULT_SETTINGS, ...(row.value as object) });
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
