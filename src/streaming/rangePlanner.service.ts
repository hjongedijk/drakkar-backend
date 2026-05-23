import { getMountFileByPath } from "../vfs/mountedNzbService.js";
import { prisma } from "../db/prisma.js";
import { buildDecodedYencSegments } from "./yencManifest.service.js";
import { getStoredArchiveEntryByPath } from "../archive/rarStoredIndex.js";

export type PlannedArticleRange = {
  fileId: string;
  articleId: string;
  segmentNumber: number;
  segmentOffset: number;
  readOffset: number;
  length: number;
  bytes: number;
};

export type PlannedStreamRange = {
  path: string;
  fileId: string;
  start: number;
  end: number;
  size: number;
  ranges: PlannedArticleRange[];
};

export function normalizeRange(range: string | undefined, size: number) {
  if (size <= 0) return { start: 0, end: 0 };
  if (!range) return { start: 0, end: size - 1 };

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) throw new Error("invalid range header");

  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (!rawStart && !rawEnd) throw new Error("invalid range header");

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) throw new Error("invalid range suffix");
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) throw new Error("invalid range bounds");
  if (start >= size) throw new Error("range start exceeds file size");
  if (end < start) throw new Error("invalid range bounds");
  return { start, end: Math.min(end, size - 1) };
}

export async function planMountedFileRange(path: string, range?: string): Promise<PlannedStreamRange> {
  const archiveEntry = await getStoredArchiveEntryByPath(path);
  if (archiveEntry) {
    const { start, end } = normalizeRange(range, archiveEntry.size);
    const ranges: PlannedArticleRange[] = [];
    for (const segment of archiveEntry.segments) {
      if (segment.end < start) continue;
      if (segment.start > end) break;
      const readStart = Math.max(start, segment.start);
      const readEnd = Math.min(end, segment.end);
      ranges.push({
        fileId: segment.fileId,
        articleId: segment.articleId,
        segmentNumber: segment.segmentNumber,
        segmentOffset: segment.sourceOffset + (readStart - segment.start),
        readOffset: readStart,
        length: readEnd - readStart + 1,
        bytes: segment.bytes
      });
    }
    return { path, fileId: `archive:${archiveEntry.documentId}:${archiveEntry.name}`, start, end, size: archiveEntry.size, ranges };
  }

  const mount = await getMountFileByPath(path);
  if (!mount) throw new Error("mounted NZB not found");
  if (!mount.streamable) throw new Error("mounted NZB is not prepared for streaming yet");

  const file = mount.nzbDocument.files[0];
  if (!file) throw new Error("mounted NZB file not found");

  const providers = await prisma.usenetServer.findMany({
    where: { enabled: true },
    orderBy: [{ isBackup: "asc" }, { priority: "asc" }]
  });
  const decoded = await buildDecodedYencSegments(file, providers);
  const size = Math.max(0, Math.floor(decoded?.size ?? file.size));
  const { start, end } = normalizeRange(range, size);
  const ranges: PlannedArticleRange[] = [];
  let cursor = 0;
  const sourceSegments = decoded?.segments ?? file.segments.map((segment) => {
    const bytes = Math.floor(segment.bytes);
    const segmentStart = cursor;
    const segmentEnd = cursor + bytes - 1;
    cursor = segmentEnd + 1;
    return { segment, bytes, start: segmentStart, end: segmentEnd };
  });

  for (const item of sourceSegments) {
    const segmentStart = item.start;
    const segmentEnd = item.end;
    if (segmentEnd < start) continue;
    if (segmentStart > end) break;

    const readStart = Math.max(start, segmentStart);
    const readEnd = Math.min(end, segmentEnd);
    ranges.push({
      fileId: file.id,
      articleId: item.segment.articleId,
      segmentNumber: item.segment.number,
      segmentOffset: readStart - segmentStart,
      readOffset: readStart,
      length: readEnd - readStart + 1,
      bytes: item.bytes
    });
  }

  return { path, fileId: file.id, start, end, size, ranges };
}
