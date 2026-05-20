import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { UsenetServer } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { getPolicySettings } from "../policies/policyService.js";
import { NntpClient } from "../usenet/nntpClient.js";
import { decodeArticleBody } from "../usenet/yenc.js";
import { markLibraryItemStreamedByPath } from "../media-library/libraryService.js";
import { planMountedFileRange } from "./rangePlanner.service.js";

const sessionSetKey = "vfs:stream:sessions";
const streamMetricsKey = "vfs:stream:metrics";
const inFlightSegmentFetches = new Map<string, Promise<Buffer>>();
const hotSegmentCache = new Map<string, { value: Buffer; updatedAt: number }>();
const inFlightReadAhead = new Set<string>();
const sessionControllers = new Map<string, AbortController>();
const markedStreamSessions = new Set<string>();
let cachedProviders: { value: UsenetServer[]; expiresAt: number } | null = null;
let mountedPool: MountedNntpPool | null = null;
let mountedPoolSignature: string | null = null;

type MountedPoolSlot = {
  provider: UsenetServer;
  client?: NntpClient;
  busy: boolean;
};

class MountedNntpPool {
  private readonly slots: MountedPoolSlot[];
  private readonly waiters: Array<{ excludedProviders: Set<string>; resolve: (slot: MountedPoolSlot) => void }> = [];

  constructor(providers: UsenetServer[], maxConnections: number) {
    const slots: MountedPoolSlot[] = [];
    for (const provider of providers) {
      const limit = Math.max(1, Math.min(provider.connections, maxConnections - slots.length));
      for (let index = 0; index < limit; index += 1) slots.push({ provider, busy: false });
      if (slots.length >= maxConnections) break;
    }
    this.slots = slots.length > 0 ? slots : providers.slice(0, 1).map((provider) => ({ provider, busy: false }));
  }

  async body(articleId: string, signal?: AbortSignal) {
    const errors: string[] = [];
    const permanentFailures = new Set<string>();
    const providerCount = new Set(this.slots.map((slot) => slot.provider.id)).size;
    const maxAttempts = Math.max(providerCount, this.slots.length * 2);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (permanentFailures.size >= providerCount) break;
      const slot = await this.acquire(permanentFailures);
      try {
        if (!slot.client) {
          slot.client = new NntpClient(slot.provider);
          await slot.client.connect(signal);
        }
        return await slot.client.body(articleId, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown NNTP error";
        errors.push(`${slot.provider.name}: ${message}`);
        await slot.client?.quit().catch(() => undefined);
        slot.client = undefined;
        permanentFailures.add(slot.provider.id);
      } finally {
        this.release(slot);
      }
    }

    throw new Error(`all providers failed for ${articleId}: ${errors.join("; ")}`);
  }

  async close() {
    await Promise.all(this.slots.map((slot) => slot.client?.quit().catch(() => undefined)));
  }

  private acquire(excludedProviders = new Set<string>()) {
    const available = this.slots.find((slot) => !slot.busy && !excludedProviders.has(slot.provider.id));
    if (available) {
      available.busy = true;
      return Promise.resolve(available);
    }

    return new Promise<MountedPoolSlot>((resolve) => {
      this.waiters.push({ excludedProviders: new Set(excludedProviders), resolve });
    });
  }

  private release(slot: MountedPoolSlot) {
    const waiterIndex = this.waiters.findIndex((waiter) => !waiter.excludedProviders.has(slot.provider.id));
    const waiter = waiterIndex >= 0 ? this.waiters.splice(waiterIndex, 1)[0] : undefined;
    if (waiter) {
      slot.busy = true;
      waiter.resolve(slot);
      return;
    }
    slot.busy = false;
  }
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
  const maxConnections = Math.max(1, policies.maxTotalUsenetConnections || providers.reduce((sum, provider) => sum + provider.connections, 0) || 1);
  const desiredSize = Math.min(providers.reduce((sum, provider) => sum + provider.connections, 0) || 1, maxConnections);
  const nextSignature = JSON.stringify({
    maxConnections: desiredSize,
    providers: providers.map((provider) => ({
      id: provider.id,
      host: provider.host,
      port: provider.port,
      connections: provider.connections,
      enabled: provider.enabled
    }))
  });
  if (!mountedPool || mountedPoolSignature !== nextSignature) {
    await mountedPool?.close().catch(() => undefined);
    mountedPool = new MountedNntpPool(providers, desiredSize);
    mountedPoolSignature = nextSignature;
  }
  return mountedPool;
}

