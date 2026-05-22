import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const runtimeSettingsSchema = z.object({
  frontendApiToken: z.string().min(16),
  apiBaseUrl: z.string().default(""),
  backendUrl: z.string().default("http://backend:3000")
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

function defaultRuntimeSettings(): RuntimeSettings {
  return {
    frontendApiToken: `drakkar_${randomBytes(32).toString("base64url")}`,
    apiBaseUrl: "",
    backendUrl: "http://backend:3000"
  };
}

export function runtimeSettingsPath(configDir = process.env.CONFIG_DIR || "/data/config") {
  return join(configDir, "settings.json");
}

export function ensureRuntimeSettings(configDir = process.env.CONFIG_DIR || "/data/config"): RuntimeSettings {
  const path = runtimeSettingsPath(configDir);
  mkdirSync(dirname(path), { recursive: true });

  if (!existsSync(path)) {
    const created = defaultRuntimeSettings();
    writeFileSync(path, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
    return created;
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const merged = runtimeSettingsSchema.parse({ ...defaultRuntimeSettings(), ...(parsed as object) });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}
