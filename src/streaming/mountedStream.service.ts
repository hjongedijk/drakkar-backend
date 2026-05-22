import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { UsenetServer } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { getPolicySettings } from "../policies/policyService.js";
import { NntpClient } from "../usenet/nntpClient.js";
import { decodeYencBufferLine } from "../usenet/yenc.js";
import { markLibraryItemStreamedByPath } from "../media-library/libraryService.js";
import { planMountedFileRange } from "./rangePlanner.service.js";
import { getMountFileByPath } from "../vfs/mountedNzbService.js";
import { buildDecodedYencSegments } from "./yencManifest.service.js";

const sessionSetKey = "vfs:stream:sessions";
const streamMetricsKey = "vfs:stream:metrics";
const inFlightSegmentFetches = new Map<string, Promise<Buffer>>();
const hotSegmentCache = new Map<string, { value: Buffer; updatedAt: number }>();
const inFlightReadAhead = new Set<string>();
const sessionControllers = new Map<string, AbortController>();
const markedStreamSessions = new Set<string>();
const sessionSnapshots = new Map<string, Record<string, string | number>>();
const pendingSessionUpdates = new Map<string, Record<string, string | number>>();
const pendingMetricIncrements = new Map<string, number>();
let cachedProviders: { value: UsenetServer[]; expiresAt: number } | null = null;
let mountedPool: MountedNntpPool | null = null;
let mountedPoolSignature: string | null = null;
let sessionFlushTimer: NodeJS.Timeout | null = null;
let metricsFlushTimer: NodeJS.Timeout | null = null;

const SESSION_FLUSH_MS = 2000;
const METRICS_FLUSH_MS = 1000;
const STALE_ACTIVE_SESSION_MS = 15_000;

async function collectDecodedArticleBody(client: NntpClient, articleId: string, signal?: AbortSignal) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of client.decodedBodyBufferChunks(articleId, decodeYencBufferLine, signal)) {
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks, total);
}

type MountedPoolSlot = {
  provider: UsenetServer;
  client?: NntpClient;
  connecting?: Promise<void>;
  busy: boolean;
};

type MountedPoolDebugState = {
  slotCount: number;
  connectedSlots: number;
  busySlots: number;
  providers: Array<{
    providerId: string;
    providerName: string;
    configuredConnections: number;
    slotCount: number;
    connectedSlots: number;
    busySlots: number;
  }>;
};

let mountedPoolDebugState: MountedPoolDebugState | null = null;
type MountedReadSession = {
  path: string;
  manifest: MountedFileManifest;
  bufferStart: number;
  buffer: Buffer;
  lastReadEnd: number;
  updatedAt: number;
  reader?: MountedSequentialReader;
};
type MountedSequentialReader = {
  manifest: MountedFileManifest;
  position: number;
  segmentIndex: number;
  iterator?: AsyncIterator<Buffer>;
  remainder?: Buffer;
};
type MountedFileSegment = {
  fileId: string;
  articleId: string;
  segmentNumber: number;
  bytes: number;
  start: number;
  end: number;
};
type MountedFileManifest = {
  path: string;
  fileId: string;
  size: number;
  segments: MountedFileSegment[];
};
const mountedReadSessions = new Map<string, MountedReadSession>();
const mountedPathReadWindows = new Map<string, MountedReadSession>();
const MOUNTED_READ_SESSION_TTL_MS = 2 * 60 * 1000;
const MOUNTED_READ_AHEAD_MAX_BYTES = 16 * 1024 * 1024;
const MOUNTED_RANDOM_ACCESS_WINDOW_BYTES = 512 * 1024;
const MOUNTED_SEQUENTIAL_WINDOW_BYTES = 4 * 1024 * 1024;
// nzbdav keeps a deeper future-article pipeline; a single-segment window stalls too often at segment boundaries.
const STREAM_PREFETCH_SEGMENTS = 4;

class MountedNntpPool {
  private readonly slots: MountedPoolSlot[];
  private readonly waiters: Array<{
    excludedProviders: Set<string>;
    includeBackups: boolean;
    resolve: (slot: MountedPoolSlot) => void;
  }> = [];
  private readonly primaryProviderIds: Set<string>;
  private readonly primaryProviderCount: number;

  constructor(providers: UsenetServer[], maxConnections: number) {
    const slots: MountedPoolSlot[] = [];
    const primaryProviders = providers.filter((provider) => !provider.isBackup);
    this.primaryProviderIds = new Set(primaryProviders.map((provider) => provider.id));
    this.primaryProviderCount = this.primaryProviderIds.size;
    for (const provider of providers) {
      const limit = Math.max(1, Math.min(provider.connections, maxConnections - slots.length));
      for (let index = 0; index < limit; index += 1) slots.push({ provider, busy: false });
      if (slots.length >= maxConnections) break;
    }
    this.slots = slots.length > 0 ? slots : providers.slice(0, 1).map((provider) => ({ provider, busy: false }));
    this.syncDebug();
  }

  async body(articleId: string, signal?: AbortSignal) {
    const errors: string[] = [];
    const permanentFailures = new Set<string>();
    const providerCount = new Set(this.slots.map((slot) => slot.provider.id)).size;
    const maxAttempts = Math.max(providerCount * 4, this.slots.length * 4);
    let includeBackups = this.primaryProviderCount === 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (permanentFailures.size >= providerCount) break;
      const slot = await this.acquire(permanentFailures, includeBackups);
      try {
        await this.ensureConnected(slot, signal);
        if (!slot.client) throw new Error("NNTP slot did not connect");
        return await collectDecodedArticleBody(slot.client, articleId, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown NNTP error";
        errors.push(`${slot.provider.name}: ${message}`);
        await slot.client?.quit().catch(() => undefined);
        slot.client = undefined;
        this.syncDebug();
        if (isProviderConnectionLimit(message) || isTemporaryProviderError(message)) {
          if (attempt < maxAttempts) await sleep(Math.min(10_000, attempt * 750));
        } else {
          permanentFailures.add(slot.provider.id);
          if (!includeBackups && this.allPrimaryProvidersFailed(permanentFailures)) includeBackups = true;
        }
      } finally {
        this.release(slot);
      }
    }

    throw new Error(`all providers failed for ${articleId}: ${errors.join("; ")}`);
  }

