import type { QualityProfile } from "../../repositories/db/prisma.js";
import { parseReleaseTitle } from "./parser.js";
import type { Release } from "../releases/types.js";

const neutralMultiLanguages = new Set(["multi", "dual"]);

const resolutionBaseScore: Record<string, number> = {
  "480p": 110,
  "720p": 150,
  "1080p": 180,
  "2160p": 220
};

const servarrSourceScoreByResolution: Record<string, Partial<Record<string, number>>> = {
  "480p": {
    webdl: 11,
    webrip: 11,
    bluray: 12,
    remux: 13,
    hdtv: 10,
    dvdrip: 9,
    hdrip: 9
  },
  "720p": {
    hdtv: 14,
    webdl: 15,
    webrip: 15,
    bluray: 16,
    remux: 17
  },
  "1080p": {
    hdtv: 17,
    webdl: 18,
    webrip: 18,
    bluray: 19,
    remux: 20
  },
  "2160p": {
    hdtv: 21,
    webdl: 22,
    webrip: 22,
    bluray: 23,
    remux: 24
  }
};

const fallbackSourceScore: Partial<Record<string, number>> = {
  cam: -100,
  telesync: -90,
  screener: -80,
  dvdrip: 9,
  hdrip: 9,
  hdtv: 14,
  webdl: 15,
  webrip: 15,
  bluray: 16,
  remux: 17
};

const codecScore: Record<string, number> = {
  x264: 4,
  h264: 4,
  x265: 8,
  h265: 8,
  hevc: 8,
  av1: 9
};

const resolutionRank: Record<string, number> = {
  "480p": 1,
  "720p": 2,
  "1080p": 3,
  "2160p": 4
};

export type ReleaseScore = {
  accepted: boolean;
  score: number;
  reasons: string[];
  parsed: ReturnType<typeof parseReleaseTitle>;
};

function includesWord(words: string[], title: string) {
  const lower = title.toLowerCase();
  return words.filter((word) => lower.includes(word.toLowerCase()));
}

function languageAllowed(language: string | undefined, allowed: string[]) {
  if (allowed.length === 0) return true;
  if (!language) return true;
  const normalized = allowed.map((item) => item.toLowerCase());
  return normalized.includes(language) || neutralMultiLanguages.has(language);
}

function effectiveSource(input: {
  source?: string;
  isRemux?: boolean;
}) {
  if (input.isRemux) return "remux";
  return input.source;
}

function servarrQualityScore(input: {
  resolution?: string;
  source?: string;
  isRemux?: boolean;
}) {
  const source = effectiveSource(input);
  const resolution = input.resolution;
  const resolutionScore = resolution ? resolutionBaseScore[resolution] ?? 0 : 0;
  if (!source) return resolutionScore;
  const sourceScore = resolution
    ? servarrSourceScoreByResolution[resolution]?.[source] ?? fallbackSourceScore[source] ?? 0
    : fallbackSourceScore[source] ?? 0;
  return resolutionScore + sourceScore;
}

function sizeHeuristicScore(input: {
  size: number;
  resolution?: string;
  mediaHint: "movie" | "tv" | "unknown";
}) {
  if (!Number.isFinite(input.size) || input.size <= 0 || !input.resolution) return 0;
  const gb = input.size / (1024 ** 3);
  if (input.mediaHint === "movie") {
    if (input.resolution === "1080p") {
      if (gb < 2.5) return -20;
      if (gb < 4) return -8;
      if (gb >= 10) return 8;
    }
    if (input.resolution === "2160p") {
      if (gb < 8) return -25;
      if (gb >= 20) return 10;
    }
  }
  if (input.mediaHint === "tv") {
    if (input.resolution === "1080p" && gb < 0.5) return -12;
    if (input.resolution === "720p" && gb < 0.25) return -8;
  }
  return 0;
}

