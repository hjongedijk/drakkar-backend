import { open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { decodeYencBufferLine } from "./yenc.js";
import { NntpClient } from "./nntpClient.js";
import { getAllowedDownloadConnections } from "../bandwidth/bandwidthScheduler.js";
import { filenameFromSubject } from "./filename.js";
import { classifyNzbImportMode, classifyNzbImportPlan, type NzbImportMode, type NzbImportPlan } from "./importMode.js";
import { humanizeDownloadError } from "../downloads/presentation.js";
import { getUsenetRuntimeVersion } from "./settings.js";

type NzbWithFiles = NonNullable<Awaited<ReturnType<typeof loadNzbDocument>>>;
export { filenameFromSubject } from "./filename.js";

const DOWNLOAD_PROGRESS_UPDATE_INTERVAL_MS = 3000;
const DOWNLOAD_PROGRESS_UPDATE_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_WRITE_BATCH_BYTES = 4 * 1024 * 1024;

async function loadNzbDocument(id: string) {
  return prisma.nzbDocument.findUnique({
    where: { id },
    include: { files: { include: { segments: { orderBy: { number: "asc" } } } } }
  });
}

async function getProviders() {
  return prisma.usenetServer.findMany({
    where: { enabled: true },
    orderBy: [{ isBackup: "asc" }, { priority: "asc" }]
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isTemporaryProviderError(message: string) {
  return /too many connections|timeout|temporarily|try again|connection.*reset|econnreset|etimedout/i.test(message);
}

function isProviderConnectionLimit(message: string) {
  return /too many connections/i.test(message);
}

function isLikelyMediaSubject(subject: string) {
  return /\.(mkv|mp4|avi|mov|m4v|ts)(?:["_\s).]|$)/i.test(subject);
}

function sampleSegmentsForDecodeCheck(nzb: NzbWithFiles) {
  const mediaFiles = nzb.files
    .filter((file) => file.segments.length > 0 && isLikelyMediaSubject(filenameFromSubject(file.subject, 0)))
    .sort((a, b) => b.size - a.size);
  const mainFile = mediaFiles[0] ?? nzb.files.filter((file) => file.segments.length > 0).sort((a, b) => b.size - a.size)[0];
  if (!mainFile) return [];

  const indexes = new Set([0, Math.floor(mainFile.segments.length / 2), mainFile.segments.length - 1]);
  return [...indexes]
    .filter((index) => index >= 0 && index < mainFile.segments.length)
    .map((index) => mainFile.segments[index])
    .filter((segment): segment is NzbWithFiles["files"][number]["segments"][number] => Boolean(segment));
}

type Provider = Awaited<ReturnType<typeof getProviders>>[number];

type PoolSlot = {
  provider: Provider;
  client?: NntpClient;
  busy: boolean;
};

type PoolDebugSlot = {
  providerId: string;
  providerName: string;
  busy: boolean;
  connected: boolean;
};

type PoolDebugState = {
  ownerId: string;
  phase: "verifying" | "downloading";
  allowedConnections: number;
  slotCount: number;
  connectedSlots: number;
  busySlots: number;
  slots: PoolDebugSlot[];
  providers: Array<{
    providerId: string;
    providerName: string;
    configuredConnections: number;
    slotCount: number;
    connectedSlots: number;
    busySlots: number;
  }>;
};

const activePoolDebugStates = new Map<string, PoolDebugState>();

function syncPoolDebugState(input: {
  ownerId: string;
  phase: "verifying" | "downloading";
  allowedConnections: number;
  slots: PoolSlot[];
}) {
  const slots = input.slots.map((slot) => ({
    providerId: slot.provider.id,
    providerName: slot.provider.name,
    busy: slot.busy,
    connected: Boolean(slot.client)
  }));
  const providerStates = new Map<string, PoolDebugState["providers"][number]>();
  for (const slot of input.slots) {
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
  activePoolDebugStates.set(input.ownerId, {
    ownerId: input.ownerId,
    phase: input.phase,
    allowedConnections: input.allowedConnections,
    slotCount: input.slots.length,
    connectedSlots: slots.filter((slot) => slot.connected).length,
    busySlots: slots.filter((slot) => slot.busy).length,
    slots,
    providers: [...providerStates.values()]
  });
}

function clearPoolDebugState(ownerId: string) {
  activePoolDebugStates.delete(ownerId);
}

export function getDownloadPoolDebugState() {
  return [...activePoolDebugStates.values()];
}

class NntpPool {
  private readonly slots: PoolSlot[];
  private readonly waiters: Array<{ excludedProviders: Set<string>; includeBackups: boolean; resolve: (slot: PoolSlot) => void }> = [];
  private readonly runtimeVersion = getUsenetRuntimeVersion();
  private readonly primaryProviderIds: Set<string>;
  private readonly primaryProviderCount: number;

  constructor(
    providers: Provider[],
    private readonly maxConnections: number,
    private readonly logger: FastifyBaseLogger,
    private readonly ownerId: string,
    private readonly phase: "verifying" | "downloading"
  ) {
    const slots: PoolSlot[] = [];
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

  get size() {
    return this.slots.length;
  }

  async article(articleId: string) {
    this.assertRuntimeVersion();
    const errors: string[] = [];
    const permanentFailures = new Set<string>();
    const providerCount = new Set(this.slots.map((slot) => slot.provider.id)).size;
    const maxAttempts = Math.max(providerCount, this.slots.length * 2);
    let includeBackups = this.primaryProviderCount === 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (permanentFailures.size >= providerCount) break;
      const slot = await this.acquire(permanentFailures, includeBackups);
      try {
        if (!slot.client) {
          slot.client = new NntpClient(slot.provider);
          await slot.client.connect();
          this.syncDebug();
        }
        return await collectDecodedArticleBody(slot.client, articleId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown NNTP error";
        errors.push(`${slot.provider.name}: ${message}`);
        this.logger.warn({ provider: slot.provider.name, articleId, attempt, err: error }, "segment download failed");
        await slot.client?.quit().catch(() => undefined);
        slot.client = undefined;
        this.syncDebug();
        if (isProviderConnectionLimit(message)) {
          permanentFailures.add(slot.provider.id);
          if (!includeBackups && this.allPrimaryProvidersFailed(permanentFailures)) includeBackups = true;
          if (permanentFailures.size >= providerCount) throw new Error(`too many connections from all configured providers`);
          continue;
        }
        if (isTemporaryProviderError(message)) {
          if (attempt < maxAttempts) await sleep(Math.min(15000, attempt * 2000));
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

  async stat(articleId: string) {
    this.assertRuntimeVersion();
    const errors: string[] = [];
    const permanentFailures = new Set<string>();
    const providerCount = new Set(this.slots.map((slot) => slot.provider.id)).size;
    const maxAttempts = Math.max(providerCount, this.slots.length * 2);
    let includeBackups = this.primaryProviderCount === 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (permanentFailures.size >= providerCount) break;
      const slot = await this.acquire(permanentFailures, includeBackups);
      try {
        if (!slot.client) {
          slot.client = new NntpClient(slot.provider);
          await slot.client.connect();
          this.syncDebug();
        }
        await slot.client.stat(articleId);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown NNTP error";
        errors.push(`${slot.provider.name}: ${message}`);
        this.logger.warn({ provider: slot.provider.name, articleId, attempt, err: error }, "segment availability check failed");
        await slot.client?.quit().catch(() => undefined);
        slot.client = undefined;
        this.syncDebug();
        if (isProviderConnectionLimit(message)) {
          permanentFailures.add(slot.provider.id);
          if (!includeBackups && this.allPrimaryProvidersFailed(permanentFailures)) includeBackups = true;
          if (permanentFailures.size >= providerCount) throw new Error(`too many connections from all configured providers`);
          continue;
        }
        if (isTemporaryProviderError(message)) {
          if (attempt < maxAttempts) await sleep(Math.min(15000, attempt * 2000));
        } else {
          permanentFailures.add(slot.provider.id);
          if (!includeBackups && this.allPrimaryProvidersFailed(permanentFailures)) includeBackups = true;
        }
      } finally {
        this.release(slot);
      }
    }

    throw new Error(`all providers failed STAT for ${articleId}: ${errors.join("; ")}`);
  }

  async *stream(articleId: string) {
    this.assertRuntimeVersion();
    const errors: string[] = [];
    const permanentFailures = new Set<string>();
    const providerCount = new Set(this.slots.map((slot) => slot.provider.id)).size;
    const maxAttempts = Math.max(providerCount, this.slots.length * 2);
    let includeBackups = this.primaryProviderCount === 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (permanentFailures.size >= providerCount) break;
      const slot = await this.acquire(permanentFailures, includeBackups);
      let success = false;
      try {
        if (!slot.client) {
          slot.client = new NntpClient(slot.provider);
          await slot.client.connect();
          this.syncDebug();
        }
        for await (const chunk of slot.client.decodedBodyBufferChunks(articleId, decodeYencBufferLine)) {
          yield chunk;
        }
        success = true;
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown NNTP error";
        errors.push(`${slot.provider.name}: ${message}`);
        this.logger.warn({ provider: slot.provider.name, articleId, attempt, err: error }, "segment stream failed");
        await slot.client?.quit().catch(() => undefined);
        slot.client = undefined;
        this.syncDebug();
        if (isProviderConnectionLimit(message)) {
          permanentFailures.add(slot.provider.id);
          if (!includeBackups && this.allPrimaryProvidersFailed(permanentFailures)) includeBackups = true;
          if (permanentFailures.size >= providerCount) throw new Error(`too many connections from all configured providers`);
        } else if (isTemporaryProviderError(message)) {
          if (attempt < maxAttempts) await sleep(Math.min(15000, attempt * 2000));
        } else {
          permanentFailures.add(slot.provider.id);
          if (!includeBackups && this.allPrimaryProvidersFailed(permanentFailures)) includeBackups = true;
        }
      } finally {
        if (!success) this.release(slot);
        else this.release(slot);
      }
    }

    throw new Error(`all providers failed for ${articleId}: ${errors.join("; ")}`);
  }

  async close() {
    await Promise.all(this.slots.map((slot) => slot.client?.quit().catch(() => undefined)));
    clearPoolDebugState(this.ownerId);
  }

  private async acquire(excludedProviders = new Set<string>(), includeBackups = true): Promise<PoolSlot> {
    if ((await getAllowedDownloadConnections()) <= 0) {
      await sleep(1000);
      return this.acquire(excludedProviders, includeBackups);
    }
    const available = (await this.activeSlots()).find(
      (slot) => !slot.busy && !excludedProviders.has(slot.provider.id) && (includeBackups || !slot.provider.isBackup)
    );
    if (available) {
      available.busy = true;
      this.syncDebug();
      return Promise.resolve(available);
    }

    return new Promise<PoolSlot>((resolve) => {
      this.waiters.push({ excludedProviders: new Set(excludedProviders), includeBackups, resolve });
    });
  }

  private async activeSlots() {
    const limit = Math.max(1, Math.min(await getAllowedDownloadConnections(), this.slots.length));
    return this.slots.slice(0, limit);
  }

  private release(slot: PoolSlot) {
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
    syncPoolDebugState({
      ownerId: this.ownerId,
      phase: this.phase,
      allowedConnections: this.maxConnections,
      slots: this.slots
    });
  }

  private assertRuntimeVersion() {
    if (this.runtimeVersion !== getUsenetRuntimeVersion()) {
      throw new Error("Usenet provider configuration changed; restarting download with new connection pool");
    }
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

async function reconstructFile(input: {
  downloadId: string;
  nzb: NzbWithFiles;
  file: NzbWithFiles["files"][number];
  fileIndex: number;
  pool: NntpPool;
  logger: FastifyBaseLogger;
  downloadedBefore: number;
  startedAt: number;
}) {
  let downloaded = input.downloadedBefore;
  let lastProgressUpdateAt = 0;
  let lastProgressPersistedBytes = input.downloadedBefore;
  let progressWrite = Promise.resolve();

  const outputDir = join(env.VFS_DOWNLOADS_DIR, input.downloadId);
  await mkdir(outputDir, { recursive: true });
  const filename = filenameFromSubject(input.file.subject, input.fileIndex);
  const outputPath = join(outputDir, filename);
  const handle = await open(outputPath, "w");
  let writeOffset = 0;
  let pendingProgressSnapshot: number | null = null;
  let pendingWriteBytes = 0;
  let pendingWriteBuffers: Buffer[] = [];

  function progressData(downloadedSnapshot: number) {
    const elapsedSeconds = Math.max(1, (Date.now() - input.startedAt) / 1000);
    const speedBytesSec = downloadedSnapshot / elapsedSeconds;
    const remaining = Math.max(0, input.nzb.totalSize - downloadedSnapshot);
    return {
      downloaded: downloadedSnapshot,
      progress: input.nzb.totalSize > 0 ? Math.min(100, (downloadedSnapshot / input.nzb.totalSize) * 100) : 0,
      speedBytesSec,
      etaSeconds: speedBytesSec > 0 ? Math.ceil(remaining / speedBytesSec) : null
    };
  }

  async function updateProgress(chunkLength = 0, force = false) {
    downloaded += chunkLength;
    const now = Date.now();
    const bytesSincePersist = downloaded - lastProgressPersistedBytes;
    if (
      !force &&
      now - lastProgressUpdateAt < DOWNLOAD_PROGRESS_UPDATE_INTERVAL_MS &&
      bytesSincePersist < DOWNLOAD_PROGRESS_UPDATE_BYTES
    ) return;
    lastProgressUpdateAt = now;
    const downloadedSnapshot = downloaded;
    lastProgressPersistedBytes = downloadedSnapshot;
    pendingProgressSnapshot = downloadedSnapshot;
    progressWrite = progressWrite
      .catch(() => undefined)
      .then(async () => {
        if (pendingProgressSnapshot === null) return;
        const snapshot = pendingProgressSnapshot;
        pendingProgressSnapshot = null;
        await prisma.download.update({
          where: { id: input.downloadId },
          data: progressData(snapshot)
        });
      })
      .catch((error) => {
        input.logger.warn({ downloadId: input.downloadId, err: error }, "download progress update failed");
      });
    if (force) await progressWrite;
  }

  async function flushPendingWrites(force = false) {
    if (!force && pendingWriteBytes < DOWNLOAD_WRITE_BATCH_BYTES) return;
    if (pendingWriteBytes === 0 || pendingWriteBuffers.length === 0) return;
    const bytes = pendingWriteBytes;
    const buffers = pendingWriteBuffers;
    pendingWriteBytes = 0;
    pendingWriteBuffers = [];
    await handle.writev(buffers, writeOffset);
    writeOffset += bytes;
    await updateProgress(bytes);
  }

  type PrimedSegment = {
    first: Promise<{ ok: true; step: IteratorResult<Buffer> } | { ok: false; error: unknown }>;
    iterator: AsyncIterator<Buffer>;
  };
  const prefetchCount = Math.max(1, Math.min(input.pool.size, 24, input.file.segments.length));
  const primed = new Map<number, PrimedSegment>();
  let nextPrimeIndex = 0;

  function primeSegment(index: number) {
    const segment = input.file.segments[index];
    if (!segment || primed.has(index)) return;
    const iterator = input.pool.stream(segment.articleId)[Symbol.asyncIterator]();
    primed.set(index, {
      iterator,
      first: iterator.next()
        .then((step) => ({ ok: true as const, step }))
        .catch((error) => ({ ok: false as const, error }))
    });
  }

  function topUpPrefetch() {
    while (primed.size < prefetchCount && nextPrimeIndex < input.file.segments.length) {
      primeSegment(nextPrimeIndex);
      nextPrimeIndex += 1;
    }
  }

  try {
    topUpPrefetch();
    for (let segmentIndex = 0; segmentIndex < input.file.segments.length; segmentIndex += 1) {
      const current = primed.get(segmentIndex);
      if (!current) throw new Error(`segment stream was not primed for index ${segmentIndex}`);
      primed.delete(segmentIndex);
      topUpPrefetch();

      const first = await current.first;
      if (!first.ok) throw first.error;
      let step = first.step;
      while (!step.done) {
        const chunk = step.value;
        if (chunk.length > 0) {
          pendingWriteBuffers.push(chunk);
          pendingWriteBytes += chunk.length;
          await flushPendingWrites();
        }
        step = await current.iterator.next();
      }
      await flushPendingWrites(true);
    }
    await flushPendingWrites(true);
    await updateProgress(0, true);
  } finally {
    await Promise.all(
      [...primed.values()].map((segment) => segment.iterator.return?.().catch(() => undefined))
    );
    await flushPendingWrites(true);
    await handle.close();
  }

  return { outputPath, bytes: downloaded - input.downloadedBefore };
}

export async function prepareNzbDocumentForStreaming(input: {
  downloadId: string;
  nzbDocumentId: string;
  logger: FastifyBaseLogger;
  maxConnectionsOverride?: number;
}) {
  const nzb = await loadNzbDocument(input.nzbDocumentId);
  if (!nzb) throw new Error("NZB document not found");

  const providers = await getProviders();
  if (providers.length === 0) {
    await prisma.download.update({
      where: { id: input.downloadId },
      data: { status: "waiting_for_provider", error: "No enabled Usenet providers configured" }
    });
    await prisma.vfsMount.updateMany({
      where: { nzbDocumentId: input.nzbDocumentId },
      data: { status: "waiting_for_provider", streamable: false }
    });
    return { status: "waiting_for_provider", verifiedSegments: 0 };
  }

  await prisma.download.update({
    where: { id: input.downloadId },
    data: { status: "verifying", progress: 0, downloaded: 0, speedBytesSec: 0, etaSeconds: null, error: null }
  });
  await prisma.vfsMount.updateMany({
    where: { nzbDocumentId: input.nzbDocumentId },
    data: { status: "verifying", streamable: false }
  });

  const allowedConnections = input.maxConnectionsOverride ?? await getAllowedDownloadConnections();
  const pool = new NntpPool(providers, Math.max(1, allowedConnections), input.logger, input.downloadId, "verifying");
  const totalSize = nzb.totalSize;
  let verified = 0;
  let verifiedBytes = 0;
  let lastProgressUpdateAt = 0;
  let lastProgressPersistedBytes = 0;
  const startedAt = Date.now();

  const decodeSamples = sampleSegmentsForDecodeCheck(nzb);
  for (const segment of decodeSamples) {
    const decoded = await pool.article(segment.articleId);
    if (decoded.length === 0) throw new Error(`decoded media sample is empty for ${segment.articleId}`);
    verified += 1;
    verifiedBytes += Number(segment.bytes);
    await updateProgress();
  }

  async function updateProgress(force = false) {
    const now = Date.now();
    const bytesSincePersist = verifiedBytes - lastProgressPersistedBytes;
    if (
      !force &&
      now - lastProgressUpdateAt < DOWNLOAD_PROGRESS_UPDATE_INTERVAL_MS &&
      bytesSincePersist < DOWNLOAD_PROGRESS_UPDATE_BYTES
    ) return;
    lastProgressUpdateAt = now;
    lastProgressPersistedBytes = verifiedBytes;
    await prisma.download.update({
      where: { id: input.downloadId },
      data: {
        progress: Math.min(99, decodeSamples.length > 0 ? (verified / decodeSamples.length) * 100 : 0),
        downloaded: verifiedBytes,
        speedBytesSec: verifiedBytes / Math.max(1, (Date.now() - startedAt) / 1000),
        etaSeconds:
            verifiedBytes > 0
            ? Math.ceil(Math.max(0, totalSize - verifiedBytes) / (verifiedBytes / Math.max(1, (Date.now() - startedAt) / 1000)))
            : null
      }
    });
  }

  try {
    await updateProgress(true);
    await prisma.vfsMount.updateMany({
      where: { nzbDocumentId: input.nzbDocumentId },
      data: { status: "prepared", streamable: true }
    });
    await prisma.download.update({
      where: { id: input.downloadId },
      data: { status: "prepared", progress: 99, downloaded: verifiedBytes, speedBytesSec: 0, etaSeconds: null, error: null }
    });
    return { status: "prepared", verifiedSegments: verified };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "stream preparation failed";
    const message = humanizeDownloadError(rawMessage) ?? rawMessage;
    if (isProviderConnectionLimit(message)) {
      await prisma.vfsMount.updateMany({
        where: { nzbDocumentId: input.nzbDocumentId },
        data: { status: "waiting_for_provider", streamable: false }
      });
      await prisma.download.update({
        where: { id: input.downloadId },
        data: { status: "waiting_for_provider", error: "Usenet provider reports too many active connections; retrying automatically", speedBytesSec: 0 }
      });
      throw error;
    }
    await prisma.vfsMount.updateMany({
      where: { nzbDocumentId: input.nzbDocumentId },
      data: { status: "failed", streamable: false }
    });
    await prisma.download.update({
      where: { id: input.downloadId },
      data: { status: "failed", error: message, speedBytesSec: 0 }
    });
    await prisma.failedRelease.create({ data: { title: nzb.title, guid: nzb.guid, reason: rawMessage, downloadId: input.downloadId } });
    throw error;
  } finally {
    await pool.close();
  }
}

export async function getNzbImportMode(nzbDocumentId: string): Promise<NzbImportMode> {
  const nzb = await loadNzbDocument(nzbDocumentId);
  if (!nzb) throw new Error("NZB document not found");
  return classifyNzbImportMode(nzb);
}

export async function getNzbImportPlan(nzbDocumentId: string): Promise<NzbImportPlan> {
  const nzb = await loadNzbDocument(nzbDocumentId);
  if (!nzb) throw new Error("NZB document not found");
  return classifyNzbImportPlan(nzb);
}

export async function downloadNzbDocument(input: { downloadId: string; nzbDocumentId: string; logger: FastifyBaseLogger }) {
  const nzb = await loadNzbDocument(input.nzbDocumentId);
  if (!nzb) throw new Error("NZB document not found");

  const providers = await getProviders();
  if (providers.length === 0) {
    await prisma.download.update({
      where: { id: input.downloadId },
      data: { status: "waiting_for_provider", error: "No enabled Usenet providers configured" }
    });
    return { status: "waiting_for_provider", files: [] };
  }

  await prisma.download.update({
    where: { id: input.downloadId },
    data: { status: "downloading", progress: 0, downloaded: 0, speedBytesSec: 0, etaSeconds: null, error: null }
  });

  const allowedConnections = await getAllowedDownloadConnections();
  const pool = new NntpPool(providers, Math.max(1, allowedConnections), input.logger, input.downloadId, "downloading");
  const files = [];
  let downloaded = 0;
  const startedAt = Date.now();
  try {
    for (const [fileIndex, file] of nzb.files.entries()) {
      const result = await reconstructFile({ ...input, nzb, file, fileIndex, pool, downloadedBefore: downloaded, startedAt });
      downloaded += result.bytes;
      files.push(result);
    }
    await prisma.download.update({
      where: { id: input.downloadId },
      data: { status: "completed", progress: 100, downloaded, speedBytesSec: 0, etaSeconds: 0, completedAt: new Date() }
    });
    return { status: "completed", files };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "download failed";
    const message = humanizeDownloadError(rawMessage) ?? rawMessage;
    await prisma.download.update({
      where: { id: input.downloadId },
      data: { status: "failed", error: message, speedBytesSec: 0 }
    });
    await prisma.failedRelease.create({ data: { title: nzb.title, guid: nzb.guid, reason: rawMessage, downloadId: input.downloadId } });
    throw error;
  } finally {
    await pool.close();
  }
}
