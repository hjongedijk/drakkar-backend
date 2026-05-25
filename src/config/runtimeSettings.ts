import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const runtimeSettingsSchema = z.object({
  drakkarApiToken: z.string().min(16),
  apiBaseUrl: z.string().default(""),
  backendUrl: z.string().default("http://backend:3000"),
  infrastructure: z.object({
    postgres: z.object({
      user: z.string().default("postgres"),
      password: z.string().default("postgres"),
      database: z.string().default("drakkar"),
      url: z.string().default("postgresql://postgres:postgres@postgres:5432/drakkar")
    }).default({}),
    valkey: z.object({
      url: z.string().default("redis://valkey:6379")
    }).default({}),
    ports: z.object({
      frontend: z.number().int().positive().default(8080),
      backend: z.number().int().positive().default(3000),
      valkeyInsight: z.number().int().positive().default(5540)
    }).default({}),
    runtime: z.object({
      fuseMountEnabled: z.boolean().default(true),
      requestSyncEnabled: z.boolean().default(true),
      backgroundRepairEnabled: z.boolean().default(true),
      startupRecoveryEnabled: z.boolean().default(true),
      downloadWorkersEnabled: z.boolean().default(true),
      streamPoolPrimeEnabled: z.boolean().default(true)
    }).default({})
  }).default({}),
  nzbhydra: z.object({
    enabled: z.boolean().default(false),
    url: z.string().default(""),
    apiKey: z.string().default(""),
    categories: z.array(z.string()).default(["2030", "2040", "2045", "2050", "2060", "5030", "5040", "5045", "5080"]),
    timeoutMs: z.number().int().positive().default(45000),
    searchCacheTtlSeconds: z.number().int().positive().default(3600),
    feedCacheTtlSeconds: z.number().int().positive().default(900),
    feedMaxResults: z.number().int().positive().default(10000)
  }).default({}),
  plex: z.object({
    enabled: z.boolean().default(false),
    serverUrl: z.string().default(""),
    token: z.string().default(""),
    libraryPath: z.string().default("/mnt/media"),
    sectionId: z.string().default("")
  }).default({}),
  metadata: z.object({
    tmdbApiKey: z.string().default(""),
    tvdbApiKey: z.string().default(""),
    language: z.string().default("en-US"),
    cacheTtlHours: z.number().int().positive().default(168)
  }).default({}),
  usenetProviders: z.array(z.object({
    enabled: z.boolean().default(false),
    name: z.string().default(""),
    host: z.string().default(""),
    port: z.number().int().positive().default(563),
    ssl: z.boolean().default(true),
    username: z.string().default(""),
    password: z.string().default(""),
    connections: z.number().int().positive().default(10),
    priority: z.number().int().default(0),
    isBackup: z.boolean().default(false),
    retentionDays: z.number().int().positive().optional()
  })).default([]),
  requestProviders: z.array(z.object({
    type: z.literal("seerr").default("seerr"),
    enabled: z.boolean().default(false),
    name: z.string().default("Seerr"),
    baseUrl: z.string().default(""),
    apiKey: z.string().default(""),
    syncIntervalMinutes: z.number().int().positive().default(15),
    defaultMovieProfile: z.string().default(""),
    defaultTvProfile: z.string().default("")
  })).default([])
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
let cachedRuntimeSettings: RuntimeSettings | null = null;

function defaultRuntimeSettings(): RuntimeSettings {
  return {
    drakkarApiToken: `drakkar_${randomBytes(32).toString("base64url")}`,
    apiBaseUrl: "",
    backendUrl: "http://backend:3000",
    infrastructure: {
      postgres: {
        user: "postgres",
        password: "postgres",
        database: "drakkar",
        url: "postgresql://postgres:postgres@postgres:5432/drakkar"
      },
      valkey: {
        url: "redis://valkey:6379"
      },
      ports: {
        frontend: 8080,
        backend: 3000,
        valkeyInsight: 5540
      },
      runtime: {
        fuseMountEnabled: true,
        requestSyncEnabled: true,
        backgroundRepairEnabled: true,
        startupRecoveryEnabled: true,
        downloadWorkersEnabled: true,
        streamPoolPrimeEnabled: true
      }
    },
    nzbhydra: {
      enabled: false,
      url: "",
      apiKey: "",
      categories: ["2030", "2040", "2045", "2050", "2060", "5030", "5040", "5045", "5080"],
      timeoutMs: 45000,
      searchCacheTtlSeconds: 3600,
      feedCacheTtlSeconds: 900,
      feedMaxResults: 10000
    },
    plex: {
      enabled: false,
      serverUrl: "",
      token: "",
      libraryPath: "/mnt/media",
      sectionId: ""
    },
    metadata: {
      tmdbApiKey: "",
      tvdbApiKey: "",
      language: "en-US",
      cacheTtlHours: 168
    },
    usenetProviders: [
      {
        enabled: false,
        name: "Primary Usenet",
        host: "news.example.com",
        port: 563,
        ssl: true,
        username: "fill-me",
        password: "fill-me",
        connections: 24,
        priority: 0,
        isBackup: false
      }
    ],
    requestProviders: [
      {
        type: "seerr",
        enabled: false,
        name: "Seerr",
        baseUrl: "http://seerr:5055",
        apiKey: "fill-me",
        syncIntervalMinutes: 15,
        defaultMovieProfile: "",
        defaultTvProfile: ""
      }
    ]
  };
}

function mergeExampleProviderArrays(input: Partial<RuntimeSettings>) {
  const defaults = defaultRuntimeSettings();
  return {
    ...input,
    usenetProviders: Array.isArray(input.usenetProviders) && input.usenetProviders.length > 0 ? input.usenetProviders : defaults.usenetProviders,
    requestProviders: Array.isArray(input.requestProviders) && input.requestProviders.length > 0 ? input.requestProviders : defaults.requestProviders
  };
}

export function runtimeSettingsPath(configDir = process.env.CONFIG_DIR || "/data/config") {
  return join(configDir, "settings.json");
}

function resolveConfigDir(configDir = process.env.CONFIG_DIR || "/data/config") {
  try {
    mkdirSync(configDir, { recursive: true });
    return configDir;
  } catch (error) {
    if (process.env.CONFIG_DIR) throw error;
    const testLikeRuntime = process.env.NODE_ENV === "test"
      || process.env.GITHUB_ACTIONS === "true"
      || process.argv.includes("--test")
      || process.execArgv.includes("--test");
    if (!testLikeRuntime) throw error;
    const fallback = join(tmpdir(), "drakkar-config");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function ensureRuntimeSettings(configDir = process.env.CONFIG_DIR || "/data/config"): RuntimeSettings {
  const resolvedConfigDir = resolveConfigDir(configDir);
  const path = runtimeSettingsPath(resolvedConfigDir);
  mkdirSync(dirname(path), { recursive: true });

  if (!existsSync(path)) {
    const created = defaultRuntimeSettings();
    writeFileSync(path, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
    cachedRuntimeSettings = created;
    return created;
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeSettings> & { frontendApiToken?: string; drakkarApiToken?: string };
  if (!parsed.drakkarApiToken && parsed.frontendApiToken) parsed.drakkarApiToken = parsed.frontendApiToken;
  const legacyIndexer = Array.isArray((parsed as { indexers?: Array<Record<string, unknown>> }).indexers)
    ? (parsed as { indexers?: Array<Record<string, unknown>> }).indexers?.find((item) => {
      if (!item || typeof item !== "object") return false;
      const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
      const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
      return type === "nzbhydra2" || name.includes("nzbhydra");
    })
    : undefined;
  if (
    legacyIndexer
    && (!parsed.nzbhydra || !parsed.nzbhydra.url || !parsed.nzbhydra.apiKey)
  ) {
    const defaultNzbhydra = defaultRuntimeSettings().nzbhydra;
    parsed.nzbhydra = {
      ...defaultNzbhydra,
      ...parsed.nzbhydra,
      enabled: typeof legacyIndexer.enabled === "boolean" ? legacyIndexer.enabled : (parsed.nzbhydra?.enabled ?? defaultNzbhydra.enabled),
      url: typeof legacyIndexer.url === "string" ? legacyIndexer.url : (parsed.nzbhydra?.url ?? defaultNzbhydra.url),
      apiKey: typeof legacyIndexer.apiKey === "string" ? legacyIndexer.apiKey : (parsed.nzbhydra?.apiKey ?? defaultNzbhydra.apiKey)
    };
  }
  const input = mergeExampleProviderArrays(parsed as Partial<RuntimeSettings>) as RuntimeSettings & {
    nzbhydra?: { categories?: string[]; timeoutMs?: number };
  };
  if (JSON.stringify(input.nzbhydra?.categories ?? []) === JSON.stringify(["2000", "5000"])) {
    input.nzbhydra = {
      ...input.nzbhydra,
      categories: defaultRuntimeSettings().nzbhydra.categories
    };
  }
  if (input.nzbhydra?.timeoutMs === 15000) {
    input.nzbhydra = {
      ...input.nzbhydra,
      timeoutMs: defaultRuntimeSettings().nzbhydra.timeoutMs
    };
  }
  const merged = runtimeSettingsSchema.parse({ ...defaultRuntimeSettings(), ...input });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  cachedRuntimeSettings = merged;
  return merged;
}

export function getRuntimeSettings(configDir = process.env.CONFIG_DIR || "/data/config"): RuntimeSettings {
  return cachedRuntimeSettings ?? ensureRuntimeSettings(configDir);
}

export function getDrakkarApiToken(configDir = process.env.CONFIG_DIR || "/data/config") {
  return getRuntimeSettings(configDir).drakkarApiToken;
}

export function updateRuntimeSettings(
  updater: (current: RuntimeSettings) => RuntimeSettings,
  configDir = process.env.CONFIG_DIR || "/data/config"
): RuntimeSettings {
  const resolvedConfigDir = resolveConfigDir(configDir);
  const current = ensureRuntimeSettings(resolvedConfigDir);
  const next = runtimeSettingsSchema.parse(updater(current));
  const path = runtimeSettingsPath(resolvedConfigDir);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  cachedRuntimeSettings = next;
  return next;
}

export function rotateDrakkarApiToken(configDir = process.env.CONFIG_DIR || "/data/config") {
  return updateRuntimeSettings((current) => ({
    ...current,
    drakkarApiToken: `drakkar_${randomBytes(32).toString("base64url")}`
  }), configDir);
}

export const getFrontendApiToken = getDrakkarApiToken;
export const rotateFrontendApiToken = rotateDrakkarApiToken;
