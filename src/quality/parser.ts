import type { Release } from "../releases/types.js";

export type ParsedQuality = Pick<
  Release,
  | "resolution"
  | "source"
  | "codec"
  | "audio"
  | "hdr"
  | "dv"
  | "language"
  | "season"
  | "episode"
  | "releaseGroup"
  | "isRepack"
  | "isProper"
  | "isRemux"
> & {
  title?: string;
  year?: number;
  episodeEnd?: number;
  isDaily: boolean;
  isSeasonPack: boolean;
  isMultiEpisode: boolean;
  mediaHint: "movie" | "tv" | "unknown";
  suspicious: boolean;
  passworded: boolean;
};

const sourcePatterns: Array<[string, RegExp]> = [
  ["cam", /\b(cam|hdcam)\b/i],
  ["telesync", /\b(ts|telesync)\b/i],
  ["screener", /\b(dvdscr|screener|scr)\b/i],
  ["bluray", /\b(blu-?ray|uhd|bdrip|brrip)\b/i],
  ["webdl", /\b(web-?dl|webrip\.?dl)\b/i],
  ["webrip", /\bweb-?rip\b/i],
  ["hdtv", /\bhdtv\b/i],
  ["dvdrip", /\bdvd-?rip\b/i],
  ["hdrip", /\bhd-?rip\b/i],
  ["remux", /\bremux\b/i]
];

function cleanTitleStem(value: string) {
  return value
    .replace(/^\s*\[[^\]]*?\b(?:bdrip|bluray|web[- .]?dl|webrip|1080p|2160p|720p|hevc|x26[45]|h\.?26[45]|av1|dts|aac|flac|hdr|dv)\b[^\]]*]\s*/gi, "")
    .replace(/\s*\[[^\]]*?\b(?:bdrip|bluray|web[- .]?dl|webrip|1080p|2160p|720p|hevc|x26[45]|h\.?26[45]|av1|dts|aac|flac|hdr|dv)\b[^\]]*]\s*$/gi, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[-\s]+$/g, "")
    .trim();
}

export function parseReleaseTitle(title: string): ParsedQuality {
  const multiEpisode =
    title.match(/\bS(?<season>\d{1,3})E(?<episode>\d{1,4})(?:E(?<episodeEnd>\d{1,4})|[- .]E?(?<episodeEndAlt>\d{1,4}))\b/i) ??
    title.match(/\b(?<season>\d{1,3})x(?<episode>\d{1,4})(?:-|x)(?<episodeEnd>\d{1,4})\b/i);
  const seasonEpisode =
    multiEpisode ??
    title.match(/\bS(?<season>\d{1,3})E(?<episode>\d{1,4})\b/i) ??
    title.match(/\b(?<season>\d{1,3})x(?<episode>\d{1,4})\b/i) ??
    title.match(/\bEP?(?<episode>\d{2,4})\b/i);
  const seasonPack = !seasonEpisode
    ? title.match(/\bS(?<season>\d{1,3})(?![ ._-]*E\d{1,4})\b/i)
    : null;
  const daily = title.match(/\b(?<year>(?:19|20)\d{2})[ ._-](?<month>0[1-9]|1[0-2])[ ._-](?<day>0[1-9]|[12]\d|3[01])\b/i);
  const year = title.match(/\b(19\d{2}|20\d{2})\b/)?.[0];
  const releaseGroup = title.match(/-([A-Z0-9][A-Z0-9._-]{1,})$/i)?.[1];
  const source = sourcePatterns.find(([, pattern]) => pattern.test(title))?.[0];
  const resolutionMatch = title.match(/\b(2160p|1080p|720p|480p|4k|uhd)\b/i)?.[1]?.toLowerCase();
  const titleStem = cleanTitleStem(
    seasonEpisode?.index != null
      ? title.slice(0, seasonEpisode.index)
      : seasonPack?.index != null
        ? title.slice(0, seasonPack.index)
        : daily?.index != null
          ? title.slice(0, daily.index)
          : title.match(/\b(19\d{2}|20\d{2})\b/)?.index != null
            ? title.slice(0, title.match(/\b(19\d{2}|20\d{2})\b/)!.index)
            : title
  );
  const episodeEnd = multiEpisode?.groups?.episodeEnd ?? multiEpisode?.groups?.episodeEndAlt;
  const mediaHint =
    seasonEpisode || seasonPack || daily
      ? "tv"
      : year
        ? "movie"
        : "unknown";

  return {
    title: titleStem || undefined,
    resolution: resolutionMatch === "4k" || resolutionMatch === "uhd" ? "2160p" : resolutionMatch,
    source,
    codec: title.match(/\b(x265|h\.?265|hevc|x264|h\.?264|av1|xvid)\b/i)?.[1]?.replace(".", "").toLowerCase(),
    audio: title.match(/\b(TrueHD|Atmos|DTS-?HD|DTS|DDP?5\.1|AAC|FLAC)\b/i)?.[1],
    hdr: /\b(HDR10\+?|HDR)\b/i.test(title),
    dv: /\b(DV|Dolby Vision)\b/i.test(title),
    language: normalizeLanguage(title.match(/\b(MULTI|DUAL|GERMAN|DEUTSCH|FRENCH|SPANISH|JAPANESE|ENGLISH|DUTCH|NEDERLANDS|NL)\b/i)?.[1]),
    season: seasonEpisode?.groups?.season
      ? Number(seasonEpisode.groups.season)
      : seasonPack?.groups?.season
        ? Number(seasonPack.groups.season)
        : undefined,
    episode: seasonEpisode?.groups?.episode ? Number(seasonEpisode.groups.episode) : undefined,
    episodeEnd: episodeEnd ? Number(episodeEnd) : undefined,
    year: daily?.groups?.year ? Number(daily.groups.year) : year ? Number(year) : undefined,
    releaseGroup,
    isRepack: /\b(repack|rerip)\b/i.test(title),
    isProper: /\bproper\b/i.test(title),
    isRemux: /\bremux\b/i.test(title),
    isDaily: Boolean(daily),
    isSeasonPack: Boolean(seasonPack),
    isMultiEpisode: Boolean(multiEpisode),
    mediaHint,
    suspicious: /\b(fake|sample|subpack|readnfo)\b/i.test(title),
    passworded: /\b(password|encrypted)\b/i.test(title)
  };
}

function normalizeLanguage(value?: string) {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "deutsch") return "german";
  if (normalized === "nederlands" || normalized === "nl") return "dutch";
  return normalized;
}

export function enrichRelease(release: Omit<Release, "hdr" | "dv" | "isRepack" | "isProper" | "isRemux" | "rawAttributes"> & { rawAttributes?: Record<string, unknown> }): Release {
  const parsed = parseReleaseTitle(release.title);
  return {
    ...release,
    resolution: release.resolution ?? parsed.resolution,
    source: release.source ?? parsed.source,
    codec: release.codec ?? parsed.codec,
    audio: release.audio ?? parsed.audio,
    hdr: parsed.hdr,
    dv: parsed.dv,
    language: release.language ?? parsed.language,
    season: release.season ?? parsed.season,
    episode: release.episode ?? parsed.episode,
    releaseGroup: release.releaseGroup ?? parsed.releaseGroup,
    isRepack: parsed.isRepack,
    isProper: parsed.isProper,
    isRemux: parsed.isRemux,
    rawAttributes: release.rawAttributes ?? {}
  };
}
