import type { UsenetServer } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { NntpClient } from "../usenet/nntpClient.js";

export type DecodedManifestSegment<TSegment> = {
  segment: TSegment;
  bytes: number;
  start: number;
  end: number;
};

type SegmentLike = {
  number: number;
  bytes: number;
  articleId: string;
};

type FileLike<TSegment extends SegmentLike> = {
  id: string;
  nzbDocumentId?: string;
  size: number;
  segments: TSegment[];
};

type YencPartInfo = {
  fileSize?: number;
  partOffset?: number;
  partSize?: number;
};

const yencHeaderCache = new Map<string, { value: YencPartInfo | null; expiresAt: number }>();
const loggedCorrections = new Set<string>();
const HEADER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function parseAttributes(line?: string) {
  const attrs: Record<string, string> = {};
  if (!line) return attrs;
  for (const match of line.matchAll(/([a-zA-Z]+)=("[^"]+"|\S+)/g)) {
    attrs[match[1]!] = match[2]!.replace(/^"|"$/g, "");
  }
  return attrs;
}

function parseYencPartInfo(input: { ybegin?: string; ypart?: string; yend?: string }): YencPartInfo | null {
  const begin = parseAttributes(input.ybegin);
  const part = parseAttributes(input.ypart);
  const end = parseAttributes(input.yend);
  const fileSize = Number(begin.size ?? end.size);
  const beginOffset = Number(part.begin);
  const endOffset = Number(part.end);
  const partSize = Number(end.size);

  if (Number.isFinite(beginOffset) && Number.isFinite(endOffset) && endOffset >= beginOffset) {
    return {
      fileSize: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : undefined,
      partOffset: beginOffset - 1,
      partSize: endOffset - beginOffset + 1
    };
  }

  if (Number.isFinite(fileSize) && fileSize > 0 && Number.isFinite(partSize) && partSize > 0) {
    return { fileSize, partOffset: 0, partSize };
  }

  return null;
}

async function fetchYencPartInfo(articleId: string, providers: UsenetServer[], signal?: AbortSignal) {
  const errors: string[] = [];
  for (const provider of providers) {
    const client = new NntpClient(provider);
    try {
      await client.connect(signal);
      return parseYencPartInfo(await client.yencPartHeader(articleId, signal));
    } catch (error) {
      errors.push(`${provider.name}: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      await client.quit().catch(() => undefined);
    }
  }
  if (errors.length > 0) console.warn(`[stream] yEnc header probe failed for ${articleId}: ${errors.join("; ")}`);
  return null;
}

async function getYencPartInfo(fileId: string, segment: SegmentLike, providers: UsenetServer[], signal?: AbortSignal) {
  const key = `${fileId}:${segment.number}:${segment.articleId}`;
  const cached = yencHeaderCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await fetchYencPartInfo(segment.articleId, providers, signal);
  yencHeaderCache.set(key, { value, expiresAt: Date.now() + HEADER_CACHE_TTL_MS });
  return value;
}

async function persistDecodedSize(file: FileLike<SegmentLike>, decodedSize: number) {
  if (!Number.isFinite(decodedSize) || decodedSize <= 0 || Math.floor(file.size) === decodedSize) return;
  await prisma.nzbFile.update({ where: { id: file.id }, data: { size: decodedSize } }).catch(() => undefined);
  if (file.nzbDocumentId) {
    await prisma.nzbDocument.update({ where: { id: file.nzbDocumentId }, data: { totalSize: decodedSize } }).catch(() => undefined);
  }
}

export async function buildDecodedYencSegments<TSegment extends SegmentLike>(
  file: FileLike<TSegment>,
  providers: UsenetServer[],
  signal?: AbortSignal
): Promise<{ size: number; segments: Array<DecodedManifestSegment<TSegment>> } | null> {
  const ordered = [...file.segments].sort((a, b) => a.number - b.number);
  const first = ordered[0];
  if (!first || providers.length === 0) return null;

  const firstInfo = await getYencPartInfo(file.id, first, providers, signal);
  if (
    !firstInfo ||
    !Number.isFinite(firstInfo.fileSize) ||
    !Number.isFinite(firstInfo.partSize) ||
    !Number.isFinite(firstInfo.partOffset) ||
    firstInfo.fileSize! <= 0 ||
    firstInfo.partSize! <= 0 ||
    firstInfo.partOffset !== 0
  ) {
    return null;
  }

  const size = Math.floor(firstInfo.fileSize!);
  const partSize = Math.floor(firstInfo.partSize!);
  const segments: Array<DecodedManifestSegment<TSegment>> = [];
  for (const [index, segment] of ordered.entries()) {
    const start = index * partSize;
    if (start >= size) break;
    const bytes = Math.min(partSize, size - start);
    segments.push({ segment, bytes, start, end: start + bytes - 1 });
  }

  if (segments.length === 0) return null;
  if (!loggedCorrections.has(file.id) && Math.floor(file.size) !== size) {
    loggedCorrections.add(file.id);
    console.info(`[stream] yEnc decoded size corrected for ${file.id}: nzbBytes=${Math.floor(file.size)} decodedBytes=${size}`);
  }
  void persistDecodedSize(file, size);
  return { size, segments };
}

