import { join } from "node:path";
import { z } from "zod";
import { ensureRuntimeSettings, getFrontendApiToken } from "./runtimeSettings.js";

const runtimeSettings = ensureRuntimeSettings(process.env.CONFIG_DIR || "/data/config");

const envBoolean = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().default(runtimeSettings.infrastructure.postgres.url),
  REDIS_URL: z.string().url().default(runtimeSettings.infrastructure.valkey.url),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  CONFIG_DIR: z.string().default("/data/config"),
  VFS_ROOT: z.string().default("/mnt"),
  VFS_DOWNLOADS_DIR: z.string().default("/mnt/downloads"),
  VFS_COMPLETED_DIR: z.string().default("/mnt/completed"),
  VFS_NZB_DIR: z.string().default("/mnt/nzb"),
  VFS_TMP_DIR: z.string().default("/mnt/.tmp"),
  VFS_FAILED_DIR: z.string().default("/mnt/.failed"),
  MEDIA_SYMLINKS_DIR: z.string().default("/mnt/media"),
  MEDIA_MOVIES_DIR: z.string().optional(),
  MEDIA_TV_DIR: z.string().optional(),
  NZB_BACKUPS_DIR: z.string().default("/data/nzb-backup"),
  FUSE_MOUNT_ENABLED: envBoolean.default(runtimeSettings.infrastructure.runtime.fuseMountEnabled),
  FUSE_MOUNT_PATH: z.string().default("/mnt/fuse"),
  FUSE_ALLOW_OTHER: envBoolean.default(true),
  FUSE_FORCE_MOUNT: envBoolean.default(true),
  FUSE_DEBUG: envBoolean.default(false),
  FRONTEND_API_TOKEN: z.string().default(runtimeSettings.frontendApiToken),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REQUEST_SYNC_ENABLED: envBoolean.default(runtimeSettings.infrastructure.runtime.requestSyncEnabled),
  BACKGROUND_REPAIR_ENABLED: envBoolean.default(runtimeSettings.infrastructure.runtime.backgroundRepairEnabled),
  STARTUP_RECOVERY_ENABLED: envBoolean.default(runtimeSettings.infrastructure.runtime.startupRecoveryEnabled),
  DOWNLOAD_WORKERS_ENABLED: envBoolean.default(runtimeSettings.infrastructure.runtime.downloadWorkersEnabled),
  STREAM_POOL_PRIME_ENABLED: envBoolean.default(runtimeSettings.infrastructure.runtime.streamPoolPrimeEnabled)
});

const parsedEnv = envSchema.parse(process.env);

export const env = {
  ...parsedEnv,
  MEDIA_MOVIES_DIR: parsedEnv.MEDIA_MOVIES_DIR ?? join(parsedEnv.MEDIA_SYMLINKS_DIR, "movies"),
  MEDIA_TV_DIR: parsedEnv.MEDIA_TV_DIR ?? join(parsedEnv.MEDIA_SYMLINKS_DIR, "tv"),
  getFrontendApiToken
};

export const requiredDirectories = [
  env.CONFIG_DIR,
  env.VFS_ROOT,
  env.VFS_DOWNLOADS_DIR,
  env.VFS_COMPLETED_DIR,
  env.VFS_NZB_DIR,
  env.MEDIA_SYMLINKS_DIR,
  env.MEDIA_MOVIES_DIR,
  env.MEDIA_TV_DIR,
  env.NZB_BACKUPS_DIR,
  env.FUSE_MOUNT_PATH
] as const;
