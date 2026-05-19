function safeFilename(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 180) || "downloaded-file";
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/gi, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripPostingPrefixes(value: string) {
  return value
    .replace(/^\s*\[\s*\d+\s*(?:\/|\s)\s*\d+\s*\]\s*-?\s*/i, "")
    .replace(/^\s*\d+\]\s*-?\s*/i, "")
    .replace(/^\s*"+/, "")
    .trim();
}

export function filenameFromSubject(subject: string, index: number) {
  const normalized = stripPostingPrefixes(decodeHtmlEntities(subject));
  const quoted = normalized.match(/"([^"]+\.(?:mkv|mp4|avi|mov|m4v|ts|srt|ass|ssa|vtt|sub))"/i)?.[1];
  if (quoted) return safeFilename(quoted);

  const beforeYenc = normalized.replace(/\byEnc\b.*$/i, "");
  const mediaLike = beforeYenc.match(/([A-Za-z0-9][^<>:"/\\|?*\r\n]+\.(?:mkv|mp4|avi|mov|m4v|ts|srt|ass|ssa|vtt|sub))/i)?.[1];
  if (mediaLike) return safeFilename(mediaLike);

  return safeFilename(beforeYenc) || `file-${index + 1}.bin`;
}
