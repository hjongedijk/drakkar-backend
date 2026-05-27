import type { Prisma } from "../../repositories/db/prisma.js";

export const profileTemplates: Prisma.QualityProfileCreateInput[] = [
  { name: "Any", allowedQualities: ["480p", "720p", "1080p", "2160p"], preferredWords: [], rejectedWords: [], requiredWords: [], preferredLanguages: [], requiredLanguages: [] },
  { name: "HD 720p", allowedQualities: ["720p"], cutoffQuality: "720p", preferredWords: [], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: [], requiredLanguages: [] },
  { name: "HD 1080p", allowedQualities: ["1080p"], cutoffQuality: "1080p", preferredWords: [], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: [], requiredLanguages: [] },
  { name: "Ultra HD 2160p", allowedQualities: ["2160p"], cutoffQuality: "2160p", preferredWords: ["hdr", "dolby vision"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: [], requiredLanguages: [] },
  { name: "Remux Preferred", allowedQualities: ["1080p", "2160p"], preferredWords: ["remux"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: [], requiredLanguages: [] },
  { name: "WEB-DL Preferred", allowedQualities: ["720p", "1080p", "2160p"], preferredWords: ["web-dl", "webdl"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: [], requiredLanguages: [] },
  { name: "Small Size", allowedQualities: ["720p", "1080p"], preferredWords: ["x265", "hevc"], rejectedWords: ["remux"], requiredWords: [], maxSize: 8_000_000_000, preferredLanguages: [], requiredLanguages: [] },
  { name: "Anime", allowedQualities: ["720p", "1080p"], preferredWords: ["japanese", "dual"], rejectedWords: ["dubbed-only"], requiredWords: [], preferredLanguages: ["japanese"], requiredLanguages: [] },
  { name: "TV Standard", allowedQualities: ["720p", "1080p"], cutoffQuality: "1080p", preferredWords: ["proper", "repack"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] },
  { name: "Movie Standard", allowedQualities: ["1080p"], cutoffQuality: "1080p", preferredWords: ["web-dl"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] },
  { name: "Movie High Quality", allowedQualities: ["1080p", "2160p"], cutoffQuality: "2160p", preferredWords: ["remux", "hdr", "atmos"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] }
];