function createAbortError() {
  const error = new Error("stream aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

async function incrementMetric(field: string, count = 1) {
  await redis.hincrby(streamMetricsKey, field, count);
}

function segmentCacheKey(fileId: string, segmentNumber: number) {
  return `${fileId}:${segmentNumber}`;
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

async function updateSession(sessionId: string, payload: Record<string, string | number>) {
  await redis.hset(`vfs:stream:session:${sessionId}`, {
    ...payload,
    updatedAt: new Date().toISOString()
  });
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
  return decodeArticleBody(body);
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
  const decoded = await getOrFetchSegmentBuffer(input);
  return Readable.from([decoded]);
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
  const decoded = await getOrFetchSegmentBuffer(input);
  return Readable.from([decoded.subarray(input.segmentOffset, input.segmentOffset + input.length)]);
}

async function* streamPlannedRanges(input: {
  sessionId: string;
  ranges: Awaited<ReturnType<typeof planMountedFileRange>>["ranges"];
  providers: UsenetServer[];
  signal: AbortSignal;
}) {
  let bytesSent = 0;
  try {
    for (const range of input.ranges) {
      throwIfAborted(input.signal);
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
    await redis.hset(`vfs:stream:session:${input.sessionId}`, {
      status,
      bytesSent,
      updatedAt: new Date().toISOString(),
      closedAt: new Date().toISOString()
    });
    await redis.expire(`vfs:stream:session:${input.sessionId}`, 300);
    await redis.srem(sessionSetKey, input.sessionId);
    sessionControllers.delete(input.sessionId);
  }
}

export async function getOrCreateStreamSession(input: {
  path: string;
  range?: string;
  userAgent?: string;
  source?: "http" | "fuse" | "api";
}) {
  const controller = new AbortController();
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  sessionControllers.set(sessionId, controller);
  await redis.sadd(sessionSetKey, sessionId);
  await redis.hset(`vfs:stream:session:${sessionId}`, {
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
  });
  await redis.expire(`vfs:stream:session:${sessionId}`, 3600);
  await incrementMetric("sessionsStarted");
  return { id: sessionId, controller };
}

export async function stopStreamSession(sessionId: string) {
  const controller = sessionControllers.get(sessionId);
  if (controller) controller.abort();
  await redis.hset(`vfs:stream:session:${sessionId}`, {
    status: "cancelled",
    updatedAt: new Date().toISOString(),
    closedAt: new Date().toISOString()
  });
  await redis.expire(`vfs:stream:session:${sessionId}`, 300);
  await redis.srem(sessionSetKey, sessionId);
  sessionControllers.delete(sessionId);
  await incrementMetric("sessionsStopped");
  return { ok: true };
}

export async function readMountedFileRange(input: {
  path: string;
  start: number;
  length: number;
  sessionId?: string;
  userAgent?: string;
  source?: "http" | "fuse" | "api";
}) {
  const providers = await getProviders();
  const policies = await getPolicySettings();
  if (providers.length === 0) throw new Error("No enabled Usenet providers configured");
  if (input.length <= 0) return Buffer.alloc(0);

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

  if (!sessionControllers.has(session.id)) sessionControllers.set(session.id, session.controller);
  markStreamedOnce(session.id, input.path);

  await updateSession(session.id, {
    fileId: plan.fileId,
    size: plan.size,
    start: plan.start,
    end: plan.end,
    currentOffset: plan.start
  });

  const existingBytesSent = Number((await redis.hget(`vfs:stream:session:${session.id}`, "bytesSent")) ?? 0);
  const decodedRanges = await Promise.all(
    plan.ranges.map(async (segment) => {
      throwIfAborted(session.controller.signal);
      const decoded = await getOrFetchSegmentBuffer({
        fileId: segment.fileId,
        segmentNumber: segment.segmentNumber,
        articleId: segment.articleId,
        providers,
        signal: session.controller.signal
      });
      return decoded.subarray(segment.segmentOffset, segment.segmentOffset + segment.length);
    })
  );
  const buffers: Buffer[] = [];
  let total = 0;
  for (const chunk of decodedRanges) {
    buffers.push(chunk);
    total += chunk.length;
  }

  await incrementMetric("bytesServed", total);
  await updateSession(session.id, {
    bytesSent: existingBytesSent + total,
    currentOffset: plan.end + 1
  });

  if (policies.streamReadAheadBytes > 0 && plan.end + 1 < plan.size) {
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
}

export async function streamMountedFile(path: string, range?: string, options?: { userAgent?: string; source?: "http" | "fuse" | "api" }) {
  const providers = await getProviders();
  if (providers.length === 0) throw new Error("No enabled Usenet providers configured");

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
  });
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
  return sessions
    .filter((session) => session.id)
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
