import type { QualityProfile } from "@prisma/client";
import { parseReleaseTitle } from "./parser.js";
import type { Release } from "../releases/types.js";

const qualityScore: Record<string, number> = { "480p": 10, "720p": 40, "1080p": 70, "2160p": 100 };
const sourceScore: Record<string, number> = { cam: -100, telesync: -90, screener: -50, hdtv: 5, webrip: 15, webdl: 25, bluray: 35 };
const codecScore: Record<string, number> = { x264: 5, h264: 5, x265: 12, h265: 12, hevc: 12, av1: 10 };
const neutralMultiLanguages = new Set(["multi", "dual"]);

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

export function scoreRelease(release: Release, profile: QualityProfile): ReleaseScore {
  const parsed = parseReleaseTitle(release.title);
  const reasons: string[] = [];
  let score = 0;

  const resolution = release.resolution ?? parsed.resolution;
  const source = release.source ?? parsed.source;
  const codec = release.codec ?? parsed.codec;
  const language = release.language ?? parsed.language;
  const size = release.size ?? 0;

  if (resolution && !profile.allowedQualities.includes(resolution)) reasons.push(`quality ${resolution} is not allowed`);
  if (profile.minSize && size < Number(profile.minSize)) reasons.push("release is below minimum size");
  if (profile.maxSize && size > Number(profile.maxSize)) reasons.push("release is above maximum size");
  if (!profile.allowHDR && (release.hdr || parsed.hdr)) reasons.push("HDR is not allowed");
  if (!profile.allowDV && (release.dv || parsed.dv)) reasons.push("Dolby Vision is not allowed");
  if (!profile.allowRemux && (release.isRemux || parsed.isRemux)) reasons.push("remux is not allowed");
  if (!profile.allowBluRay && source === "bluray") reasons.push("BluRay is not allowed");
  if (!profile.allowWebDL && source === "webdl") reasons.push("WEB-DL is not allowed");
  if (!profile.allowWebRip && source === "webrip") reasons.push("WEBRip is not allowed");
  if (!profile.allowX264 && (codec === "x264" || codec === "h264")) reasons.push("x264 is not allowed");
  if (!profile.allowX265 && (codec === "x265" || codec === "h265" || codec === "hevc")) reasons.push("x265/HEVC is not allowed");
  if (!profile.allowAV1 && codec === "av1") reasons.push("AV1 is not allowed");
  if (!profile.allowMultiAudio && (language === "multi" || language === "dual")) reasons.push("multi-audio release rejected");
  if (profile.rejectCam && source === "cam") reasons.push("cam release rejected");
  if (profile.rejectTelesync && source === "telesync") reasons.push("telesync release rejected");
  if (profile.rejectScreener && source === "screener") reasons.push("screener release rejected");
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

  score += resolution ? qualityScore[resolution] ?? 0 : 0;
  score += source ? sourceScore[source] ?? 0 : 0;
  score += codec ? codecScore[codec] ?? 0 : 0;
  score += language && languageAllowed(language, profile.preferredLanguages) ? 20 : 0;
  score += includesWord(profile.preferredWords, release.title).length * 10;
  if (profile.preferProper && (release.isProper || parsed.isProper)) score += 8;
  if (profile.preferRepack && (release.isRepack || parsed.isRepack)) score += 8;
  if (release.seeders) score += Math.min(release.seeders, 50);

  const accepted = reasons.length === 0;
  return { accepted, score: accepted ? score : score - 1000, reasons, parsed };
}
