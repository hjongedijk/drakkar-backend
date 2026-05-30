import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { prisma, type UsenetServer } from "../repositories/db/prisma.js";
import { redis } from "../repositories/db/redis.js";
import { env } from "../services/config/env.js";
import { getPolicySettings } from "../services/policyService.js";
import { NntpClient } from "../services/usenet/nntpClient.js";
import { decodeYencBufferLine } from "../services/usenet/yenc.js";
import { markLibraryItemStreamedByPath } from "../services/libraryService.js";
import { normalizeRange, planMountedFileRange } from "../services/rangePlanner.service.js";
import { getMountFileByPath } from "../services/mountedNzbService.js";
import { buildDecodedYencSegments, getDecodedYencFileSize, getDecodedYencPartInfo, type FileLike, type SegmentLike } from "../services/yencManifest.service.js";
import { getStoredArchiveEntryByPath } from "../services/archive/rarStoredIndex.js";
import { cancelStreamSessionActor, closeStreamSessionActor, failStreamSessionActor, getStreamSessionActorSnapshot, startStreamSessionActor, stopStreamSessionActor, updateStreamSessionActor } from "../state-machines/streamSessionMachine.js";
import { clamp, findSegmentIndex, isProviderConnectionLimit, isTemporaryProviderError, segmentCacheKey, sleep, throwIfAborted } from "../services/streaming/streamHelpers.js";

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
const inFlightVfsFileCacheWrites = new Set<string>();
let cachedProviders: { value: UsenetServer[]; expiresAt: number } | null = null;
let mountedPool: MountedNntpPool | null = null;
let mountedPoolSignature: string | null = null;
let sessionFlushTimer: NodeJS.Timeout | null = null;
let metricsFlushTimer: NodeJS.Timeout | null = null;
let diskCacheReady: Promise<void> | null = null;
let diskCachePrunePromise: Promise<void> | null = null;
let lastDiskCachePruneAt = 0;

const SESSION_FLUSH_MS = 2000;
const METRICS_FLUSH_MS = 1000;
const STALE_ACTIVE_SESSION_MS = 15_000;
const DISK_CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const VFS_FILE_CACHE_INDEX_PREFIX = "vfs:file-cache:index:";
const VFS_FILE_CACHE_CHUNK_BYTES = 8 * 1024 * 1024;

function diskSegmentPath(cacheKey: string) {
  const digest = createHash("sha1").update(cacheKey).digest("hex");
  return join(env.STREAM_CACHE_DIR, digest.slice(0, 2), `${digest}.bin`);
}

function vfsFileWindowCacheKey(fileId: string, start: number) {
  return `${fileId}:${start}`;
}

function vfsFileWindowIndexKey(fileId: string) {
  return `${VFS_FILE_CACHE_INDEX_PREFIX}${fileId}`;
}

function vfsFileWindowPath(fileId: string, start: number) {
  const digest = createHash("sha1").update(vfsFileWindowCacheKey(fileId, start)).digest("hex");
  return join(env.STREAM_CACHE_DIR, "vfs", digest.slice(0, 2), `${digest}.bin`);
}

async function readVfsFileWindowChunk(fileId: string, start: number) {
  try {
    const response = await readFile(vfsFileWindowPath(fileId, start));
    return response;
  } catch {
    return null;
  }
}

