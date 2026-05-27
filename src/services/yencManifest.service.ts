import { prisma, type UsenetServer } from "../repositories/db/prisma.js";
import { NntpClient } from "../services/usenet/nntpClient.js";

export type DecodedManifestSegment<TSegment> = {
  segment: TSegment;
  bytes: number;
  start: number;
  end: number;
};

type BuildDecodedManifestMode = "exact" | "fast";

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

type DecodedManifestCacheValue<TSegment extends SegmentLike> = {
  size: number;
  segments: Array<DecodedManifestSegment<TSegment>>;
};

const yencHeaderCache = new Map<string, { value: YencPartInfo | null; expiresAt: number }>();
const decodedManifestCache = new Map<string, { value: DecodedManifestCacheValue<SegmentLike> | null; expiresAt: number }>();
const loggedCorrections = new Set<string>();
const HEADER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DECODED_MANIFEST_CACHE_TTL_MS = 30 * 60 * 1000;
const LOG_YENC_SIZE_CORRECTIONS = process.env.LOG_YENC_SIZE_CORRECTIONS === "true";
const YENC_HEADER_PROBE_CONCURRENCY = 1;
const YENC_PROBE_COOLDOWN_MS = 5 * 60 * 1000;
const providerProbeCooldownUntil = new Map<string, number>();
let lastProbeConnectionLimitLogAt = 0;

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isProviderConnectionLimit(message: string) {
  return /too many connections|502/i.test(message);
}

function isTransientProbeAbort(message: string) {
  return /nntp operation aborted|abort/i.test(message);
}

function providerCoolingDown(providerId: string) {
  return (providerProbeCooldownUntil.get(providerId) ?? 0) > Date.now();
}

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
  let connectionLimited = false;
  for (const provider of providers) {
    if (providerCoolingDown(provider.id)) continue;
    const client = new NntpClient(provider);
    try {
      await client.connect(signal);
      return parseYencPartInfo(await client.yencPartHeader(articleId, signal));
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      errors.push(`${provider.name}: ${message}`);
      if (isProviderConnectionLimit(message) || isTransientProbeAbort(message)) {
        connectionLimited = true;
        providerProbeCooldownUntil.set(provider.id, Date.now() + YENC_PROBE_COOLDOWN_MS);
      }
    } finally {
      await client.quit().catch(() => undefined);
    }
  }
  if (errors.length > 0) {
    if (connectionLimited) {
      if (Date.now() - lastProbeConnectionLimitLogAt > 60_000) {
        lastProbeConnectionLimitLogAt = Date.now();
        console.warn(oneLine(`[stream] yEnc header probing cooled down after provider connection-limit errors: ${errors.join("; ")}`));
      }
    } else {
      console.warn(oneLine(`[stream] yEnc header probe failed for ${articleId}: ${errors.join("; ")}`));
    }
  }
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

async function mapWithConcurrency<TInput, TOutput>(
  values: TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>
) {
  const results = new Array<TOutput>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]!, index);
    }
  }
  const count = Math.max(1, Math.min(concurrency, values.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
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
  signal?: AbortSignal,
  options?: { mode?: BuildDecodedManifestMode }
): Promise<{ size: number; segments: Array<DecodedManifestSegment<TSegment>> } | null> {
  const ordered = [...file.segments].sort((a, b) => a.number - b.number);
  const first = ordered[0];
  if (!first || providers.length === 0) return null;
  const mode = options?.mode ?? "exact";
  const manifestCacheKey = `${file.id}:${mode}`;
  const cachedManifest = decodedManifestCache.get(manifestCacheKey);
  if (cachedManifest && cachedManifest.expiresAt > Date.now()) {
    return cachedManifest.value as { size: number; segments: Array<DecodedManifestSegment<TSegment>> } | null;
  }

  if (mode === "exact") {
    const exactPartInfo = await mapWithConcurrency(
      ordered,
      YENC_HEADER_PROBE_CONCURRENCY,
      async (segment) => ({ segment, info: await getYencPartInfo(file.id, segment, providers, signal) })
    );
    const exactSegments = exactPartInfo
      .filter((entry) =>
        Number.isFinite(entry.info?.partOffset)
        && Number.isFinite(entry.info?.partSize)
        && (entry.info?.partSize ?? 0) > 0
      )
      .map((entry) => {
        const start = Math.floor(entry.info!.partOffset!);
        const bytes = Math.floor(entry.info!.partSize!);
        return {
          segment: entry.segment,
          bytes,
          start,
          end: start + bytes - 1
        };
      })
      .sort((a, b) => a.start - b.start);
    const exactSize = Math.max(
      ...exactPartInfo
        .map((entry) => Number(entry.info?.fileSize))
        .filter((value) => Number.isFinite(value) && value > 0),
      0
    );
    if (exactSegments.length === ordered.length && exactSize > 0) {
      if (LOG_YENC_SIZE_CORRECTIONS && !loggedCorrections.has(file.id) && Math.floor(file.size) !== exactSize) {
        loggedCorrections.add(file.id);
        console.info(`[stream] yEnc decoded size corrected for ${file.id}: nzbBytes=${Math.floor(file.size)} decodedBytes=${exactSize}`);
      }
      const value = { size: exactSize, segments: exactSegments };
      decodedManifestCache.set(manifestCacheKey, { value: value as DecodedManifestCacheValue<SegmentLike>, expiresAt: Date.now() + DECODED_MANIFEST_CACHE_TTL_MS });
      void persistDecodedSize(file, exactSize);
      return value;
    }
  }

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

  if (segments.length === 0) {
    decodedManifestCache.set(manifestCacheKey, { value: null, expiresAt: Date.now() + Math.min(DECODED_MANIFEST_CACHE_TTL_MS, 5 * 60 * 1000) });
    return null;
  }
  if (LOG_YENC_SIZE_CORRECTIONS && !loggedCorrections.has(file.id) && Math.floor(file.size) !== size) {
    loggedCorrections.add(file.id);
    console.info(`[stream] yEnc decoded size corrected for ${file.id}: nzbBytes=${Math.floor(file.size)} decodedBytes=${size}`);
  }
  decodedManifestCache.set(manifestCacheKey, {
    value: { size, segments } as DecodedManifestCacheValue<SegmentLike>,
    expiresAt: Date.now() + DECODED_MANIFEST_CACHE_TTL_MS
  });
  void persistDecodedSize(file, size);
  return { size, segments };
}
