import type { Prisma } from "../../repositories/db/prisma.js";

export const profileTemplates: Prisma.QualityProfileCreateInput[] = [
  { name: "HD 720p", allowedQualities: ["720p"], cutoffQuality: "720p", preferredWords: ["web-dl", "webdl"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] },
  { name: "HD 1080p", allowedQualities: ["1080p"], cutoffQuality: "1080p", preferredWords: ["web-dl", "webdl", "bluray"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] },
  { name: "Ultra HD 2160p", allowedQualities: ["2160p"], cutoffQuality: "2160p", preferredWords: ["hdr", "dolby vision", "remux"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] },
  { name: "TV Standard", allowedQualities: ["720p", "1080p", "2160p"], cutoffQuality: "2160p", preferredWords: ["proper", "repack", "web-dl", "webdl", "bluray"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] },
  { name: "Movie Standard", allowedQualities: ["720p", "1080p", "2160p"], cutoffQuality: "2160p", preferredWords: ["bluray", "web-dl", "webdl"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] },
  { name: "Movie High Quality", allowedQualities: ["1080p", "2160p"], cutoffQuality: "2160p", preferredWords: ["remux", "hdr", "atmos", "bluray"], rejectedWords: ["cam"], requiredWords: [], preferredLanguages: ["english", "dutch"], requiredLanguages: [] }
];