  async bodySlice(articleId: string, startOffset: number, length: number, signal?: AbortSignal) {
    const errors: string[] = [];
    const permanentFailures = new Set<string>();
    const providerCount = new Set(this.slots.map((slot) => slot.provider.id)).size;
    const maxAttempts = Math.max(providerCount * 4, this.slots.length * 4);
    let includeBackups = this.primaryProviderCount === 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (permanentFailures.size >= providerCount) break;
      const slot = await this.acquire(permanentFailures, includeBackups);
      try {
        await this.ensureConnected(slot, signal);
        if (!slot.client) throw new Error("NNTP slot did not connect");
        const sliced = await slot.client.bodySlice(articleId, startOffset, length, decodeYencBufferLine, signal);
        slot.client = undefined;
        this.syncDebug();
        return sliced;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown NNTP error";
        errors.push(`${slot.provider.name}: ${message}`);
        await slot.client?.quit().catch(() => undefined);
        slot.client = undefined;
        this.syncDebug();
        if (isProviderConnectionLimit(message) || isTemporaryProviderError(message)) {
          if (attempt < maxAttempts) await sleep(Math.min(10_000, attempt * 750));
        } else {
          permanentFailures.add(slot.provider.id);
          if (!includeBackups && this.allPrimaryProvidersFailed(permanentFailures)) includeBackups = true;
        }
      } finally {
        this.release(slot);
      }
    }

    throw new Error(`all providers failed for ${articleId}: ${errors.join("; ")}`);
  }

  async *stream(articleId: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const errors: string[] = [];
    const permanentFailures = new Set<string>();
    const providerCount = new Set(this.slots.map((slot) => slot.provider.id)).size;
    const maxAttempts = Math.max(providerCount * 4, this.slots.length * 4);
    let includeBackups = this.primaryProviderCount === 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (permanentFailures.size >= providerCount) break;
      const slot = await this.acquire(permanentFailures, includeBackups);
      try {
        await this.ensureConnected(slot, signal);
        if (!slot.client) throw new Error("NNTP slot did not connect");
        for await (const chunk of slot.client.decodedBodyBufferChunks(articleId, decodeYencBufferLine, signal)) {
          yield chunk;
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown NNTP error";
        errors.push(`${slot.provider.name}: ${message}`);
        await slot.client?.quit().catch(() => undefined);
        slot.client = undefined;
        this.syncDebug();
        if (isProviderConnectionLimit(message) || isTemporaryProviderError(message)) {
          if (attempt < maxAttempts) await sleep(Math.min(10_000, attempt * 750));
        } else {
          permanentFailures.add(slot.provider.id);
          if (!includeBackups && this.allPrimaryProvidersFailed(permanentFailures)) includeBackups = true;
        }
      } finally {
        this.release(slot);
      }
    }

    throw new Error(`all providers failed for ${articleId}: ${errors.join("; ")}`);
  }

  async close() {
    await Promise.all(this.slots.map((slot) => slot.client?.quit().catch(() => undefined)));
    mountedPoolDebugState = null;
  }

  async ensureWarm(targetConnections: number, signal?: AbortSignal) {
    const allowedConnections = await getAllowedStreamingConnections();
    const warmTarget = Math.max(0, Math.min(targetConnections, allowedConnections, this.slots.length));
    const coldSlots = this.slots
      .filter((slot) => !slot.client)
      .sort((a, b) => Number(a.provider.isBackup) - Number(b.provider.isBackup))
      .slice(0, Math.max(0, warmTarget - this.slots.filter((slot) => Boolean(slot.client)).length));
    if (coldSlots.length === 0) return;
    await Promise.allSettled(coldSlots.map((slot) => this.ensureConnected(slot, signal)));
  }

  private async acquire(excludedProviders = new Set<string>(), includeBackups = true) {
    const available = (await this.activeSlots()).find(
      (slot) => !slot.busy && !excludedProviders.has(slot.provider.id) && (includeBackups || !slot.provider.isBackup)
    );
    if (available) {
      available.busy = true;
      this.syncDebug();
      return Promise.resolve(available);
    }

    return new Promise<MountedPoolSlot>((resolve) => {
      this.waiters.push({ excludedProviders: new Set(excludedProviders), includeBackups, resolve });
    });
  }

  private async activeSlots() {
    const limit = Math.max(1, Math.min(await getAllowedStreamingConnections(), this.slots.length));
    return this.slots.slice(0, limit);
  }

  private release(slot: MountedPoolSlot) {
    const waiterIndex = this.waiters.findIndex(
      (waiter) => !waiter.excludedProviders.has(slot.provider.id) && (waiter.includeBackups || !slot.provider.isBackup)
    );
    const waiter = waiterIndex >= 0 ? this.waiters.splice(waiterIndex, 1)[0] : undefined;
    if (waiter) {
      slot.busy = true;
      this.syncDebug();
      waiter.resolve(slot);
      return;
    }
    slot.busy = false;
    this.syncDebug();
  }

  private syncDebug() {
    const providerStates = new Map<string, MountedPoolDebugState["providers"][number]>();
    for (const slot of this.slots) {
      const current = providerStates.get(slot.provider.id) ?? {
        providerId: slot.provider.id,
        providerName: slot.provider.name,
        configuredConnections: slot.provider.connections,
        slotCount: 0,
        connectedSlots: 0,
        busySlots: 0
      };
      current.slotCount += 1;
      if (slot.client) current.connectedSlots += 1;
      if (slot.busy) current.busySlots += 1;
      providerStates.set(slot.provider.id, current);
    }
    mountedPoolDebugState = {
      slotCount: this.slots.length,
      connectedSlots: this.slots.filter((slot) => Boolean(slot.client)).length,
      busySlots: this.slots.filter((slot) => slot.busy).length,
      providers: [...providerStates.values()]
    };
  }

  private async ensureConnected(slot: MountedPoolSlot, signal?: AbortSignal) {
    if (slot.client) return;
    if (!slot.connecting) {
      slot.connecting = (async () => {
        const client = new NntpClient(slot.provider);
        await client.connect(signal);
        slot.client = client;
        this.syncDebug();
      })().finally(() => {
        slot.connecting = undefined;
      });
      this.syncDebug();
    }
    await slot.connecting;
  }

  private allPrimaryProvidersFailed(permanentFailures: Set<string>) {
    if (this.primaryProviderCount === 0) return true;
    let failed = 0;
    for (const providerId of this.primaryProviderIds) {
      if (permanentFailures.has(providerId)) failed += 1;
    }
    return failed >= this.primaryProviderCount;
  }
}

