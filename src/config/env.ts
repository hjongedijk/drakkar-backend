import "dotenv/config";
import { join } from "node:path";
import { z } from "zod";

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
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  CONFIG_DIR: z.string().default("/config"),
  VFS_ROOT: z.string().default("/data"),
  VFS_DOWNLOADS_DIR: z.string().default("/data/downloads"),
  VFS_COMPLETED_DIR: z.string().default("/data/completed"),
  VFS_NZB_DIR: z.string().default("/data/nzb"),
  VFS_TMP_DIR: z.string().default("/data/.tmp"),
  VFS_FAILED_DIR: z.string().default("/data/.failed"),
  MEDIA_SYMLINKS_DIR: z.string().default("/data/media"),
  MEDIA_MOVIES_DIR: z.string().optional(),
  MEDIA_TV_DIR: z.string().optional(),
  NZB_BACKUPS_DIR: z.string().default("/data/nzb-backup"),
  FUSE_MOUNT_ENABLED: envBoolean.default(false),
  FUSE_MOUNT_PATH: z.string().default("/fuse/vfs"),
  FUSE_ALLOW_OTHER: envBoolean.default(false),
  FUSE_FORCE_MOUNT: envBoolean.default(true),
  FUSE_DEBUG: envBoolean.default(false),
  FRONTEND_API_TOKEN: z.string().default("dev-frontend-token"),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REQUEST_SYNC_ENABLED: envBoolean.default(true)
});

const parsedEnv = envSchema.parse(process.env);

export const env = {
  ...parsedEnv,
  MEDIA_MOVIES_DIR: parsedEnv.MEDIA_MOVIES_DIR ?? join(parsedEnv.MEDIA_SYMLINKS_DIR, "movies"),
  MEDIA_TV_DIR: parsedEnv.MEDIA_TV_DIR ?? join(parsedEnv.MEDIA_SYMLINKS_DIR, "tv")
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
  env.NZB_BACKUPS_DIR
] as const;
