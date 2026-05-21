function safeFilename(name: string) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^_+|_+$/g, "")
    .trim()
    .slice(0, 180) || "downloaded-file";
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
    .replace(/"+\s*$/g, "")
    .trim();
}

export function filenameFromSubject(subject: string, index: number) {
  const normalized = stripPostingPrefixes(decodeHtmlEntities(subject));
  const quoted = normalized.match(/"([^"]+\.(?:mkv|mp4|avi|mov|m4v|ts|srt|ass|ssa|vtt|sub))"(?!\.)/i)?.[1];
  if (quoted) return safeFilename(quoted);

  const quotedFull = normalized.match(/"([^"]+)"/)?.[1];
  if (quotedFull && /\.(?:par2|zip|7z(?:\.\d+)?|rar|part\d+\.rar)$/i.test(quotedFull)) return safeFilename(quotedFull);

  const beforeYenc = normalized.replace(/\byEnc\b.*$/i, "").replace(/"+/g, "").trim();
  const par2Like = beforeYenc.match(/([A-Za-z0-9][^<>:"/\\|?*\r\n]+\.(?:par2))(?:\s|$)/i)?.[1];
  if (par2Like) return safeFilename(par2Like);
  const archiveLike = beforeYenc.match(/([A-Za-z0-9][^<>:"/\\|?*\r\n]+\.(?:zip|7z(?:\.\d+)?|rar|part\d+\.rar))(?:\s|$)/i)?.[1];
  if (archiveLike) return safeFilename(archiveLike);
  const mediaLike = beforeYenc.match(/([A-Za-z0-9][^<>:"/\\|?*\r\n]+\.(?:mkv|mp4|avi|mov|m4v|ts|srt|ass|ssa|vtt|sub))(?!\.[A-Za-z0-9])/i)?.[1];
  if (mediaLike) return safeFilename(mediaLike);

  return safeFilename(beforeYenc) || `file-${index + 1}.bin`;
}