export function getMountedPoolDebugState() {
  return mountedPoolDebugState;
}

export async function primeMountedStreamPool() {
  const pool = await getMountedPool();
  void pool.ensureWarm(1);
}

export type StreamSession = {
  id: string;
  path: string;
  range: string;
  status: string;
  bytesSent: number;
  size: number;
  start: number;
  end: number;
  currentOffset: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  source: string;
  userAgent: string;
  fileId?: string;
};

async function getProviders() {
  if (cachedProviders && cachedProviders.expiresAt > Date.now()) return cachedProviders.value;
  const value = await prisma.usenetServer.findMany({
    where: { enabled: true },
    orderBy: [{ isBackup: "asc" }, { priority: "asc" }]
  });
  cachedProviders = { value, expiresAt: Date.now() + 15_000 };
  return value;
}

async function getMountedPool() {
  const providers = await getProviders();
  const policies = await getPolicySettings();
  const providerConnectionTotal = providers.reduce((sum, provider) => sum + provider.connections, 0) || 1;
  const maxConnections = Math.max(
    1,
    Math.min(
      policies.maxStreamingConnections || providerConnectionTotal,
      policies.maxTotalUsenetConnections || providerConnectionTotal,
      providerConnectionTotal
    )
  );
  const desiredSize = Math.min(providerConnectionTotal, maxConnections);
  const nextSignature = JSON.stringify({
    maxConnections: desiredSize,
    providers: providers.map((provider) => ({
      id: provider.id,
      host: provider.host,
      port: provider.port,
      connections: provider.connections,
      enabled: provider.enabled,
      isBackup: provider.isBackup
    }))
  });
  if (!mountedPool || mountedPoolSignature !== nextSignature) {
    await mountedPool?.close().catch(() => undefined);
    mountedPool = new MountedNntpPool(providers, desiredSize);
    mountedPoolSignature = nextSignature;
  }
  return mountedPool;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProviderConnectionLimit(message: string) {
  return /too many connections/i.test(message);
}

function isTemporaryProviderError(message: string) {
  return /too many connections|timeout|temporarily|try again|connection.*reset|econnreset|etimedout/i.test(message);
}

async function getAllowedStreamingConnections() {
  const policies = await getPolicySettings();
  const streams = await listActiveStreamSessions();
  const activeStreamCount = streams.filter((stream) => stream.status === "active").length;
  const streamingShare = activeStreamCount > 0 ? clamp(policies.streamingPriority / 100, 0, 1) : 0;
  const reservedStreamingConnections = activeStreamCount > 0 ? Math.max(1, Math.floor(policies.maxTotalUsenetConnections * streamingShare)) : 0;
  return clamp(Math.min(policies.maxStreamingConnections, reservedStreamingConnections || policies.maxStreamingConnections), 1, policies.maxStreamingConnections);
}

function createAbortError() {
  const error = new Error("stream aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

async function flushMetrics() {
  if (metricsFlushTimer) {
    clearTimeout(metricsFlushTimer);
    metricsFlushTimer = null;
  }
  if (pendingMetricIncrements.size === 0) return;
  const updates = [...pendingMetricIncrements.entries()];
  pendingMetricIncrements.clear();
  const pipeline = redis.multi();
  for (const [field, count] of updates) pipeline.hincrby(streamMetricsKey, field, count);
  await pipeline.exec();
}

function scheduleMetricFlush() {
  if (metricsFlushTimer) return;
  metricsFlushTimer = setTimeout(() => {
    void flushMetrics().catch(() => undefined);
  }, METRICS_FLUSH_MS);
}

async function incrementMetric(field: string, count = 1) {
  pendingMetricIncrements.set(field, (pendingMetricIncrements.get(field) ?? 0) + count);
  scheduleMetricFlush();
}

function segmentCacheKey(fileId: string, segmentNumber: number) {
  return `${fileId}:${segmentNumber}`;
}

function findSegmentIndex(segments: MountedFileSegment[], offset: number) {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (!segment) break;
    if (offset < segment.start) high = mid - 1;
    else if (offset > segment.end) low = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(low, segments.length - 1));
}

async function getMountedFileManifest(path: string): Promise<MountedFileManifest> {
  const mount = await getMountFileByPath(path);
  if (!mount) throw new Error("mounted NZB not found");
  if (!mount.streamable) throw new Error("mounted NZB is not prepared for streaming yet");
  const file = mount.nzbDocument.files[0];
  if (!file) throw new Error("mounted NZB file not found");

  const segments: MountedFileSegment[] = [];
  const decoded = await buildDecodedYencSegments(file, await getProviders());
  let fallbackCursor = 0;
  const sourceSegments = decoded?.segments ?? file.segments.map((segment) => {
    const bytes = Math.floor(segment.bytes);
    const start = fallbackCursor;
    fallbackCursor += bytes;
    return { segment, bytes, start, end: start + bytes - 1 };
  });
  for (const item of sourceSegments) {
    const segment = item.segment;
    const bytes = Math.floor(item.bytes);
    segments.push({
      fileId: file.id,
      articleId: segment.articleId,
      segmentNumber: segment.number,
      bytes,
      start: item.start,
      end: item.end
    });
  }

  return {
    path,
    fileId: file.id,
    size: Math.max(0, Math.floor(decoded?.size ?? file.size)),
    segments
  };
}

function pruneHotCache(maxSizeBytes: number, maxAgeMs: number) {
  const now = Date.now();
  let total = 0;
  for (const [key, entry] of hotSegmentCache) {
    if (now - entry.updatedAt > maxAgeMs) hotSegmentCache.delete(key);
    else total += entry.value.byteLength;
  }

  for (const [key, entry] of hotSegmentCache) {
    if (total <= maxSizeBytes) break;
    hotSegmentCache.delete(key);
    total -= entry.value.byteLength;
  }
}

async function flushSessionUpdates() {
  if (sessionFlushTimer) {
    clearTimeout(sessionFlushTimer);
    sessionFlushTimer = null;
  }
  if (pendingSessionUpdates.size === 0) return;
  const updates = [...pendingSessionUpdates.entries()];
  pendingSessionUpdates.clear();
  const pipeline = redis.multi();
  for (const [sessionId, payload] of updates) {
    const next = {
      ...(sessionSnapshots.get(sessionId) ?? {}),
      ...payload,
      updatedAt: new Date().toISOString()
    };
    sessionSnapshots.set(sessionId, next);
    pipeline.hset(`vfs:stream:session:${sessionId}`, next);
  }
  await pipeline.exec();
}

function scheduleSessionFlush() {
  if (sessionFlushTimer) return;
  sessionFlushTimer = setTimeout(() => {
    void flushSessionUpdates().catch(() => undefined);
  }, SESSION_FLUSH_MS);
}

function sessionField(sessionId: string, field: string) {
  const pending = pendingSessionUpdates.get(sessionId)?.[field];
  if (pending !== undefined) return pending;
  return sessionSnapshots.get(sessionId)?.[field];
}

async function updateSession(sessionId: string, payload: Record<string, string | number>, options?: { force?: boolean }) {
  pendingSessionUpdates.set(sessionId, {
    ...(pendingSessionUpdates.get(sessionId) ?? {}),
    ...payload
  });
  if (options?.force) await flushSessionUpdates();
  else scheduleSessionFlush();
}

function markStreamedOnce(sessionId: string, path: string) {
  const key = `${sessionId}:${path}`;
  if (markedStreamSessions.has(key)) return;
  markedStreamSessions.add(key);
  void markLibraryItemStreamedByPath(path).catch(() => undefined);
}

async function downloadArticle(articleId: string, providers: UsenetServer[], signal?: AbortSignal) {
  throwIfAborted(signal);
  const pool = await getMountedPool();
  const body = await pool.body(articleId, signal);
  await incrementMetric("providerHits");
  return body;
}

async function downloadArticleSlice(input: {
  articleId: string;
  segmentOffset: number;
  length: number;
  pool: MountedNntpPool;
  signal?: AbortSignal;
}) {
  return input.pool.bodySlice(input.articleId, input.segmentOffset, input.length, input.signal);
}

async function getOrFetchSegmentBuffer(input: {
  fileId: string;
  segmentNumber: number;
  articleId: string;
  providers: UsenetServer[];
  signal?: AbortSignal;
}) {
  const policies = await getPolicySettings();
  const cacheKey = segmentCacheKey(input.fileId, input.segmentNumber);
  if (policies.streamCacheEnabled) {
    const hot = hotSegmentCache.get(cacheKey);
    if (hot) {
      hot.updatedAt = Date.now();
      await incrementMetric("memoryCacheHits");
      return hot.value;
    }
  }

  await incrementMetric("cacheMisses");
  const existing = inFlightSegmentFetches.get(cacheKey);
  if (existing) {
    await incrementMetric("dedupedSegmentFetches");
    return existing;
  }

  const fetchPromise = (async () => {
    const decoded = await downloadArticle(input.articleId, input.providers, input.signal);
    if (policies.streamCacheEnabled) {
      hotSegmentCache.set(cacheKey, { value: decoded, updatedAt: Date.now() });
      pruneHotCache(Math.min(policies.streamCacheMaxSizeGb * 1024 * 1024 * 1024, 256 * 1024 * 1024), policies.streamCacheMaxAgeHours * 60 * 60 * 1000);
    }
    return decoded;
  })();

  inFlightSegmentFetches.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightSegmentFetches.delete(cacheKey);
  }
}

async function readManifestWindow(input: {
  manifest: MountedFileManifest;
  start: number;
  length: number;
  providers: UsenetServer[];
  signal?: AbortSignal;
}) {
  if (input.length <= 0 || input.start >= input.manifest.size) return Buffer.alloc(0);
  const safeLength = Math.min(input.length, input.manifest.size - input.start);
  const buffers: Buffer[] = [];
  let total = 0;
  let cursor = input.start;
  let segmentIndex = findSegmentIndex(input.manifest.segments, input.start);

  while (total < safeLength && segmentIndex < input.manifest.segments.length) {
    const segment = input.manifest.segments[segmentIndex];
    if (!segment) break;
    if (cursor > segment.end) {
      segmentIndex += 1;
      continue;
    }
    const segmentOffset = Math.max(0, cursor - segment.start);
    const take = Math.min(safeLength - total, segment.end - cursor + 1);
    const decoded = await getOrFetchSegmentBuffer({
      fileId: segment.fileId,
      segmentNumber: segment.segmentNumber,
      articleId: segment.articleId,
      providers: input.providers,
      signal: input.signal
    });
    const chunk = decoded.subarray(segmentOffset, segmentOffset + take);
    buffers.push(chunk);
    total += chunk.length;
    cursor += chunk.length;
    segmentIndex += 1;
  }

  return Buffer.concat(buffers, total);
}

function warmManifestSegments(input: {
  manifest: MountedFileManifest;
  start: number;
  providers: UsenetServer[];
  signal?: AbortSignal;
  count?: number;
}) {
  const startIndex = findSegmentIndex(input.manifest.segments, input.start);
  const count = input.count ?? STREAM_PREFETCH_SEGMENTS;
  for (let index = startIndex; index < Math.min(input.manifest.segments.length, startIndex + count); index += 1) {
    const segment = input.manifest.segments[index];
    if (!segment) continue;
    void getOrFetchSegmentBuffer({
      fileId: segment.fileId,
      segmentNumber: segment.segmentNumber,
      articleId: segment.articleId,
      providers: input.providers,
      signal: input.signal
    }).catch(() => undefined);
  }
}

async function prefetchMountedFileRange(input: {
  path: string;
  start: number;
  length: number;
  providers: UsenetServer[];
  signal: AbortSignal;
}) {
  if (input.length <= 0 || input.signal.aborted) return;
  const key = `${input.path}:${input.start}:${input.length}`;
  if (inFlightReadAhead.has(key)) return;
  inFlightReadAhead.add(key);
  try {
    const plan = await planMountedFileRange(input.path, `bytes=${input.start}-${input.start + input.length - 1}`);
    await Promise.all(
      plan.ranges.map((range) =>
        getOrFetchSegmentBuffer({
          fileId: range.fileId,
          segmentNumber: range.segmentNumber,
          articleId: range.articleId,
          providers: input.providers,
          signal: input.signal
        })
      )
    );
    await incrementMetric("readAheadBytes", plan.end - plan.start + 1);
    await incrementMetric("readAheadRequests");
  } catch {
    await incrementMetric("readAheadFailures");
  } finally {
    inFlightReadAhead.delete(key);
  }
}

async function readOrFetchSegment(input: {
  fileId: string;
  segmentNumber: number;
  articleId: string;
  providers: UsenetServer[];
  signal?: AbortSignal;
}) {
  return Readable.from(streamSegmentProgressively(input));
}

async function* streamSegmentProgressively(input: {
  fileId: string;
  segmentNumber: number;
  articleId: string;
  providers: UsenetServer[];
  signal?: AbortSignal;
}) {
  const policies = await getPolicySettings();
  const cacheKey = segmentCacheKey(input.fileId, input.segmentNumber);
  if (policies.streamCacheEnabled) {
    const hot = hotSegmentCache.get(cacheKey);
    if (hot) {
      hot.updatedAt = Date.now();
      await incrementMetric("memoryCacheHits");
      yield hot.value;
      return;
    }
  }

  const existing = inFlightSegmentFetches.get(cacheKey);
  if (existing) {
    await incrementMetric("dedupedSegmentFetches");
    yield await existing;
    return;
  }

  await incrementMetric("cacheMisses");
  const deferredState = {} as {
    resolve: (value: Buffer) => void;
    reject: (reason?: unknown) => void;
  };
  const deferred = new Promise<Buffer>((resolve, reject) => {
    deferredState.resolve = resolve;
    deferredState.reject = reject;
  });
  void deferred.catch(() => undefined);
  inFlightSegmentFetches.set(cacheKey, deferred);

  const buffers: Buffer[] = [];
  let total = 0;

  try {
    const pool = await getMountedPool();
    for await (const chunk of pool.stream(input.articleId, input.signal)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffers.push(buffer);
      total += buffer.length;
      yield buffer;
    }
    const complete = Buffer.concat(buffers, total);
    if (policies.streamCacheEnabled) {
      hotSegmentCache.set(cacheKey, { value: complete, updatedAt: Date.now() });
      pruneHotCache(Math.min(policies.streamCacheMaxSizeGb * 1024 * 1024 * 1024, 256 * 1024 * 1024), policies.streamCacheMaxAgeHours * 60 * 60 * 1000);
    }
    await incrementMetric("providerHits");
    deferredState.resolve(complete);
  } catch (error) {
    deferredState.reject(error);
    throw error;
  } finally {
    inFlightSegmentFetches.delete(cacheKey);
  }
}

async function readSegmentSlice(input: {
  fileId: string;
  segmentNumber: number;
  articleId: string;
  segmentOffset: number;
  length: number;
  providers: UsenetServer[];
  signal?: AbortSignal;
}) {
  if (input.segmentOffset === 0 && input.length <= 256 * 1024) {
    const warmFullSegment = getOrFetchSegmentBuffer(input).catch(() => undefined);
    try {
      const pool = await getMountedPool();
      const sliced = await downloadArticleSlice({
        articleId: input.articleId,
        segmentOffset: input.segmentOffset,
        length: input.length,
        pool,
        signal: input.signal
      });
      return Readable.from([sliced]);
    } catch {
      await warmFullSegment;
    }
  }
  const decoded = await getOrFetchSegmentBuffer(input);
  return Readable.from([decoded.subarray(input.segmentOffset, input.segmentOffset + input.length)]);
}

async function* streamPlannedRanges(input: {
  sessionId: string;
  ranges: Awaited<ReturnType<typeof planMountedFileRange>>["ranges"];
  providers: UsenetServer[];
  signal: AbortSignal;
}) {
  const warmDistance = STREAM_PREFETCH_SEGMENTS;
  const warmRange = (index: number) => {
    for (let offset = 1; offset <= warmDistance; offset += 1) {
      const next = input.ranges[index + offset];
      if (!next) break;
      if (next.segmentOffset !== 0 || next.length !== Math.floor(next.bytes)) continue;
      void getOrFetchSegmentBuffer({
        fileId: next.fileId,
        segmentNumber: next.segmentNumber,
        articleId: next.articleId,
        providers: input.providers,
        signal: input.signal
      }).catch(() => undefined);
    }
  };
  let bytesSent = 0;
  try {
    for (const [index, range] of input.ranges.entries()) {
      throwIfAborted(input.signal);
      warmRange(index);
      const source =
        range.segmentOffset === 0 && range.length === Math.floor(range.bytes)
          ? await readOrFetchSegment({
              fileId: range.fileId,
              segmentNumber: range.segmentNumber,
              articleId: range.articleId,
              providers: input.providers,
              signal: input.signal
            })
          : await readSegmentSlice({
              fileId: range.fileId,
              segmentNumber: range.segmentNumber,
              articleId: range.articleId,
              segmentOffset: range.segmentOffset,
              length: range.length,
              providers: input.providers,
              signal: input.signal
            });

      for await (const chunk of source) {
        throwIfAborted(input.signal);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesSent += buffer.length;
        await incrementMetric("bytesServed", buffer.length);
        yield buffer;
      }

      await updateSession(input.sessionId, {
        bytesSent,
        currentOffset: range.readOffset + range.length
      });
    }
  } finally {
    const status = input.signal.aborted ? "cancelled" : "closed";
    await updateSession(input.sessionId, {
      status,
      bytesSent,
      closedAt: new Date().toISOString()
    }, { force: true });
    await redis.expire(`vfs:stream:session:${input.sessionId}`, 300);
    await redis.srem(sessionSetKey, input.sessionId);
    sessionSnapshots.delete(input.sessionId);
    pendingSessionUpdates.delete(input.sessionId);
    sessionControllers.delete(input.sessionId);
  }
}

export async function getOrCreateStreamSession(input: {
  path: string;
  range?: string;
  userAgent?: string;
  source?: "http" | "fuse" | "api";
  sessionId?: string;
}) {
  const sessionId = input.sessionId ?? randomUUID();
  const existingController = sessionControllers.get(sessionId);
  if (existingController) {
    return { id: sessionId, controller: existingController };
  }

  const controller = new AbortController();
  const now = new Date().toISOString();
  sessionControllers.set(sessionId, controller);
  await redis.sadd(sessionSetKey, sessionId);
  const initialState = {
    id: sessionId,
    path: input.path,
    range: input.range ?? "",
    status: "active",
    bytesSent: 0,
    currentOffset: 0,
    createdAt: now,
    updatedAt: now,
    source: input.source ?? "api",
    userAgent: input.userAgent ?? ""
  };
  sessionSnapshots.set(sessionId, initialState);
  await redis.hset(`vfs:stream:session:${sessionId}`, initialState);
  await redis.expire(`vfs:stream:session:${sessionId}`, 3600);
  await incrementMetric("sessionsStarted");
  return { id: sessionId, controller };
}

export async function stopStreamSession(sessionId: string) {
  const controller = sessionControllers.get(sessionId);
  if (controller) controller.abort();
  await updateSession(sessionId, {
    status: "cancelled",
    closedAt: new Date().toISOString()
  }, { force: true });
  await redis.expire(`vfs:stream:session:${sessionId}`, 300);
  await redis.srem(sessionSetKey, sessionId);
  sessionSnapshots.delete(sessionId);
  pendingSessionUpdates.delete(sessionId);
  sessionControllers.delete(sessionId);
  await incrementMetric("sessionsStopped");
  return { ok: true };
}

function pruneMountedReadSessions() {
  const cutoff = Date.now() - MOUNTED_READ_SESSION_TTL_MS;
  for (const [sessionId, session] of mountedReadSessions) {
    if (session.updatedAt < cutoff) mountedReadSessions.delete(sessionId);
  }
  for (const [path, session] of mountedPathReadWindows) {
    if (session.updatedAt < cutoff) mountedPathReadWindows.delete(path);
  }
}

export function closeMountedReadSession(sessionId: string) {
  mountedReadSessions.delete(sessionId);
  void stopStreamSession(sessionId).catch(() => undefined);
}

function readFromMountedWindow(window: MountedReadSession | undefined, input: { path: string; start: number; length: number }) {
  if (
    window &&
    window.path === input.path &&
    input.start >= window.bufferStart &&
    input.start + input.length <= window.bufferStart + window.buffer.length
  ) {
    const offset = input.start - window.bufferStart;
    window.updatedAt = Date.now();
    window.lastReadEnd = input.start + input.length;
    return window.buffer.subarray(offset, offset + input.length);
  }
  return null;
}

function rememberMountedWindow(sessionId: string, session: MountedReadSession) {
  mountedReadSessions.set(sessionId, session);
  mountedPathReadWindows.set(session.path, {
    ...session,
    reader: undefined
  });
}

function createSequentialReader(manifest: MountedFileManifest): MountedSequentialReader {
  return {
    manifest,
    position: 0,
    segmentIndex: 0
  };
}

function resetSequentialReader(reader: MountedSequentialReader, offset: number) {
  reader.position = offset;
  reader.segmentIndex = findSegmentIndex(reader.manifest.segments, offset);
  reader.iterator = undefined;
  reader.remainder = undefined;
}

async function nextSequentialChunk(reader: MountedSequentialReader, signal?: AbortSignal): Promise<Buffer | null> {
  while (reader.position < reader.manifest.size) {
    if (reader.remainder && reader.remainder.length > 0) {
      const chunk = reader.remainder;
      reader.remainder = undefined;
      return chunk;
    }

    const segment = reader.manifest.segments[reader.segmentIndex];
    if (!segment) return null;

    if (!reader.iterator) {
      warmManifestSegments({
        manifest: reader.manifest,
        start: segment.start,
        providers: [],
        signal,
        count: STREAM_PREFETCH_SEGMENTS
      });
      reader.iterator = streamSegmentProgressively({
        fileId: segment.fileId,
        segmentNumber: segment.segmentNumber,
        articleId: segment.articleId,
        providers: [],
        signal
      })[Symbol.asyncIterator]();
    }

    const step = await reader.iterator.next();
    if (!step.done && step.value && step.value.length > 0) {
      return Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
    }

    reader.iterator = undefined;
    reader.segmentIndex += 1;
  }

  return null;
}

async function skipSequentialBytes(reader: MountedSequentialReader, bytes: number, signal?: AbortSignal) {
  let remaining = Math.max(0, bytes);
  while (remaining > 0) {
    const chunk = await nextSequentialChunk(reader, signal);
    if (!chunk || chunk.length === 0) break;
    const take = Math.min(remaining, chunk.length);
    reader.position += take;
    remaining -= take;
    if (take < chunk.length) reader.remainder = chunk.subarray(take);
  }
}

async function seekSequentialReader(reader: MountedSequentialReader, offset: number, signal?: AbortSignal) {
  if (offset === reader.position) return;
  resetSequentialReader(reader, offset);
  const segment = reader.manifest.segments[reader.segmentIndex];
  if (!segment) return;
  const discard = Math.max(0, offset - segment.start);
  if (discard > 0) await skipSequentialBytes(reader, discard, signal);
}

async function readSequentialBytes(reader: MountedSequentialReader, length: number, signal?: AbortSignal) {
  if (length <= 0 || reader.position >= reader.manifest.size) return Buffer.alloc(0);
  const target = Math.min(length, reader.manifest.size - reader.position);
  const buffers: Buffer[] = [];
  let total = 0;

  while (total < target) {
    const chunk = await nextSequentialChunk(reader, signal);
    if (!chunk || chunk.length === 0) break;
    const take = Math.min(target - total, chunk.length);
    buffers.push(chunk.subarray(0, take));
    total += take;
    reader.position += take;
    if (take < chunk.length) reader.remainder = chunk.subarray(take);
  }

  return Buffer.concat(buffers, total);
}

async function readMountedFileRangeRaw(input: {
  path: string;
  start: number;
  length: number;
  sessionId?: string;
  userAgent?: string;
  source?: "http" | "fuse" | "api";
}) {
  const providers = await getProviders();
  const policies = await getPolicySettings();
  const pool = await getMountedPool();
  if (providers.length === 0) throw new Error("No enabled Usenet providers configured");
  if (input.length <= 0) return Buffer.alloc(0);
  await pool.ensureWarm(1);
  void pool.ensureWarm(input.start === 0 ? Math.min(4, await getAllowedStreamingConnections()) : 2);

  const range = `bytes=${input.start}-${input.start + input.length - 1}`;
  const plan = await planMountedFileRange(input.path, range);
  const session = input.sessionId
    ? { id: input.sessionId, controller: sessionControllers.get(input.sessionId) ?? new AbortController() }
    : await getOrCreateStreamSession({
        path: input.path,
        range,
        userAgent: input.userAgent,
        source: input.source ?? "api"
      });
  const ownsSession = !input.sessionId;

  if (!sessionControllers.has(session.id)) sessionControllers.set(session.id, session.controller);
  markStreamedOnce(session.id, input.path);

  try {
    await updateSession(session.id, {
      fileId: plan.fileId,
      size: plan.size,
      start: plan.start,
      end: plan.end,
      currentOffset: plan.start
    }, { force: true });

    const existingBytesSent = Number(sessionField(session.id, "bytesSent") ?? 0);
    const buffers: Buffer[] = [];
    let total = 0;

    for (const segment of plan.ranges) {
      throwIfAborted(session.controller.signal);
      const source =
        segment.segmentOffset === 0 && segment.length === Math.floor(segment.bytes)
          ? await readOrFetchSegment({
              fileId: segment.fileId,
              segmentNumber: segment.segmentNumber,
              articleId: segment.articleId,
              providers,
              signal: session.controller.signal
            })
          : await readSegmentSlice({
              fileId: segment.fileId,
              segmentNumber: segment.segmentNumber,
              articleId: segment.articleId,
              segmentOffset: segment.segmentOffset,
              length: segment.length,
              providers,
              signal: session.controller.signal
            });

      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        buffers.push(buffer);
        total += buffer.length;
      }
    }

    await incrementMetric("bytesServed", total);
    await updateSession(session.id, {
      bytesSent: existingBytesSent + total,
      currentOffset: plan.end + 1
    }, { force: true });

    if (input.source !== "fuse" && policies.streamReadAheadBytes > 0 && plan.end + 1 < plan.size) {
      const readAheadStart = plan.end + 1;
      const readAheadLength = Math.min(policies.streamReadAheadBytes, policies.streamChunkSizeBytes, plan.size - readAheadStart);
      void prefetchMountedFileRange({
        path: input.path,
        start: readAheadStart,
        length: readAheadLength,
        providers,
        signal: session.controller.signal
      });
    }

    return Buffer.concat(buffers, total);
  } finally {
    if (ownsSession) await stopStreamSession(session.id).catch(() => undefined);
  }
}

