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
  year?: number;
  suspicious: boolean;
  passworded: boolean;
};

const sourcePatterns: Array<[string, RegExp]> = [
  ["cam", /\b(cam|hdcam)\b/i],
  ["telesync", /\b(ts|telesync)\b/i],
  ["screener", /\b(dvdscr|screener|scr)\b/i],
  ["bluray", /\b(blu-?ray|bdrip|brrip)\b/i],
  ["webdl", /\b(web-?dl|webrip\.?dl)\b/i],
  ["webrip", /\bweb-?rip\b/i],
  ["hdtv", /\bhdtv\b/i]
];

export function parseReleaseTitle(title: string): ParsedQuality {
  const seasonEpisode = title.match(/\bS(?<season>\d{1,2})E(?<episode>\d{1,3})\b/i);
  const year = title.match(/\b(19\d{2}|20\d{2})\b/)?.[0];
  const releaseGroup = title.match(/-([A-Za-z0-9]+)$/)?.[1];
  const source = sourcePatterns.find(([, pattern]) => pattern.test(title))?.[0];

  return {
    resolution: title.match(/\b(2160p|1080p|720p|480p)\b/i)?.[1]?.toLowerCase(),
    source,
    codec: title.match(/\b(x265|h\.?265|hevc|x264|h\.?264|av1)\b/i)?.[1]?.replace(".", "").toLowerCase(),
    audio: title.match(/\b(TrueHD|Atmos|DTS-?HD|DTS|DDP?5\.1|AAC|FLAC)\b/i)?.[1],
    hdr: /\b(HDR10\+?|HDR)\b/i.test(title),
    dv: /\b(DV|Dolby Vision)\b/i.test(title),
    language: title.match(/\b(MULTI|DUAL|GERMAN|FRENCH|SPANISH|JAPANESE|ENGLISH)\b/i)?.[1]?.toLowerCase(),
    season: seasonEpisode?.groups?.season ? Number(seasonEpisode.groups.season) : undefined,
    episode: seasonEpisode?.groups?.episode ? Number(seasonEpisode.groups.episode) : undefined,
    year: year ? Number(year) : undefined,
    releaseGroup,
    isRepack: /\b(repack|rerip)\b/i.test(title),
    isProper: /\bproper\b/i.test(title),
    isRemux: /\bremux\b/i.test(title),
    suspicious: /\b(fake|sample|subpack|readnfo)\b/i.test(title),
    passworded: /\b(password|encrypted)\b/i.test(title)
  };
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
