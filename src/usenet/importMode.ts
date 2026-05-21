import { filenameFromSubject } from "./filename.js";

export type NzbImportMode = "mounted" | "materialized";

function isLikelyMediaSubject(subject: string) {
  return /\.(mkv|mp4|avi|mov|m4v|ts)(?:["_\s).]|$)/i.test(subject);
}

function isArchiveSubject(subject: string) {
  return /\.(zip|7z(?:\.\d+)?|rar|part\d+\.rar)(?:["_\s).]|$)/i.test(subject);
}

export function classifyNzbImportMode(nzb: { files: Array<{ subject: string }> }): NzbImportMode {
  let hasDirectVideo = false;
  let hasArchivePayload = false;

  for (const [index, file] of nzb.files.entries()) {
    const filename = filenameFromSubject(file.subject, index);
    if (isLikelyMediaSubject(filename)) hasDirectVideo = true;
    else if (isArchiveSubject(filename)) hasArchivePayload = true;
  }

  if (hasArchivePayload || !hasDirectVideo) return "materialized";
  return "mounted";
}