export async function readMountedFileRange(input: {
  path: string;
  start: number;
  length: number;
  sessionId?: string;
  userAgent?: string;
  source?: "http" | "fuse" | "api";
}) {
  if (input.source !== "fuse" || !input.sessionId) {
    return readMountedFileRangeRaw(input);
  }

  const range = `bytes=${input.start}-${input.start + input.length - 1}`;
  const streamSession = await getOrCreateStreamSession({
    path: input.path,
    range,
    userAgent: input.userAgent,
    source: "fuse",
    sessionId: input.sessionId
  });
  if (!sessionControllers.has(streamSession.id)) sessionControllers.set(streamSession.id, streamSession.controller);
  markStreamedOnce(streamSession.id, input.path);

  pruneMountedReadSessions();
  const cached = mountedReadSessions.get(input.sessionId);
  const sharedCached = mountedPathReadWindows.get(input.path);
  const cachedOut = readFromMountedWindow(cached, input) ?? readFromMountedWindow(sharedCached, input);
  if (cachedOut) {
    const out = cachedOut;
    await incrementMetric("bytesServed", out.length);
    await updateSession(streamSession.id, {
      range,
      path: input.path,
      source: "fuse",
      bytesSent: Number(sessionField(streamSession.id, "bytesSent") ?? 0) + out.length,
      currentOffset: input.start + out.length
    });
    return out;
  }

  const policies = await getPolicySettings();
  const providers = await getProviders();
  const manifest = cached?.path === input.path ? cached.manifest : await getMountedFileManifest(input.path);
  await updateSession(streamSession.id, {
    fileId: manifest.fileId,
    size: manifest.size,
    start: input.start,
    end: Math.min(manifest.size - 1, input.start + input.length - 1),
    currentOffset: input.start,
    range,
    source: "fuse",
    path: input.path,
    status: "active"
  });
  const sequentialRead = Boolean(cached && cached.path === input.path && input.start >= cached.lastReadEnd && input.start - cached.lastReadEnd <= 256 * 1024);
  const reader = cached?.path === input.path && cached.reader ? cached.reader : createSequentialReader(manifest);
  const signal: AbortSignal | undefined = undefined;

  if (sequentialRead || (cached?.reader && input.start === cached.lastReadEnd)) {
    await seekSequentialReader(reader, input.start, signal);
    const out = await readSequentialBytes(reader, input.length, signal);
    rememberMountedWindow(input.sessionId, {
      path: input.path,
      manifest,
      bufferStart: input.start,
      buffer: out,
      lastReadEnd: input.start + out.length,
      updatedAt: Date.now(),
      reader
    });
    await incrementMetric("bytesServed", out.length);
    await updateSession(streamSession.id, {
      bytesSent: Number(sessionField(streamSession.id, "bytesSent") ?? 0) + out.length,
      currentOffset: input.start + out.length
    });
    return out;
  }

  // Plex metadata and chapter probes do many tiny seeks. Keep random access window
  // small, grow only for sequential playback reads.
  const targetWindow = sequentialRead
    ? Math.max(
        input.length,
        Math.min(Math.max(policies.streamChunkSizeBytes, 1 * 1024 * 1024), MOUNTED_SEQUENTIAL_WINDOW_BYTES)
      )
    : Math.max(input.length, MOUNTED_RANDOM_ACCESS_WINDOW_BYTES);
  const fetchLength = Math.min(targetWindow, MOUNTED_READ_AHEAD_MAX_BYTES);
  warmManifestSegments({
    manifest,
    start: input.start,
    providers,
    signal,
    count: STREAM_PREFETCH_SEGMENTS
  });
  const window = await readManifestWindow({
    manifest,
    start: input.start,
    length: fetchLength,
    providers,
    signal
  });
  rememberMountedWindow(input.sessionId, {
    path: input.path,
    manifest,
    bufferStart: input.start,
    buffer: window,
    lastReadEnd: input.start + Math.min(input.length, window.length),
    updatedAt: Date.now(),
    reader
  });
  const out = window.subarray(0, Math.min(input.length, window.length));
  await incrementMetric("bytesServed", out.length);
  await updateSession(streamSession.id, {
    bytesSent: Number(sessionField(streamSession.id, "bytesSent") ?? 0) + out.length,
    currentOffset: input.start + out.length
  });
  return out;
}

