import { basename } from "node:path";

function filenameFromResponse(url: string, disposition: string | null) {
  const match = disposition?.match(/filename="?([^"]+)"?/i);
  if (match?.[1]) return match[1];
  return basename(new URL(url).pathname) || "download.nzb";
}

export async function fetchNzbUrl(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`NZB URL returned HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());
  const textStart = buffer.subarray(0, Math.min(buffer.length, 200)).toString("utf8").toLowerCase();
  const looksLikeNzb = contentType.includes("xml") || contentType.includes("nzb") || textStart.includes("<nzb");
  return { buffer, contentType, looksLikeNzb, filename: filenameFromResponse(url, response.headers.get("content-disposition")) };
}
