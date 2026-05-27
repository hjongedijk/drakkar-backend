import type { Release } from "./types.js";

const archiveWords = /\b(rar|rars|archive|archived|part0?1|multi[\s._-]?part|passworded|extract(?:ion)?)\b/i;
const archiveExtensions = /\.(?:rar|part\d+\.rar|7z|zip)(?:\b|$)/i;
const directVideoWords = /\.(?:mkv|mp4|avi|mov|m4v|ts)(?:\b|$)/i;

export function looksLikeArchiveRelease(release: Pick<Release, "title" | "category" | "rawAttributes">) {
  const haystack = [
    release.title,
    release.category,
    ...Object.values(release.rawAttributes ?? {}).map((value) => String(value))
  ].join(" ");
  if (directVideoWords.test(haystack)) return false;
  return archiveExtensions.test(haystack) || archiveWords.test(haystack);
}