export async function streamMountedFile(path: string, range?: string, options?: { userAgent?: string; source?: "http" | "fuse" | "api" }) {
  const providers = await getProviders();
  const pool = await getMountedPool();
  if (providers.length === 0) throw new Error("No enabled Usenet providers configured");
  await pool.ensureWarm(1);
  void pool.ensureWarm(Math.min(2, await getAllowedStreamingConnections()));

  const plan = await planMountedFileRange(path, range);
  const session = await getOrCreateStreamSession({
    path,
    range,
    userAgent: options?.userAgent,
    source: options?.source ?? "http"
  });

  await updateSession(session.id, {
    fileId: plan.fileId,
    size: plan.size,
    start: plan.start,
    end: plan.end
  }, { force: true });
  markStreamedOnce(session.id, path);

  const stream = Readable.from(
    streamPlannedRanges({
      sessionId: session.id,
      ranges: plan.ranges,
      providers,
      signal: session.controller.signal
    })
  );
  stream.once("close", () => {
    void stopStreamSession(session.id).catch(() => undefined);
  });
  stream.once("error", () => {
    void stopStreamSession(session.id).catch(() => undefined);
  });

  return {
    stream,
    start: plan.start,
    end: plan.end,
    size: plan.size,
    partial: Boolean(range),
    sessionId: session.id
  };
}

