import { extname, basename } from "node:path";

export type ArchiveKind = "rar" | "rar-part" | "zip" | "7z" | "none";

const mediaExtensions = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".ts"]);
const subtitleExtensions = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);
const junkExtensions = new Set([".nfo", ".sfv", ".txt"]);

export function detectArchive(path: string): ArchiveKind {
  const name = basename(path).toLowerCase();
  if (/\.part0*1\.rar$/.test(name)) return "rar-part";
  if (name.endsWith(".rar")) return "rar";
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".7z")) return "7z";
  return "none";
}

export function isMediaFile(path: string) {
  return mediaExtensions.has(extname(path).toLowerCase());
}

export function isSubtitleFile(path: string) {
  return subtitleExtensions.has(extname(path).toLowerCase());
}

export function isJunkFile(path: string) {
  const name = basename(path).toLowerCase();
  if (junkExtensions.has(extname(name))) return true;
  return name.includes("sample") || name.includes("proof");
}