async function writeVfsFileWindowChunk(fileId: string, start: number, value: Buffer) {
  if (!value.length) return;
  await ensureDiskCacheDir();
  const cachePath = vfsFileWindowPath(fileId, start);
  const parent = dirname(cachePath);
  await mkdir(parent, { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, value);
  await rename(tempPath, cachePath).catch(async () => {
    await rm(tempPath, { force: true }).catch(() => undefined);
  });
  const field = String(start);
  await redis.hset(vfsFileWindowIndexKey(fileId), field, JSON.stringify({
    start,
    end: start + value.length - 1,
    size: value.length,
    updatedAt: Date.now()
  }));
  await redis.expire(vfsFileWindowIndexKey(fileId), 60 * 60 * 24 * 7);
}

async function readCachedVfsFileRange(input: { fileId: string; start: number; length: number }) {
  if (input.length <= 0) return Buffer.alloc(0);
  const policies = await getPolicySettings();
  if (!policies.streamCacheEnabled) return null;
  const maxAgeMs = policies.streamCacheMaxAgeHours * 60 * 60 * 1000;
  const chunks: Buffer[] = [];
  let total = 0;
  const absoluteEnd = input.start + input.length;
  let cursor = Math.floor(input.start / VFS_FILE_CACHE_CHUNK_BYTES) * VFS_FILE_CACHE_CHUNK_BYTES;

  while (cursor < absoluteEnd) {
    const raw = await redis.hget(vfsFileWindowIndexKey(input.fileId), String(cursor));
    if (!raw) return null;
    const entry = JSON.parse(raw) as { start: number; end: number; size: number; updatedAt: number };
    if (Date.now() - entry.updatedAt > maxAgeMs) {
      await redis.hdel(vfsFileWindowIndexKey(input.fileId), String(cursor)).catch(() => undefined);
      await rm(vfsFileWindowPath(input.fileId, cursor), { force: true }).catch(() => undefined);
      return null;
    }
    const chunk = await readVfsFileWindowChunk(input.fileId, cursor);
    if (!chunk || chunk.length !== entry.size) return null;
    const sliceStart = cursor === Math.floor(input.start / VFS_FILE_CACHE_CHUNK_BYTES) * VFS_FILE_CACHE_CHUNK_BYTES
      ? input.start - cursor
      : 0;
    const sliceEnd = Math.min(chunk.length, absoluteEnd - cursor);
    if (sliceEnd <= sliceStart) break;
    chunks.push(chunk.subarray(sliceStart, sliceEnd));
    total += sliceEnd - sliceStart;
    cursor += VFS_FILE_CACHE_CHUNK_BYTES;
  }

  if (total < input.length) return null;
  await incrementMetric("fileWindowCacheHits");
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
}

async function persistVfsFileCacheRange(input: { fileId: string; start: number; buffer: Buffer }) {
  if (!input.buffer.length) return;
  const policies = await getPolicySettings();
  if (!policies.streamCacheEnabled) return;
  const rangeEnd = input.start + input.buffer.length;
  let chunkStart = Math.floor(input.start / VFS_FILE_CACHE_CHUNK_BYTES) * VFS_FILE_CACHE_CHUNK_BYTES;
  while (chunkStart < rangeEnd) {
    const sliceStart = Math.max(0, chunkStart - input.start);
    const sliceEnd = Math.min(input.buffer.length, chunkStart + VFS_FILE_CACHE_CHUNK_BYTES - input.start);
    const chunk = input.buffer.subarray(sliceStart, sliceEnd);
    if (chunk.length === VFS_FILE_CACHE_CHUNK_BYTES) {
      await writeVfsFileWindowChunk(input.fileId, chunkStart, chunk).catch(() => undefined);
    }
    chunkStart += VFS_FILE_CACHE_CHUNK_BYTES;
  }
}

function queuePersistVfsFileCacheRange(input: { fileId: string; start: number; buffer: Buffer }) {
  if (!input.buffer.length) return;
  const key = `${input.fileId}:${input.start}:${input.buffer.length}`;
  if (inFlightVfsFileCacheWrites.has(key)) return;
  inFlightVfsFileCacheWrites.add(key);
  void persistVfsFileCacheRange(input)
    .catch(() => undefined)
    .finally(() => {
      inFlightVfsFileCacheWrites.delete(key);
    });
}

async function ensureDiskCacheDir() {
  const policies = await getPolicySettings();
  if (!policies.streamCacheEnabled) return;
  if (!diskCacheReady) {
    diskCacheReady = mkdir(env.STREAM_CACHE_DIR, { recursive: true }).then(() => undefined);
  }
  return diskCacheReady;
}

export async function reconcileStreamCacheDirectory() {
  const policies = await getPolicySettings();
  if (policies.streamCacheEnabled) {
    await ensureDiskCacheDir();
    return { enabled: true, path: env.STREAM_CACHE_DIR };
  }

  hotSegmentCache.clear();
  diskCacheReady = null;
  await rm(env.STREAM_CACHE_DIR, { recursive: true, force: true }).catch(() => undefined);
  return { enabled: false, path: env.STREAM_CACHE_DIR };
}

async function readDiskCachedSegment(cacheKey: string) {
  try {
    const cachePath = diskSegmentPath(cacheKey);
    const stats = await stat(cachePath);
    const maxAgeMs = (await getPolicySettings()).streamCacheMaxAgeHours * 60 * 60 * 1000;
    if (Date.now() - stats.mtimeMs > maxAgeMs) {
      await rm(cachePath, { force: true }).catch(() => undefined);
      return null;
    }
    return await readFile(cachePath);
  } catch {
    return null;
  }
}

async function writeDiskCachedSegment(cacheKey: string, value: Buffer) {
  if (!value.length) return;
  await ensureDiskCacheDir();
  const cachePath = diskSegmentPath(cacheKey);
  const parent = join(env.STREAM_CACHE_DIR, createHash("sha1").update(cacheKey).digest("hex").slice(0, 2));
  await mkdir(parent, { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, value);
  await rename(tempPath, cachePath).catch(async () => {
    await rm(tempPath, { force: true }).catch(() => undefined);
  });
  void pruneDiskCacheIfNeeded().catch(() => undefined);
}

async function pruneDiskCacheIfNeeded(force = false) {
  const now = Date.now();
  if (!force && now - lastDiskCachePruneAt < DISK_CACHE_PRUNE_INTERVAL_MS) return;
  if (diskCachePrunePromise) return diskCachePrunePromise;
  diskCachePrunePromise = (async () => {
    lastDiskCachePruneAt = now;
    const policies = await getPolicySettings();
    if (!policies.streamCacheEnabled) return;
    await ensureDiskCacheDir();
    const maxAgeMs = policies.streamCacheMaxAgeHours * 60 * 60 * 1000;
    const maxSizeBytes = Math.max(1, Math.floor(policies.streamCacheMaxSizeGb * 1024 * 1024 * 1024));
    const cutoff = Date.now() - maxAgeMs;
    const dirs = await readdir(env.STREAM_CACHE_DIR, { withFileTypes: true }).catch(() => []);
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let totalSize = 0;
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const childDir = join(env.STREAM_CACHE_DIR, dir.name);
      const entries = await readdir(childDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = join(childDir, entry.name);
        const info = await stat(filePath).catch(() => null);
        if (!info) continue;
        if (info.mtimeMs < cutoff) {
          await rm(filePath, { force: true }).catch(() => undefined);
          continue;
        }
        totalSize += info.size;
        files.push({ path: filePath, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    if (totalSize <= maxSizeBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (totalSize <= maxSizeBytes) break;
      await rm(file.path, { force: true }).catch(() => undefined);
      totalSize -= file.size;
    }
  })().finally(() => {
    diskCachePrunePromise = null;
  });
  return diskCachePrunePromise;
}

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
  manifest?: MountedFileManifest;
  directFile?: DirectMountedFile;
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
  sourceOffset?: number;
};
type MountedFileManifest = {
  path: string;
  fileId: string;
  size: number;
  segments: MountedFileSegment[];
};
type DirectMountedSegment = SegmentLike & {
  fileId: string;
  start: number;
  end: number;
};
type DirectMountedFile = {
  path: string;
  fileId: string;
  size: number;
  segments: DirectMountedSegment[];
};
const directMountedFileCache = new Map<string, { value: DirectMountedFile; expiresAt: number }>();
const DIRECT_MOUNTED_FILE_CACHE_TTL_MS = 30 * 60 * 1000;
const mountedReadSessions = new Map<string, MountedReadSession>();
const mountedPathReadWindows = new Map<string, MountedReadSession>();
const MOUNTED_READ_SESSION_TTL_MS = 2 * 60 * 1000;
const MOUNTED_READ_AHEAD_MAX_BYTES = 512 * 1024 * 1024;
const MOUNTED_RANDOM_ACCESS_WINDOW_BYTES = 4 * 1024 * 1024;
const MOUNTED_SEQUENTIAL_WINDOW_BYTES = 512 * 1024 * 1024;
const STREAM_PREFETCH_SEGMENTS = 0;
const STREAM_RANDOM_PREFETCH_SEGMENTS = 0;
const STREAM_READ_AHEAD_PREFETCH_MAX_BYTES = 512 * 1024 * 1024;
const MAX_IDLE_WARM_CONNECTIONS = 1;

class MountedNntpPool {
  private readonly slots: MountedPoolSlot[];
  private readonly waiters: Array<{
    excludedProviders: Set<string>;
    includeBackups: boolean;
    resolve: (slot: MountedPoolSlot) => void;
    reject: (reason: Error) => void;
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
      const slot = await this.acquire(permanentFailures, includeBackups, signal);
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
      const slot = await this.acquire(permanentFailures, includeBackups, signal);
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
      const slot = await this.acquire(permanentFailures, includeBackups, signal);
      try {
        await this.ensureConnected(slot, signal);
        if (!slot.client) throw new Error("NNTP slot did not connect");
        const client = slot.client;
        let completed = false;
        try {
          for await (const chunk of client.decodedBodyBufferChunks(articleId, decodeYencBufferLine, signal)) {
            yield chunk;
          }
          completed = true;
        } finally {
          // Keep fully-consumed BODY connections warm. If the caller stops early,
          // unread multiline data remains on the socket, so that connection must die.
          if (!completed || signal?.aborted) {
            await client.quit().catch(() => undefined);
            if (slot.client === client) slot.client = undefined;
            this.syncDebug();
          }
        }
        if (signal?.aborted) throw new Error("NNTP operation aborted");
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
    const warmTarget = Math.max(0, Math.min(targetConnections, MAX_IDLE_WARM_CONNECTIONS, allowedConnections, this.slots.length));
    const coldSlots = this.slots
      .filter((slot) => !slot.client)
      .sort((a, b) => Number(a.provider.isBackup) - Number(b.provider.isBackup))
      .slice(0, Math.max(0, warmTarget - this.slots.filter((slot) => Boolean(slot.client)).length));
    if (coldSlots.length === 0) return;
    await Promise.allSettled(coldSlots.map((slot) => this.ensureConnected(slot, signal)));
  }

  private async acquire(excludedProviders = new Set<string>(), includeBackups = true, signal?: AbortSignal): Promise<MountedPoolSlot> {
    if (signal?.aborted) throw new Error("NNTP acquire aborted");
    const available = (await this.activeSlots()).find(
      (slot) => !slot.busy && !excludedProviders.has(slot.provider.id) && (includeBackups || !slot.provider.isBackup)
    );
    if (available) {
      available.busy = true;
      this.syncDebug();
      return available;
    }

    return new Promise<MountedPoolSlot>((resolve, reject) => {
      const waiter = { excludedProviders: new Set(excludedProviders), includeBackups, resolve, reject };
      this.waiters.push(waiter);
      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("NNTP acquire aborted"));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
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
    const connectedIdleSlots = this.slots.filter((entry) => entry !== slot && Boolean(entry.client) && !entry.busy).length;
    if (slot.client && connectedIdleSlots >= MAX_IDLE_WARM_CONNECTIONS) {
      const client = slot.client;
      slot.client = undefined;
      this.syncDebug();
      void client.quit().catch(() => undefined);
      return;
    }
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

async function getAllowedStreamingConnections() {
  const policies = await getPolicySettings();
  const streams = await listActiveStreamSessions();
  const activeStreamCount = streams.filter((stream) => stream.status === "active").length;
  const streamingShare = activeStreamCount > 0 ? clamp(policies.streamingPriority / 100, 0, 1) : 0;
  const reservedStreamingConnections = activeStreamCount > 0 ? Math.max(1, Math.floor(policies.maxTotalUsenetConnections * streamingShare)) : 0;
  return clamp(Math.min(policies.maxStreamingConnections, reservedStreamingConnections || policies.maxStreamingConnections), 1, policies.maxStreamingConnections);
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

function shrinkManifestSegment(
  segments: MountedFileSegment[],
  index: number,
  actualBytes: number
) {
  const segment = segments[index];
  if (!segment) return;
  const safeActualBytes = Math.max(0, Math.floor(actualBytes));
  if (!Number.isFinite(safeActualBytes) || safeActualBytes <= 0 || safeActualBytes >= segment.bytes) return;
  const delta = segment.bytes - safeActualBytes;
  segment.bytes = safeActualBytes;
  segment.end = segment.start + safeActualBytes - 1;
  for (let cursor = index + 1; cursor < segments.length; cursor += 1) {
    const next = segments[cursor];
    if (!next) continue;
    next.start -= delta;
    next.end -= delta;
  }
}

async function getMountedFileManifest(path: string): Promise<MountedFileManifest> {
  const archiveEntry = await getStoredArchiveEntryByPath(path);
  if (archiveEntry) {
    return {
      path,
      fileId: `archive:${archiveEntry.documentId}:${archiveEntry.name}`,
      size: archiveEntry.size,
      segments: archiveEntry.segments.map((segment) => ({
        fileId: segment.fileId,
        articleId: segment.articleId,
        segmentNumber: segment.segmentNumber,
        bytes: segment.bytes,
        start: segment.start,
        end: segment.end,
        sourceOffset: segment.sourceOffset
      }))
    };
  }

  const mount = await getMountFileByPath(path);
  if (!mount) throw new Error("mounted NZB not found");
  if (!mount.streamable) throw new Error("mounted NZB is not prepared for streaming yet");
  const file = mount.nzbDocument.files[0];
  if (!file) throw new Error("mounted NZB file not found");

  const segments: MountedFileSegment[] = [];
  const decoded = await buildDecodedYencSegments(file, await getProviders(), undefined, { mode: "exact" });
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

async function getDirectMountedFile(path: string, providers: UsenetServer[], signal?: AbortSignal): Promise<DirectMountedFile | null> {
  const cached = directMountedFileCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const archiveEntry = await getStoredArchiveEntryByPath(path);
  if (archiveEntry) return null;
  const mount = await getMountFileByPath(path);
  if (!mount || !mount.streamable) return null;
  const file = mount.nzbDocument.files[0];
  if (!file) return null;
  const directFile: FileLike<SegmentLike> = {
    id: file.id,
    size: file.size,
    segments: file.segments.map((segment) => ({
      number: segment.number,
      bytes: segment.bytes,
      articleId: segment.articleId
    }))
  };
  const decoded = await buildDecodedYencSegments(directFile, providers, signal, { mode: "fast" });
  const size = Math.max(0, Math.floor(decoded?.size ?? (await getDecodedYencFileSize(directFile, providers, signal)) ?? file.size));
  const value: DirectMountedFile = {
    path,
    fileId: file.id,
    size,
    segments: (decoded?.segments ?? []).map((segment) => ({
      ...segment.segment,
      fileId: file.id,
      start: segment.start,
      end: segment.end,
      bytes: segment.bytes
    }))
  };
  if (value.segments.length === 0) {
    let cursor = 0;
    value.segments = directFile.segments.map((segment) => {
      const bytes = Math.floor(segment.bytes);
      const start = cursor;
      cursor += bytes;
      return {
        ...segment,
        fileId: file.id,
        start,
        end: start + bytes - 1,
        bytes
      };
    });
  }
  directMountedFileCache.set(path, { value, expiresAt: Date.now() + DIRECT_MOUNTED_FILE_CACHE_TTL_MS });
  return value;
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
  const actorValue = getStreamSessionActorSnapshot(sessionId)?.[field as keyof ReturnType<typeof getStreamSessionActorSnapshot>];
  if (actorValue !== undefined) return actorValue;
  const pending = pendingSessionUpdates.get(sessionId)?.[field];
  if (pending !== undefined) return pending;
  return sessionSnapshots.get(sessionId)?.[field];
}

async function updateSession(sessionId: string, payload: Record<string, string | number>, options?: { force?: boolean }) {
  updateStreamSessionActor(sessionId, payload);
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
      await incrementMetric("cacheHits");
      await incrementMetric("memoryCacheHits");
      return hot.value;
    }
    const disk = await readDiskCachedSegment(cacheKey);
    if (disk) {
      hotSegmentCache.set(cacheKey, { value: disk, updatedAt: Date.now() });
      await incrementMetric("cacheHits");
      await incrementMetric("diskCacheHits");
      return disk;
    }
  }

  const existing = inFlightSegmentFetches.get(cacheKey);
  if (existing) {
    await incrementMetric("dedupedSegmentFetches");
    return existing;
  }
  await incrementMetric("cacheMisses");

  const fetchPromise = (async () => {
    const decoded = await downloadArticle(input.articleId, input.providers, input.signal);
    if (policies.streamCacheEnabled) {
      hotSegmentCache.set(cacheKey, { value: decoded, updatedAt: Date.now() });
      await writeDiskCachedSegment(cacheKey, decoded).catch(() => undefined);
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

async function getCachedSegmentBuffer(input: {
  fileId: string;
  segmentNumber: number;
}) {
  const policies = await getPolicySettings();
  if (!policies.streamCacheEnabled) return null;
  const cacheKey = segmentCacheKey(input.fileId, input.segmentNumber);
  const hot = hotSegmentCache.get(cacheKey);
  if (hot) {
    hot.updatedAt = Date.now();
    await incrementMetric("cacheHits");
    await incrementMetric("memoryCacheHits");
    return hot.value;
  }
  const disk = await readDiskCachedSegment(cacheKey);
  if (!disk) return null;
  hotSegmentCache.set(cacheKey, { value: disk, updatedAt: Date.now() });
  await incrementMetric("cacheHits");
  await incrementMetric("diskCacheHits");
  return disk;
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
    const segmentOffset = (segment.sourceOffset ?? 0) + Math.max(0, cursor - segment.start);
    const take = Math.min(safeLength - total, segment.end - cursor + 1);
    const decoded = await getOrFetchSegmentBuffer({
      fileId: segment.fileId,
      segmentNumber: segment.segmentNumber,
      articleId: segment.articleId,
      providers: input.providers,
      signal: input.signal
    });
    if (decoded.length < segment.bytes) {
      shrinkManifestSegment(input.manifest.segments, segmentIndex, decoded.length);
    }
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
  if (count <= 0) return;
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
    let warmedBytes = 0;
    const budgetBytes = Math.min(input.length, STREAM_READ_AHEAD_PREFETCH_MAX_BYTES);
    for (const range of plan.ranges) {
      if (input.signal.aborted) break;
      if (range.segmentOffset !== 0 || range.length !== Math.floor(range.bytes)) continue;
      await getOrFetchSegmentBuffer({
        fileId: range.fileId,
        segmentNumber: range.segmentNumber,
        articleId: range.articleId,
        providers: input.providers,
        signal: input.signal
      });
      warmedBytes += Math.floor(range.bytes);
      if (warmedBytes >= budgetBytes) break;
    }
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
      await incrementMetric("cacheHits");
      await incrementMetric("memoryCacheHits");
      yield hot.value;
      return;
    }
    const disk = await readDiskCachedSegment(cacheKey);
    if (disk) {
      hotSegmentCache.set(cacheKey, { value: disk, updatedAt: Date.now() });
      await incrementMetric("cacheHits");
      await incrementMetric("diskCacheHits");
      yield disk;
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
      await writeDiskCachedSegment(cacheKey, complete).catch(() => undefined);
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
  const decoded = await getOrFetchSegmentBuffer({
    fileId: input.fileId,
    segmentNumber: input.segmentNumber,
    articleId: input.articleId,
    providers: input.providers,
    signal: input.signal
  });
  return Readable.from([decoded.subarray(input.segmentOffset, input.segmentOffset + input.length)]);
}

function findDirectMountedSegmentByOffset(input: {
  file: DirectMountedFile;
  offset: number;
}) {
  const segments = input.file.segments;
  if (segments.length === 0) return null;
  const index = findSegmentIndex(segments, input.offset);
  const segment = segments[index];
  if (!segment || input.offset < segment.start || input.offset > segment.end) return null;
  return { index, start: segment.start, end: segment.end };
}

async function findDirectMountedSegmentByOffsetExact(input: {
  file: DirectMountedFile;
  offset: number;
  providers: UsenetServer[];
  signal?: AbortSignal;
}) {
  const estimated = findDirectMountedSegmentByOffset({ file: input.file, offset: input.offset });
  if (!estimated) return null;
  const visited = new Set<number>();
  let index = estimated.index;
  let direction = 0;
  for (let attempts = 0; attempts < 64; attempts += 1) {
    if (index < 0 || index >= input.file.segments.length || visited.has(index)) break;
    visited.add(index);
    const segment = input.file.segments[index];
    if (!segment) break;
    const info = await getDecodedYencPartInfo(input.file.fileId, segment, input.providers, input.signal).catch(() => null);
    const start = Number.isFinite(info?.partOffset) ? Math.floor(info!.partOffset!) : segment.start;
    const bytes = Number.isFinite(info?.partSize) && (info?.partSize ?? 0) > 0 ? Math.floor(info!.partSize!) : segment.end - segment.start + 1;
    const end = start + bytes - 1;
    if (input.offset >= start && input.offset <= end) return { index, start, end };
    direction = input.offset < start ? -1 : 1;
    index += direction;
    if (index < 0 || index >= input.file.segments.length) break;
  }
  return estimated;
}

async function readDirectMountedRange(input: {
  file: DirectMountedFile;
  start: number;
  length: number;
  providers: UsenetServer[];
  signal?: AbortSignal;
}) {
  if (input.length <= 0 || input.start >= input.file.size) return Buffer.alloc(0);
  const targetLength = Math.min(input.length, input.file.size - input.start);
  const found = await findDirectMountedSegmentByOffsetExact({
    file: input.file,
    offset: input.start,
    providers: input.providers,
    signal: input.signal
  });
  if (!found) throw new Error(`unable to locate mounted segment for offset ${input.start}`);

  const buffers: Buffer[] = [];
  let total = 0;
  let discard = input.start - found.start;

  for (let index = found.index; index < input.file.segments.length && total < targetLength; index += 1) {
    const segment = input.file.segments[index];
    if (!segment) break;
    for await (const chunk of streamSegmentProgressively({
      fileId: input.file.fileId,
      segmentNumber: segment.number,
      articleId: segment.articleId,
      providers: input.providers,
      signal: input.signal
    })) {
      let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (discard > 0) {
        if (buffer.length <= discard) {
          discard -= buffer.length;
          continue;
        }
        buffer = buffer.subarray(discard);
        discard = 0;
      }
      if (buffer.length > targetLength - total) {
        buffer = buffer.subarray(0, targetLength - total);
      }
      if (buffer.length === 0) continue;
      buffers.push(buffer);
      total += buffer.length;
      if (total >= targetLength) break;
    }
  }

  return buffers.length === 1 ? buffers[0]! : Buffer.concat(buffers, total);
}

async function* streamDirectMountedRanges(input: {
  sessionId: string;
  file: DirectMountedFile;
  start: number;
  end: number;
  providers: UsenetServer[];
  signal: AbortSignal;
}) {
  const found = await findDirectMountedSegmentByOffsetExact({
    file: input.file,
    offset: input.start,
    providers: input.providers,
    signal: input.signal
  });
  if (!found) throw new Error(`unable to locate mounted segment for offset ${input.start}`);

  let bytesSent = 0;
  let discard = input.start - found.start;
  let remaining = input.end - input.start + 1;

  try {
    for (let index = found.index; index < input.file.segments.length && remaining > 0; index += 1) {
      const segment = input.file.segments[index];
      if (!segment) break;
      for await (const chunk of streamSegmentProgressively({
        fileId: input.file.fileId,
        segmentNumber: segment.number,
        articleId: segment.articleId,
        providers: input.providers,
        signal: input.signal
      })) {
        throwIfAborted(input.signal);
        let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (discard > 0) {
          if (buffer.length <= discard) {
            discard -= buffer.length;
            continue;
          }
          buffer = buffer.subarray(discard);
          discard = 0;
        }
        if (buffer.length > remaining) {
          buffer = buffer.subarray(0, remaining);
        }
        if (buffer.length === 0) continue;
        bytesSent += buffer.length;
        remaining -= buffer.length;
        void incrementMetric("bytesServed", buffer.length);
        yield buffer;
        void updateSession(input.sessionId, {
          bytesSent,
          currentOffset: input.start + bytesSent
        });
        if (remaining <= 0) break;
      }
    }
  } finally {
    const status = input.signal.aborted ? "cancelled" : "closed";
    if (status === "cancelled") {
      cancelStreamSessionActor(input.sessionId, {
        bytesSent,
        currentOffset: input.start + bytesSent,
        closedAt: new Date().toISOString()
      });
    } else {
      closeStreamSessionActor(input.sessionId, {
        bytesSent,
        currentOffset: input.start + bytesSent,
        closedAt: new Date().toISOString()
      });
    }
    await updateSession(input.sessionId, {
      status,
      bytesSent,
      currentOffset: input.start + bytesSent,
      closedAt: new Date().toISOString()
    }, { force: true });
    await redis.expire(`vfs:stream:session:${input.sessionId}`, 300);
    await redis.srem(sessionSetKey, input.sessionId);
    sessionSnapshots.delete(input.sessionId);
    pendingSessionUpdates.delete(input.sessionId);
    sessionControllers.delete(input.sessionId);
    stopStreamSessionActor(input.sessionId);
  }
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
        void incrementMetric("bytesServed", buffer.length);
        yield buffer;
      }

      void updateSession(input.sessionId, {
        bytesSent,
        currentOffset: range.readOffset + range.length
      });
    }
  } finally {
    const status = input.signal.aborted ? "cancelled" : "closed";
    if (status === "cancelled") {
      cancelStreamSessionActor(input.sessionId, {
        bytesSent,
        currentOffset: bytesSent,
        closedAt: new Date().toISOString()
      });
    } else {
      closeStreamSessionActor(input.sessionId, {
        bytesSent,
        currentOffset: bytesSent,
        closedAt: new Date().toISOString()
      });
    }
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
    stopStreamSessionActor(input.sessionId);
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
  startStreamSessionActor({
    id: sessionId,
    path: input.path,
    range: input.range,
    source: input.source,
    userAgent: input.userAgent
  });
  await redis.hset(`vfs:stream:session:${sessionId}`, initialState);
  await redis.expire(`vfs:stream:session:${sessionId}`, 3600);
  await incrementMetric("sessionsStarted");
  return { id: sessionId, controller };
}

export async function stopStreamSession(sessionId: string) {
  const controller = sessionControllers.get(sessionId);
  if (controller) controller.abort();
  cancelStreamSessionActor(sessionId, {
    status: "cancelled",
    closedAt: new Date().toISOString()
  });
  await updateSession(sessionId, {
    status: "cancelled",
    closedAt: new Date().toISOString()
  }, { force: true });
  await redis.expire(`vfs:stream:session:${sessionId}`, 300);
  await redis.srem(sessionSetKey, sessionId);
  sessionSnapshots.delete(sessionId);
  pendingSessionUpdates.delete(sessionId);
  sessionControllers.delete(sessionId);
  stopStreamSessionActor(sessionId);
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
        count: STREAM_RANDOM_PREFETCH_SEGMENTS
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
  const directFile = await getDirectMountedFile(input.path, providers);
  if (directFile) {
    const safeLength = Math.min(input.length, Math.max(0, directFile.size - input.start));
    const cachedRange = await readCachedVfsFileRange({
      fileId: directFile.fileId,
      start: input.start,
      length: safeLength
    });
    const range = `bytes=${input.start}-${input.start + Math.max(0, safeLength - 1)}`;
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
        fileId: directFile.fileId,
        size: directFile.size,
        start: input.start,
        end: Math.min(directFile.size - 1, input.start + safeLength - 1),
        currentOffset: input.start
      }, { force: true });
      const existingBytesSent = Number(sessionField(session.id, "bytesSent") ?? 0);
      if (cachedRange) {
        await incrementMetric("bytesServed", cachedRange.length);
        await updateSession(session.id, {
          bytesSent: existingBytesSent + cachedRange.length,
          currentOffset: input.start + cachedRange.length
        }, { force: true });
        return cachedRange;
      }
      const merged = await readDirectMountedRange({
        file: directFile,
        start: input.start,
        length: safeLength,
        providers,
        signal: session.controller.signal
      });
      queuePersistVfsFileCacheRange({ fileId: directFile.fileId, start: input.start, buffer: merged });
      await incrementMetric("bytesServed", merged.length);
      await updateSession(session.id, {
        bytesSent: existingBytesSent + merged.length,
        currentOffset: input.start + merged.length
      }, { force: true });
      return merged;
    } catch (error) {
      failStreamSessionActor(session.id, error instanceof Error ? error.message : "mounted read failed");
      throw error;
    } finally {
      if (ownsSession) await stopStreamSession(session.id).catch(() => undefined);
    }
  }
  const range = `bytes=${input.start}-${input.start + input.length - 1}`;
  const plan = await planMountedFileRange(input.path, range);
  const cachedRange = await readCachedVfsFileRange({
    fileId: plan.fileId,
    start: plan.start,
    length: plan.end - plan.start + 1
  });
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

    if (cachedRange) {
      await incrementMetric("bytesServed", cachedRange.length);
      await updateSession(session.id, {
        bytesSent: existingBytesSent + cachedRange.length,
        currentOffset: plan.start + cachedRange.length
      }, { force: true });
      return cachedRange;
    }

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
    const merged = buffers.length === 1 ? buffers[0]! : Buffer.concat(buffers, total);
    queuePersistVfsFileCacheRange({ fileId: plan.fileId, start: plan.start, buffer: merged });
    await updateSession(session.id, {
      bytesSent: existingBytesSent + total,
      currentOffset: plan.end + 1
    }, { force: true });

    return merged;
  } catch (error) {
    failStreamSessionActor(session.id, error instanceof Error ? error.message : "mounted read failed");
    throw error;
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
  const directFile = await getDirectMountedFile(input.path, providers);
  const manifest = directFile
    ? undefined
    : cached?.path === input.path
      ? cached.manifest
      : sharedCached?.path === input.path
        ? sharedCached.manifest
        : await getMountedFileManifest(input.path);
  const cachedRange = await readCachedVfsFileRange({
    fileId: directFile?.fileId ?? manifest!.fileId,
    start: input.start,
    length: input.length
  });
  await updateSession(streamSession.id, {
    fileId: directFile?.fileId ?? manifest!.fileId,
    size: directFile?.size ?? manifest!.size,
    start: input.start,
    end: Math.min((directFile?.size ?? manifest!.size) - 1, input.start + input.length - 1),
    currentOffset: input.start,
    range,
    source: "fuse",
    path: input.path,
    status: "active"
  });
  if (cachedRange) {
    rememberMountedWindow(input.sessionId, {
      path: input.path,
      manifest,
      directFile: directFile ?? undefined,
      bufferStart: input.start,
      buffer: cachedRange,
      lastReadEnd: input.start + cachedRange.length,
      updatedAt: Date.now()
    });
    await incrementMetric("bytesServed", cachedRange.length);
    await updateSession(streamSession.id, {
      bytesSent: Number(sessionField(streamSession.id, "bytesSent") ?? 0) + cachedRange.length,
      currentOffset: input.start + cachedRange.length
    });
    return cachedRange;
  }
  const sequentialRead = Boolean(cached && cached.path === input.path && input.start >= cached.lastReadEnd && input.start - cached.lastReadEnd <= 256 * 1024);
  const reader = directFile ? undefined : cached?.path === input.path && cached.reader ? cached.reader : createSequentialReader(manifest!);
  const signal: AbortSignal | undefined = undefined;

  if (!directFile && (sequentialRead || (cached?.reader && input.start === cached.lastReadEnd))) {
    await seekSequentialReader(reader!, input.start, signal);
    const out = await readSequentialBytes(reader!, input.length, signal);
    queuePersistVfsFileCacheRange({ fileId: manifest!.fileId, start: input.start, buffer: out });
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
        Math.min(MOUNTED_SEQUENTIAL_WINDOW_BYTES, policies.streamReadAheadBytes || MOUNTED_SEQUENTIAL_WINDOW_BYTES)
      )
    : Math.max(
        input.length,
        Math.min(MOUNTED_RANDOM_ACCESS_WINDOW_BYTES, policies.streamReadAheadBytes || MOUNTED_RANDOM_ACCESS_WINDOW_BYTES)
      );
  const fetchLength = Math.min(targetWindow, MOUNTED_READ_AHEAD_MAX_BYTES);
  const windowStart = Math.max(0, Math.floor(input.start / VFS_FILE_CACHE_CHUNK_BYTES) * VFS_FILE_CACHE_CHUNK_BYTES);
  const alignedFetchLength = Math.min(
    (directFile?.size ?? manifest!.size) - windowStart,
    Math.max(fetchLength + (input.start - windowStart), input.length)
  );
  if (!directFile && sequentialRead) {
    warmManifestSegments({
      manifest: manifest!,
      start: input.start,
      providers,
      signal,
      count: STREAM_PREFETCH_SEGMENTS
    });
  }
  const window = directFile
    ? await readDirectMountedRange({
        file: directFile,
        start: windowStart,
        length: alignedFetchLength,
        providers,
        signal
      })
    : await readManifestWindow({
        manifest: manifest!,
        start: windowStart,
        length: alignedFetchLength,
        providers,
        signal
      });
  queuePersistVfsFileCacheRange({ fileId: directFile?.fileId ?? manifest!.fileId, start: windowStart, buffer: window });
  rememberMountedWindow(input.sessionId, {
    path: input.path,
    manifest,
    directFile: directFile ?? undefined,
    bufferStart: windowStart,
    buffer: window,
    lastReadEnd: input.start + Math.min(input.length, window.length),
    updatedAt: Date.now(),
    reader
  });
  const outOffset = input.start - windowStart;
  const out = window.subarray(outOffset, outOffset + Math.min(input.length, window.length - outOffset));
  await incrementMetric("bytesServed", out.length);
  await updateSession(streamSession.id, {
    bytesSent: Number(sessionField(streamSession.id, "bytesSent") ?? 0) + out.length,
    currentOffset: input.start + out.length
  });
  return out;
}

export async function streamMountedFile(path: string, range?: string, options?: { userAgent?: string; source?: "http" | "fuse" | "api"; signal?: AbortSignal }) {
  const providers = await getProviders();
  const pool = await getMountedPool();
  if (providers.length === 0) throw new Error("No enabled Usenet providers configured");
  await pool.ensureWarm(1, options?.signal);
  const directFile = await getDirectMountedFile(path, providers, options?.signal);
  if (directFile) {
    const partialRange = normalizeRange(range, directFile.size);
    const session = await getOrCreateStreamSession({
      path,
      range,
      userAgent: options?.userAgent,
      source: options?.source ?? "http"
    });
    await updateSession(session.id, {
      fileId: directFile.fileId,
      size: directFile.size,
      start: partialRange.start,
      end: partialRange.end
    }, { force: true });
    markStreamedOnce(session.id, path);
    const stream = Readable.from(
      streamDirectMountedRanges({
        sessionId: session.id,
        file: directFile,
        start: partialRange.start,
        end: partialRange.end,
        providers,
        signal: session.controller.signal
      })
    );
    return {
      stream,
      start: partialRange.start,
      end: partialRange.end,
      size: directFile.size,
      partial: Boolean(range),
      sessionId: session.id
    };
  }
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