export async function listActiveStreamSessions() {
  const ids = await redis.smembers(sessionSetKey);
  const sessions = await Promise.all(ids.map((id) => redis.hgetall(`vfs:stream:session:${id}`)));
  const now = Date.now();
  const staleActiveIds = sessions
    .filter((session) => {
      if (!session.id || (session.status ?? "active") !== "active") return false;
      const updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
      return Number.isFinite(updatedAt) && now - updatedAt > STALE_ACTIVE_SESSION_MS;
    })
    .map((session) => session.id as string);
  for (const sessionId of staleActiveIds) {
    await stopStreamSession(sessionId).catch(() => undefined);
  }
  const inactiveIds = sessions
    .filter((session) => session.id && session.status && session.status !== "active")
    .map((session) => session.id as string);
  if (inactiveIds.length > 0) {
    await redis.srem(sessionSetKey, ...inactiveIds);
  }
  return sessions
    .filter((session) => session.id && (session.status ?? "active") === "active")
    .map((session): StreamSession => ({
      id: session.id ?? "",
      path: session.path ?? "",
      range: session.range ?? "",
      status: session.status ?? "active",
      createdAt: session.createdAt ?? "",
      updatedAt: session.updatedAt ?? "",
      closedAt: session.closedAt || undefined,
      source: session.source ?? "",
      userAgent: session.userAgent ?? "",
      fileId: session.fileId || undefined,
      ...session,
      bytesSent: Number(session.bytesSent ?? 0),
      size: Number(session.size ?? 0),
      start: Number(session.start ?? 0),
      end: Number(session.end ?? 0),
      currentOffset: Number(session.currentOffset ?? 0)
    }));
}

export async function getStreamMetrics() {
  await Promise.all([flushMetrics(), flushSessionUpdates()]);
  const [rawMetrics, sessions] = await Promise.all([redis.hgetall(streamMetricsKey), listActiveStreamSessions()]);
  return {
    activeStreamCount: sessions.filter((session) => session.status === "active").length,
    bytesServed: Number(rawMetrics.bytesServed ?? 0),
    cacheHits: Number(rawMetrics.cacheHits ?? 0),
    memoryCacheHits: Number(rawMetrics.memoryCacheHits ?? 0),
    cacheMisses: Number(rawMetrics.cacheMisses ?? 0),
    dedupedSegmentFetches: Number(rawMetrics.dedupedSegmentFetches ?? 0),
    readAheadBytes: Number(rawMetrics.readAheadBytes ?? 0),
    readAheadRequests: Number(rawMetrics.readAheadRequests ?? 0),
    readAheadFailures: Number(rawMetrics.readAheadFailures ?? 0),
    providerHits: Number(rawMetrics.providerHits ?? 0),
    sessionsStarted: Number(rawMetrics.sessionsStarted ?? 0),
    sessionsStopped: Number(rawMetrics.sessionsStopped ?? 0),
    sessions
  };
}
