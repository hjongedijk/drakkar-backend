import { extname, join, normalize, relative } from "node:path";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { canonicalizeDisplayTitle } from "../media-library/identity.js";

export const namingSettingsSchema = z.object({
  movieFolderFormat: z.string().min(1).default("{title} ({year}) {tmdb-{tmdbId}}"),
  movieFileFormat: z.string().min(1).default("{title} ({year})"),
  tvFolderFormat: z.string().min(1).default("{title} ({year}) {tvdb-{tvdbId}}"),
  seasonFolderFormat: z.string().min(1).default("Season {season:00}"),
  episodeFileFormat: z.string().min(1).default("{title} - s{season:00}e{episode:00}")
});

export type NamingSettings = z.infer<typeof namingSettingsSchema>;

export type NamingMedia = {
  mediaType: string;
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
};

export const DEFAULT_NAMING_SETTINGS: NamingSettings = {
  movieFolderFormat: "{title} ({year}) {tmdb-{tmdbId}}",
  movieFileFormat: "{title} ({year})",
  tvFolderFormat: "{title} ({year}) {tvdb-{tvdbId}}",
  seasonFolderFormat: "Season {season:00}",
  episodeFileFormat: "{title} - s{season:00}e{episode:00}"
};

const NAMING_KEY = "naming";
const reservedDeviceNamePattern = /^(aux|com[1-9]|con|lpt[1-9]|nul|prn)(\.|$)/i;
const duplicateSeparatorPattern = /([- ._])\1+/g;

async function getSetting<T>(key: string, fallback: T) {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  return row.value as T;
}

export async function getNamingSettings() {
  const stored = { ...(await getSetting(NAMING_KEY, {})) } as Partial<NamingSettings>;
  const migrated = {
    ...stored,
    movieFolderFormat: stored.movieFolderFormat === "{title} ({year})" ? DEFAULT_NAMING_SETTINGS.movieFolderFormat : stored.movieFolderFormat,
    tvFolderFormat: stored.tvFolderFormat === "{title}" ? DEFAULT_NAMING_SETTINGS.tvFolderFormat : stored.tvFolderFormat,
    episodeFileFormat: stored.episodeFileFormat === "{title} - S{season:00}E{episode:00}" ? DEFAULT_NAMING_SETTINGS.episodeFileFormat : stored.episodeFileFormat
  };
  return namingSettingsSchema.parse({ ...DEFAULT_NAMING_SETTINGS, ...migrated });
}

export async function updateNamingSettings(input: unknown) {
  const naming = namingSettingsSchema.parse({ ...DEFAULT_NAMING_SETTINGS, ...(input as object) });
  await prisma.setting.upsert({
    where: { key: NAMING_KEY },
    update: { value: naming },
    create: { key: NAMING_KEY, value: naming }
  });
  return naming;
}

export function cleanPathPart(value: string) {
  const cleaned = value
    .replace(/\\/g, "+")
    .replace(/\//g, "+")
    .replace(/[<>|"\x00-\x1F]+/g, "")
    .replace(/[:]/g, " - ")
    .replace(/[?]/g, "!")
    .replace(/[*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(duplicateSeparatorPattern, (_match, separator: string) => separator)
    .replace(/[- ._]+$/g, "")
    .trim() || "Unknown";
  return reservedDeviceNamePattern.test(cleaned) ? `_${cleaned}` : cleaned;
}

function tokenValue(media: NamingMedia, token: string, format?: string) {
  const value = media[token as keyof NamingMedia];
  if (typeof value === "number" && format === "00") return String(value).padStart(2, "0");
  if (value === undefined || value === null || value === "") return token === "year" ? "Unknown Year" : "Unknown";
  if (token === "title") return canonicalizeDisplayTitle(String(value), media.year);
  return String(value);
}

export function applyNamingTemplate(template: string, media: NamingMedia) {
  const withLiteralIds = template
    .replace(/\{tmdb-\{tmdbId\}\}/g, media.tmdbId ? `{tmdb-${media.tmdbId}}` : "")
    .replace(/\{tvdb-\{tvdbId\}\}/g, media.tvdbId ? `{tvdb-${media.tvdbId}}` : "");
  return cleanPathPart(
    withLiteralIds.replace(/\{([a-zA-Z]+)(?::([^}]+))?\}/g, (_match, token: string, format: string | undefined) =>
      tokenValue(media, token, format)
    )
  );
}

export function completedPathFor(input: { media: NamingMedia; sourcePath: string; naming: NamingSettings }) {
  const ext = extname(input.sourcePath);
  if (input.media.mediaType === "tv") {
    const show = applyNamingTemplate(input.naming.tvFolderFormat, input.media);
    const season = applyNamingTemplate(input.naming.seasonFolderFormat, input.media);
    const episode = applyNamingTemplate(input.naming.episodeFileFormat, input.media);
    return join(env.VFS_COMPLETED_DIR, "tv", show, season, `${episode}${ext}`);
  }

  const folder = applyNamingTemplate(input.naming.movieFolderFormat, input.media);
  const file = applyNamingTemplate(input.naming.movieFileFormat, input.media);
  return join(env.VFS_COMPLETED_DIR, "movies", folder, `${file}${ext}`);
}

export function libraryPathFor(input: { media: NamingMedia; completedPath: string; naming: NamingSettings; strategy?: string }) {
  const ext = input.strategy === "strm" ? ".strm" : extname(input.completedPath);
  if (input.media.mediaType === "tv") {
    const show = applyNamingTemplate(input.naming.tvFolderFormat, input.media);
    const season = applyNamingTemplate(input.naming.seasonFolderFormat, input.media);
    const episode = applyNamingTemplate(input.naming.episodeFileFormat, input.media);
    return join(env.MEDIA_TV_DIR, show, season, `${episode}${ext}`);
  }

  const folder = applyNamingTemplate(input.naming.movieFolderFormat, input.media);
  const file = applyNamingTemplate(input.naming.movieFileFormat, input.media);
  return join(env.MEDIA_MOVIES_DIR, folder, `${file}${ext}`);
}

export function completedPathToVfsPath(completedPath: string) {
  const rel = relative(env.VFS_ROOT, normalize(completedPath));
  if (rel.startsWith("..")) return null;
  return `/${rel.replace(/\\/g, "/")}`;
}

export async function previewNaming(input: { media?: Partial<NamingMedia>; sourcePath?: string; strategy?: string }) {
  const naming = await getNamingSettings();
  const media: NamingMedia = {
    mediaType: input.media?.mediaType ?? "movie",
    title: input.media?.title ?? "Example Movie",
    year: input.media?.year ?? 2026,
    season: input.media?.season ?? 1,
    episode: input.media?.episode ?? 1
  };
  const sourcePath = input.sourcePath ?? "/downloads/Example.Movie.2026.1080p.mkv";
  const completedPath = completedPathFor({ media, sourcePath, naming });
  const libraryPath = libraryPathFor({ media, completedPath, naming, strategy: input.strategy });
  return { naming, media, completedPath, libraryPath };
}
