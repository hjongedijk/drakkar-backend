import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { env } from "../../config/env.js";
import { redis } from "../../db/redis.js";
import { parseNewznabXml } from "../newznab/parser.js";
import type { AppSettings } from "../../settings/settingsStore.js";
import type { Release } from "../../releases/types.js";
import { parseNzbXml } from "../../nzb/parser.js";

export type SearchKind = "movie" | "tv" | "season" | "episode" | "manual";

export type SearchParams = {
  kind: SearchKind;
  query?: string;
  imdbId?: string;
  tmdbId?: string;
  tvdbId?: string;
  season?: number;
  episode?: number;
  categories?: string[];
};

function requireHydra(settings: AppSettings) {
  if (!settings.nzbhydraUrl || !settings.nzbhydraApiKey) {
    throw new Error("NZBHydra2 URL and API key must be configured");
  }
}

function buildSearchUrl(settings: AppSettings, params: SearchParams) {
  requireHydra(settings);
  const url = new URL("/api", settings.nzbhydraUrl);
  url.searchParams.set("apikey", settings.nzbhydraApiKey ?? "");
  url.searchParams.set("o", "xml");
  url.searchParams.set("t", params.kind === "manual" ? "search" : ["tv", "season", "episode"].includes(params.kind) ? "tvsearch" : params.kind);
  if (params.query) url.searchParams.set("q", params.query);
  if (params.imdbId) url.searchParams.set("imdbid", params.imdbId.replace(/^tt/, ""));
  if (params.tvdbId) url.searchParams.set("tvdbid", params.tvdbId);
  if (params.season) url.searchParams.set("season", String(params.season));
  if (params.episode) url.searchParams.set("ep", String(params.episode));
  url.searchParams.set("cat", (params.categories ?? settings.nzbhydraCategories).join(","));
  return url;
}

function releaseDownloadUrl(settings: AppSettings, release: Release) {
  requireHydra(settings);
  if (!release.downloadUrl) throw new Error("release has no download URL");

  const url = new URL(release.downloadUrl, settings.nzbhydraUrl);
  if (!url.searchParams.has("apikey")) url.searchParams.set("apikey", settings.nzbhydraApiKey ?? "");
  return url;
}

function safeNzbFilename(release: Release, fallback: string) {
  const rawName = String(release.guid || release.title || fallback || "release");
  const safeName = rawName.replace(/[^a-z0-9._-]+/gi, "_").replace(/_+/g, "_").slice(0, 180) || "release";
  return safeName.toLowerCase().endsWith(".nzb") ? safeName : `${safeName}.nzb`;
}

export async function testNzbhydraConnection(settings: AppSettings) {
  const url = buildSearchUrl(settings, { kind: "manual", query: "test" });
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { signal: AbortSignal.timeout(settings.nzbhydraTimeoutMs) });
  return { ok: response.ok, status: response.status };
}

export async function searchNzbhydra(settings: AppSettings, params: SearchParams): Promise<Release[]> {
  const url = buildSearchUrl(settings, params);
  const cacheKey = `search:${createHash("sha1").update(url.toString()).digest("hex")}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as Release[];

  const response = await fetch(url, { signal: AbortSignal.timeout(settings.nzbhydraTimeoutMs) });
  if (!response.ok) throw new Error(`NZBHydra2 search failed with HTTP ${response.status}`);

  const xml = await response.text();
  const releases = parseNewznabXml(xml);
  await redis.set(cacheKey, JSON.stringify(releases), "EX", settings.nzbhydraCacheTtlSeconds);
  return releases;
}

export async function downloadNzb(settings: AppSettings, release: Release) {
  const { bytes, filename } = await fetchNzbForRelease(settings, release);
  await mkdir(env.VFS_NZB_DIR, { recursive: true });
  const primaryPath = join(env.VFS_NZB_DIR, filename);
  const backupPath = join(env.NZB_BACKUPS_DIR, filename);
  await writeFile(primaryPath, bytes);
  let finalBackupPath = "";
  if (settings.backupNzbFiles) {
    await mkdir(env.NZB_BACKUPS_DIR, { recursive: true });
    await writeFile(backupPath, bytes);
    finalBackupPath = backupPath;
  }
  return { primaryPath, backupPath: finalBackupPath, bytes: bytes.length };
}

export async function fetchNzbForRelease(settings: AppSettings, release: Release) {
  const url = releaseDownloadUrl(settings, release);
  const response = await fetch(url, { signal: AbortSignal.timeout(settings.nzbhydraTimeoutMs) });
  if (!response.ok) throw new Error(`NZB download failed with HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  const disposition = response.headers.get("content-disposition");
  const filenameMatch = disposition?.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  const filename = safeNzbFilename(release, filenameMatch?.[1] ? decodeURIComponent(filenameMatch[1]) : basename(url.pathname));
  return {
    bytes,
    filename,
    contentType: response.headers.get("content-type") ?? "application/x-nzb"
  };
}

export async function testDownloadNzb(settings: AppSettings, release: Release) {
  const result = await downloadNzb(settings, release);
  const content = await readFile(result.primaryPath, "utf8");
  const parsed = parseNzbXml(content, release.title);
  return {
    ok: parsed.valid,
    bytes: result.bytes,
    primaryPath: result.primaryPath,
    backupPath: result.backupPath,
    title: parsed.title,
    fileCount: parsed.files.length,
    segmentCount: parsed.segmentCount,
    totalSize: parsed.totalSize,
    errors: parsed.errors
  };
}
