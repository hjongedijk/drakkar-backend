import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { env } from "../config/env.js";
import { getSettings, updateSettings } from "../settings/settingsStore.js";

type PlexLibrary = {
  key: string;
  title: string;
  type?: string;
  locations: string[];
};

const PLEX_PRODUCT = "Drakkar";
const PLEX_VERSION = "0.1.1";
const refreshDedup = new Map<string, number>();

function plexHeaders(token?: string, clientIdentifier = "drakkar") {
  return {
    accept: "application/json",
    "x-plex-client-identifier": clientIdentifier || "drakkar",
    "x-plex-product": PLEX_PRODUCT,
    "x-plex-version": PLEX_VERSION,
    "x-plex-platform": "Node.js",
    ...(token ? { "x-plex-token": token } : {})
  };
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function plexUrl(baseUrl: string, path: string) {
  return `${trimSlash(baseUrl)}${path}`;
}

function decodeXml(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attr(input: string, name: string) {
  const match = input.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function parsePlexLibraries(input: unknown): PlexLibrary[] {
  const container = input as {
    MediaContainer?: { Directory?: unknown[] };
    mediaContainer?: { directory?: unknown[] };
  };
  const dirs = container.MediaContainer?.Directory ?? container.mediaContainer?.directory;
  if (Array.isArray(dirs)) {
    return dirs.map((dir) => {
      const row = dir as { key?: string | number; title?: string; type?: string; Location?: Array<{ path?: string }>; location?: Array<{ path?: string }> };
      return {
        key: String(row.key ?? ""),
        title: row.title ?? String(row.key ?? ""),
        type: row.type,
        locations: (row.Location ?? row.location ?? []).map((location) => location.path).filter(Boolean) as string[]
      };
    }).filter((library) => library.key);
  }
  return [];
}

function parsePlexLibrariesXml(xml: string): PlexLibrary[] {
  const libraries: PlexLibrary[] = [];
  const directoryMatches = xml.matchAll(/<Directory\b[\s\S]*?<\/Directory>|<Directory\b[^>]*\/>/g);
  for (const match of directoryMatches) {
    const block = match[0];
    const key = attr(block, "key");
    if (!key) continue;
    const locations = Array.from(block.matchAll(/<Location\b[^>]*path="([^"]*)"/g))
      .map((location) => location[1])
      .filter((location): location is string => Boolean(location))
      .map((location) => decodeXml(location));
    libraries.push({
      key,
      title: attr(block, "title") ?? key,
      type: attr(block, "type"),
      locations
    });
  }
  return libraries;
}

async function plexFetch(path: string, init: RequestInit = {}) {
  const settings = await getSettings();
  if (!settings.plexServerUrl || !settings.plexToken) throw new Error("Plex is not configured.");
  return fetch(plexUrl(settings.plexServerUrl, path), {
    ...init,
    headers: {
      ...plexHeaders(settings.plexToken, settings.plexClientIdentifier),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(15000)
  });
}

export async function listPlexLibraries(): Promise<PlexLibrary[]> {
  const response = await plexFetch("/library/sections");
  if (!response.ok) throw new Error(`Plex library request failed with HTTP ${response.status}`);
  const text = await response.text();
  try {
    return parsePlexLibraries(JSON.parse(text));
  } catch {
    return parsePlexLibrariesXml(text);
  }
}

function pathCandidates(path: string, plexLibraryPath: string) {
  const normalized = resolve(path);
  const parent = dirname(normalized);
  const configuredRoot = resolve(plexLibraryPath || "/mnt/media");
  const mapped = normalized.startsWith(configuredRoot) ? normalized : resolve(configuredRoot, normalized.replace(/^\/+/, ""));
  const mappedParent = dirname(mapped);
  return Array.from(new Set([mappedParent, parent, mapped, normalized]));
}

function findSection(libraries: PlexLibrary[], targetPath: string, configuredSectionId?: string) {
  if (configuredSectionId) {
    const explicit = libraries.find((library) => library.key === configuredSectionId);
    if (explicit) return explicit;
  }
  const normalized = resolve(targetPath);
  return libraries.find((library) => library.locations.some((location) => normalized.startsWith(resolve(location))));
}

export async function refreshPlexPath(path: string) {
  const settings = await getSettings();
  if (!settings.plexServerUrl || !settings.plexToken) return { skipped: true, reason: "not_configured" };
  const candidates = pathCandidates(path, settings.plexLibraryPath);
  const key = candidates[0] ?? path;
  const now = Date.now();
  if ((refreshDedup.get(key) ?? 0) > now) return { skipped: true, reason: "deduped" };
  refreshDedup.set(key, now + 30_000);

  const libraries = await listPlexLibraries();
  for (const candidate of candidates) {
    const section = findSection(libraries, candidate, settings.plexSectionId);
    if (!section) continue;
    const query = new URLSearchParams({ path: candidate });
    const response = await plexFetch(`/library/sections/${encodeURIComponent(section.key)}/refresh?${query.toString()}`, { method: "POST" });
    if (!response.ok) throw new Error(`Plex refresh failed with HTTP ${response.status}`);
    return { skipped: false, sectionId: section.key, path: candidate };
  }
  return { skipped: true, reason: "no_matching_section", libraries };
}

export async function testPlexConnection() {
  const libraries = await listPlexLibraries();
  return { ok: true, libraries };
}

export async function startPlexOauth() {
  const settings = await getSettings();
  const clientIdentifier = !settings.plexClientIdentifier || settings.plexClientIdentifier === "drakkar"
    ? `drakkar-${randomUUID()}`
    : settings.plexClientIdentifier;
  if (clientIdentifier !== settings.plexClientIdentifier) {
    await updateSettings({ ...settings, plexClientIdentifier: clientIdentifier });
  }
  const response = await fetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: plexHeaders(undefined, clientIdentifier),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Plex OAuth PIN request failed with HTTP ${response.status}`);
  const data = await response.json() as { id: number; code: string };
  const params = new URLSearchParams({
    clientID: clientIdentifier,
    code: data.code,
    "context[device][product]": PLEX_PRODUCT
  });
  return { pinId: data.id, code: data.code, authUrl: `https://app.plex.tv/auth#?${params.toString()}`, clientIdentifier };
}

export async function pollPlexOauth(pinId: number) {
  const settings = await getSettings();
  const response = await fetch(`https://plex.tv/api/v2/pins/${encodeURIComponent(String(pinId))}`, {
    headers: plexHeaders(undefined, settings.plexClientIdentifier || "drakkar"),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Plex OAuth poll failed with HTTP ${response.status}`);
  const data = await response.json() as { authToken?: string | null };
  if (!data.authToken) return { authorized: false };
  await updateSettings({ ...settings, plexToken: data.authToken });
  return { authorized: true, token: data.authToken };
}

export function plexDefaultLibraryPath() {
  return env.MEDIA_MOVIES_DIR.startsWith("/mnt/") ? "/mnt/media" : env.MEDIA_MOVIES_DIR;
}
