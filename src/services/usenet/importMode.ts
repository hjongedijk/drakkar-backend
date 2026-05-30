import { filenameFromSubject } from "./filename.js";

export type NzbImportMode = "mounted" | "unsupported";
export type NzbImportPlan = {
  mode: NzbImportMode;
  reason?: "archive_payload" | "no_direct_video";
};

function isLikelyMediaSubject(subject: string) {
  return /\.(mkv|mp4|avi|mov|m4v|ts)(?:["_\s).]|$)/i.test(subject);
}

function isArchiveSubject(subject: string) {
  return /\.(zip|7z(?:\.\d+)?|rar|part\d+\.rar)(?:["_\s).]|$)/i.test(subject);
}

export function classifyNzbImportPlan(nzb: { files: Array<{ subject: string }> }): NzbImportPlan {
  let hasDirectVideo = false;
  let hasArchivePayload = false;

  for (const [index, file] of nzb.files.entries()) {
    const filename = filenameFromSubject(file.subject, index);
    if (isLikelyMediaSubject(filename)) hasDirectVideo = true;
    else if (isArchiveSubject(filename)) hasArchivePayload = true;
  }

  if (hasArchivePayload) return { mode: "mounted", reason: "archive_payload" };
  if (!hasDirectVideo) return { mode: "unsupported", reason: "no_direct_video" };
  return { mode: "mounted" };
}

export function classifyNzbImportMode(nzb: { files: Array<{ subject: string }> }): NzbImportMode {
  return classifyNzbImportPlan(nzb).mode;
}