export function scoreRelease(release: Release, profile: QualityProfile): ReleaseScore {
  const parsed = parseReleaseTitle(release.title);
  const reasons: string[] = [];
  let score = 0;

  const resolution = release.resolution ?? parsed.resolution;
  const source = release.source ?? parsed.source;
  const codec = release.codec ?? parsed.codec;
  const language = release.language ?? parsed.language;
  const size = release.size ?? 0;
  const effective = effectiveSource({ source, isRemux: release.isRemux || parsed.isRemux });
  const minimumAllowedResolution = profile.allowedQualities.reduce<string | null>((current, quality) => {
    if (!current) return quality;
    return (resolutionRank[quality] ?? 0) < (resolutionRank[current] ?? 0) ? quality : current;
  }, null);

  if (!resolution) reasons.push("release resolution is unknown");
  if (resolution && !profile.allowedQualities.includes(resolution)) reasons.push(`quality ${resolution} is not allowed`);
  if (resolution && minimumAllowedResolution && (resolutionRank[resolution] ?? 0) < (resolutionRank[minimumAllowedResolution] ?? 0)) {
    reasons.push(`quality ${resolution} is below minimum ${minimumAllowedResolution}`);
  }
  if (profile.minSize && size < Number(profile.minSize)) reasons.push("release is below minimum size");
  if (profile.maxSize && size > Number(profile.maxSize)) reasons.push("release is above maximum size");
  if (!profile.allowHDR && (release.hdr || parsed.hdr)) reasons.push("HDR is not allowed");
  if (!profile.allowDV && (release.dv || parsed.dv)) reasons.push("Dolby Vision is not allowed");
  if (!profile.allowRemux && (release.isRemux || parsed.isRemux)) reasons.push("remux is not allowed");
  if (!profile.allowBluRay && effective === "bluray") reasons.push("BluRay is not allowed");
  if (!profile.allowWebDL && effective === "webdl") reasons.push("WEB-DL is not allowed");
  if (!profile.allowWebRip && effective === "webrip") reasons.push("WEBRip is not allowed");
  if (!profile.allowX264 && (codec === "x264" || codec === "h264")) reasons.push("x264 is not allowed");
  if (!profile.allowX265 && (codec === "x265" || codec === "h265" || codec === "hevc")) reasons.push("x265/HEVC is not allowed");
  if (!profile.allowAV1 && codec === "av1") reasons.push("AV1 is not allowed");
  if (!profile.allowMultiAudio && (language === "multi" || language === "dual")) reasons.push("multi-audio release rejected");
  if (profile.rejectCam && effective === "cam") reasons.push("cam release rejected");
  if (profile.rejectTelesync && effective === "telesync") reasons.push("telesync release rejected");
  if (profile.rejectScreener && effective === "screener") reasons.push("screener release rejected");
  if (profile.rejectPassworded && parsed.passworded) reasons.push("passworded release rejected");
  if (profile.rejectSuspicious && parsed.suspicious) reasons.push("suspicious release rejected");

  for (const word of includesWord(profile.rejectedWords, release.title)) reasons.push(`rejected word: ${word}`);
  for (const word of profile.requiredWords) {
    if (!release.title.toLowerCase().includes(word.toLowerCase())) reasons.push(`missing required word: ${word}`);
  }
  for (const lang of profile.requiredLanguages) {
    if (!languageAllowed(language, profile.requiredLanguages)) {
      reasons.push(`missing required language: ${lang}`);
      break;
    }
  }
  if (profile.preferredLanguages.length > 0 && !languageAllowed(language, profile.preferredLanguages)) {
    reasons.push(`language ${language} is not preferred`);
  }

  score += servarrQualityScore({
    resolution,
    source: effective,
    isRemux: release.isRemux || parsed.isRemux
  });
  score += codec ? codecScore[codec] ?? 0 : 0;
  score += sizeHeuristicScore({
    size,
    resolution,
    mediaHint: parsed.mediaHint
  });
  score += language && languageAllowed(language, profile.preferredLanguages) ? 12 : 0;
  score += includesWord(profile.preferredWords, release.title).length * 8;
  if (profile.preferProper && (release.isProper || parsed.isProper)) score += 6;
  if (profile.preferRepack && (release.isRepack || parsed.isRepack)) score += 6;
  if (release.seeders) score += Math.min(release.seeders, 25);

  const accepted = reasons.length === 0;
  return { accepted, score: accepted ? score : score - 1000, reasons, parsed };
}
