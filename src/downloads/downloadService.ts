import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { nzbDownloadQueue, queueDownloadJob } from "../queues/downloadQueue.js";
import { parseNzbXml, type ParsedNzb } from "../nzb/parser.js";
import { storeNzbDocument } from "../nzb/store.js";
import { createBlocklistItem, getPolicySettings } from "../policies/policyService.js";
import { getSettings } from "../settings/settingsStore.js";
import { fetchNzbUrl } from "../usenet/nzbUrlFetch.js";
import { makeMountedDownloadAvailable } from "../import/importService.js";
import { humanizeDownloadError, statusLabelForDownload } from "./presentation.js";

const DOWNLOAD_QUEUE_CACHE_MS = 2_000;
const DOWNLOAD_HISTORY_CACHE_MS = 5_000;
let cachedQueue: { value: Awaited<ReturnType<typeof buildQueue>>; expiresAt: number } | null = null;
let cachedHistory: { value: Awaited<ReturnType<typeof buildHistory>>; expiresAt: number } | null = null;

function safeNzbName(name: string) {
  const cleaned = name.replace(/[^a-z0-9._-]+/gi, "_") || randomUUID();
  return extname(cleaned).toLowerCase() === ".nzb" ? cleaned : `${cleaned}.nzb`;
}

class NzbPolicyError extends Error {}

function isDuplicateGuidError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002"
    && Array.isArray(error.meta?.target)
    && error.meta.target.includes("guid");
}

async function existingDownloadForGuid(guid?: string | null) {
  if (!guid) return null;
  const document = await prisma.nzbDocument.findUnique({
    where: { guid },
    include: { download: true }
  });
  const download = document?.download ?? null;
  if (!download) return null;
  if (["failed", "cancelled"].includes(download.status)) return null;
  return download;
}

export async function findReusableDownload(input: { guid?: string | null; title?: string | null }) {
  const byGuid = await existingDownloadForGuid(input.guid);
  if (byGuid) return byGuid;
  if (!input.title) return null;
  return prisma.download.findFirst({
    where: {
      title: { equals: input.title, mode: "insensitive" },
      status: { notIn: ["failed", "cancelled", "replaced"] }
    },
    orderBy: { createdAt: "desc" }
  });
}

async function attachExistingDownloadToRequest(requestId: string | undefined, downloadId: string, title?: string) {
  if (!requestId) return;
  const request = await prisma.mediaRequest.findUnique({ where: { id: requestId } });
  if (!request) return;
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      downloadId,
      status: ["available", "completed"].includes(request.status) ? request.status : "grabbed",
      ...(title ? { title: request.title || title } : {})
    }
  }).catch(() => undefined);
}

async function uniqueNzbName(name: string) {
  const filename = safeNzbName(name);
  const ext = extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? filename : `${base}-${index + 1}${ext}`;
    try {
      await access(join(env.VFS_NZB_DIR, candidate));
    } catch {
      return candidate;
    }
  }
  return `${base}-${randomUUID()}${ext}`;
}

function contentHash(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

async function writeNzbBackupIfEnabled(path: string, content: Buffer) {
  const settings = await getSettings();
  if (!settings.backupNzbFiles) return null;
  await mkdir(env.NZB_BACKUPS_DIR, { recursive: true });
  await writeFile(path, content);
  return path;
}

function hasPotentialVideoPayload(parsed: ParsedNzb) {
  if (parsed.files.length === 0 || parsed.segmentCount === 0) return false;
  return parsed.files.some((file) => /\.(mkv|mp4|avi|mov|m4v|ts|zip|7z|rar|part\d+\.rar)(?:["_\s).]|$)/i.test(file.subject))
    || parsed.fileCount > 0;
}

function isQueueRecoveryMessage(error: string | null) {
  return error === "Queue entry has no active worker job yet"
    || error === "Recovered queued download with missing worker job"
    || error === "Recovered interrupted download; existing queue job retained"
    || error === "Recovered interrupted download; queued to continue";
}

export function invalidateDownloadViewCache() {
  cachedQueue = null;
  cachedHistory = null;
}

export async function storeNzbForDownload(input: {
  downloadId: string;
  filename?: string;
  content: string | Buffer;
  title?: string;
  guid?: string;
}) {
  await mkdir(env.VFS_NZB_DIR, { recursive: true });
  const policies = await getPolicySettings();
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
  const parsed = parseNzbXml(content.toString("utf8"), input.title ?? input.filename ?? "NZB upload");
  const duplicateKey = input.guid ?? contentHash(content);

  if (policies.failNzbWithoutVideo && !hasPotentialVideoPayload(parsed)) {
    const reason = "NZB appears empty or contains no usable file segments";
    await prisma.download.update({ where: { id: input.downloadId }, data: { status: "failed", error: reason, size: parsed.totalSize } });
    await createBlocklistItem({ guid: duplicateKey, title: input.title ?? parsed.title, reason: "no_video_content", source: "nzb-policy" });
    throw new NzbPolicyError(reason);
  }

  const existing = await prisma.nzbDocument.findUnique({ where: { guid: duplicateKey }, include: { download: true } });
  let documentGuid = duplicateKey;
  if (existing) {
    const reason = `duplicate NZB already exists as ${existing.title}`;
    if (policies.duplicateNzbBehavior === "mark_failed" || policies.duplicateNzbBehavior === "ignore_existing") {
      await prisma.download.update({
        where: { id: input.downloadId },
        data: {
          status: policies.duplicateNzbBehavior === "ignore_existing" ? "cancelled" : "failed",
          error: reason,
          size: existing.totalSize
        }
      });
      await createBlocklistItem({ guid: duplicateKey, title: input.title ?? existing.title, reason: "duplicate_nzb", source: "nzb-policy" });
      throw new NzbPolicyError(reason);
    }
    if (policies.duplicateNzbBehavior === "replace_existing") {
      await prisma.nzbDocument.delete({ where: { id: existing.id } });
    } else {
      documentGuid = `${duplicateKey}-${randomUUID()}`;
    }
  }

  const filename = await uniqueNzbName(input.filename ?? input.title ?? input.downloadId);
  const path = join(env.VFS_NZB_DIR, filename);
  const backupPath = join(env.NZB_BACKUPS_DIR, filename);
  await writeFile(path, content);
  const storedBackupPath = await writeNzbBackupIfEnabled(backupPath, content);

  let nzbDocument;
  try {
    nzbDocument = await storeNzbDocument({ parsed, path, backupPath: storedBackupPath ?? undefined, guid: documentGuid });
  } catch (error) {
    if (!isDuplicateGuidError(error)) throw error;

    const existing = await prisma.nzbDocument.findUnique({ where: { guid: documentGuid }, include: { download: true } });
    const reason = `duplicate NZB already exists as ${existing?.title ?? input.title ?? parsed.title}`;

    if (policies.duplicateNzbBehavior === "download_again_with_suffix") {
      nzbDocument = await storeNzbDocument({
        parsed,
        path,
        backupPath: storedBackupPath ?? undefined,
        guid: `${duplicateKey}-${randomUUID()}`
      });
    } else if (policies.duplicateNzbBehavior === "replace_existing" && existing) {
      await prisma.nzbDocument.delete({ where: { id: existing.id } }).catch(() => undefined);
      nzbDocument = await storeNzbDocument({ parsed, path, backupPath: storedBackupPath ?? undefined, guid: documentGuid });
    } else {
      await prisma.download.update({
        where: { id: input.downloadId },
        data: {
          status: policies.duplicateNzbBehavior === "ignore_existing" ? "cancelled" : "failed",
          error: reason,
          size: existing?.totalSize ?? parsed.totalSize
        }
      }).catch(() => undefined);
      await createBlocklistItem({
        guid: documentGuid,
        title: input.title ?? existing?.title ?? parsed.title,
        reason: "duplicate_nzb",
        source: "nzb-policy-race"
      }).catch(() => undefined);
      throw new NzbPolicyError(reason);
    }
  }
  await prisma.download.update({
    where: { id: input.downloadId },
    data: {
      title: input.title ?? parsed.title,
      size: parsed.totalSize,
      nzbDocumentId: nzbDocument.id,
      error: parsed.valid ? null : parsed.errors.join("; ")
    }
  });
  return nzbDocument;
}

export async function addNzbUpload(input: { filename?: string; content: string | Buffer; title?: string; queueDownload?: boolean; category?: string }) {
  const queueDownload = input.queueDownload ?? true;
  const policies = await getPolicySettings();
  const category = input.category?.trim() || policies.manualUploadCategory;
  const download = await prisma.download.create({
    data: {
      title: input.title ?? input.filename ?? "NZB upload",
      source: `manual:${category}`,
      status: queueDownload ? "queued" : "mounted"
    }
  });
  let nzbDocument;
  try {
    nzbDocument = await storeNzbForDownload({ downloadId: download.id, ...input });
  } catch (error) {
    if (error instanceof NzbPolicyError) return prisma.download.findUniqueOrThrow({ where: { id: download.id } });
    return prisma.download.update({
      where: { id: download.id },
      data: { status: "failed", error: error instanceof Error ? error.message : "failed to import NZB" }
    });
  }
  if (!queueDownload) {
    await makeMountedDownloadAvailable({ downloadId: download.id });
    return prisma.download.findUniqueOrThrow({ where: { id: download.id }, include: { nzbDocument: true } });
  }

  const job = await queueDownloadJob(download, "parse-and-download", {
    downloadId: download.id,
    nzbDocumentId: nzbDocument.id,
    title: download.title
  });
  return prisma.download.update({ where: { id: download.id }, data: { jobId: job.id } });
}

export async function addNzbFromPath(path: string, title?: string, options?: { queueDownload?: boolean; guid?: string; requestId?: string }) {
  const policies = await getPolicySettings();
  const existingByGuid = await existingDownloadForGuid(options?.guid);
  if (existingByGuid && policies.duplicateNzbBehavior !== "replace_existing" && policies.duplicateNzbBehavior !== "download_again_with_suffix") {
    await attachExistingDownloadToRequest(options?.requestId, existingByGuid.id, title);
    return existingByGuid;
  }
  const existingByTitle = await findReusableDownload({ title });
  if (existingByTitle && policies.duplicateNzbBehavior !== "replace_existing" && policies.duplicateNzbBehavior !== "download_again_with_suffix") {
    await attachExistingDownloadToRequest(options?.requestId, existingByTitle.id, title);
    return existingByTitle;
  }

  const content = await readFile(path);
  const download = await prisma.download.create({
    data: {
      title: title ?? path.split("/").pop() ?? "NZB upload",
      source: "nzb",
      status: options?.queueDownload === false ? "mounted" : "queued"
    }
  });
  let nzbDocument;
  try {
    nzbDocument = await storeNzbForDownload({
      downloadId: download.id,
      filename: path.split("/").pop(),
      content,
      title,
      guid: options?.guid
    });
  } catch (error) {
    if (options?.guid) {
      const existing = await existingDownloadForGuid(options.guid);
      if (existing && policies.duplicateNzbBehavior !== "replace_existing" && policies.duplicateNzbBehavior !== "download_again_with_suffix") {
        await prisma.download.delete({ where: { id: download.id } }).catch(() => undefined);
        await attachExistingDownloadToRequest(options?.requestId, existing.id, title);
        return existing;
      }
    }
    if (error instanceof NzbPolicyError) return prisma.download.findUniqueOrThrow({ where: { id: download.id } });
    return prisma.download.update({
      where: { id: download.id },
      data: { status: "failed", error: error instanceof Error ? error.message : "failed to import NZB" }
    });
  }
  if (options?.queueDownload === false) {
    await attachExistingDownloadToRequest(options?.requestId, download.id, title ?? download.title);
    await makeMountedDownloadAvailable({ downloadId: download.id });
    return prisma.download.findUniqueOrThrow({ where: { id: download.id }, include: { nzbDocument: true } });
  }

  await attachExistingDownloadToRequest(options?.requestId, download.id, title ?? download.title);
  const job = await queueDownloadJob(download, "parse-and-download", {
    downloadId: download.id,
    nzbDocumentId: nzbDocument.id,
    title: download.title,
    requestId: options?.requestId
  });
  return prisma.download.update({ where: { id: download.id }, data: { jobId: job.id } });
}

export async function addUrl(url: string, title?: string) {
  const download = await prisma.download.create({
    data: { title: title ?? url, source: url, status: "fetching_nzb" }
  });
  try {
    const fetched = await fetchNzbUrl(url);
    const document = await storeNzbForDownload({
      downloadId: download.id,
      filename: fetched.filename,
      content: fetched.buffer,
      title: title ?? fetched.filename
    });
    const queued = await prisma.download.update({
      where: { id: download.id },
      data: { status: "queued", nzbDocumentId: document.id, error: fetched.looksLikeNzb ? null : "URL response did not look like an NZB but parsed successfully" },
      include: { nzbDocument: true }
    });
    const job = await queueDownloadJob(queued, "prepare-url-nzb", {
      downloadId: download.id,
      nzbDocumentId: document.id,
      title: queued.title
    });
    return prisma.download.update({ where: { id: download.id }, data: { jobId: job.id }, include: { nzbDocument: true } });
  } catch (error) {
    return prisma.download.update({
      where: { id: download.id },
      data: { status: "failed", error: error instanceof Error ? error.message : "failed to fetch NZB URL" }
    });
  }
}

async function buildQueue() {
  const [downloads, activeJobs, waitingJobs, delayedJobs, prioritizedJobs] = await Promise.all([
    prisma.download.findMany({
      where: {
        status: { in: ["mounted", "queued", "fetching_nzb", "verifying", "prepared", "downloading", "paused", "waiting_for_provider", "waiting_for_nzb"] },
        OR: [{ status: { not: "queued" } }, { nzbDocumentId: { not: null } }, { jobId: { not: null } }]
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      include: { nzbDocument: true }
    }),
    nzbDownloadQueue.getJobs(["active"], 0, 500, true),
    nzbDownloadQueue.getJobs(["waiting"], 0, 500, true),
    nzbDownloadQueue.getJobs(["delayed"], 0, 500, true),
    nzbDownloadQueue.getJobs(["prioritized"], 0, 500, true)
  ]);
  const jobStateByDownloadId = new Map<string, { id: string; state: "active" | "waiting" | "delayed" | "prioritized" }>();
  for (const [state, jobs] of [
    ["active", activeJobs],
    ["waiting", waitingJobs],
    ["delayed", delayedJobs],
    ["prioritized", prioritizedJobs]
  ] as const) {
    for (const job of jobs) {
      const downloadId = String(job.data?.downloadId ?? "");
      if (!downloadId || jobStateByDownloadId.has(downloadId)) continue;
      jobStateByDownloadId.set(downloadId, { id: String(job.id), state });
    }
  }
  const liveOrder = new Map<string, number>();
  let liveIndex = 0;
  for (const jobs of [activeJobs, waitingJobs, prioritizedJobs, delayedJobs]) {
    for (const job of jobs) {
      const downloadId = String(job.data?.downloadId ?? "");
      if (!downloadId || liveOrder.has(downloadId)) continue;
      liveOrder.set(downloadId, liveIndex);
      liveIndex += 1;
    }
  }

  const normalized = await Promise.all(
    downloads.map(async (download) => {
      const liveJob = jobStateByDownloadId.get(download.id);
      let nextStatus = download.status;
      let nextJobId = download.jobId ? String(download.jobId) : null;
      let nextError = isQueueRecoveryMessage(download.error) ? null : download.error;

      if (liveJob) {
        nextJobId = liveJob.id;
        if (liveJob.state === "active" && download.status !== "paused") nextStatus = "downloading";
        if ((liveJob.state === "waiting" || liveJob.state === "delayed" || liveJob.state === "prioritized") && download.status !== "paused") nextStatus = "queued";
      } else if (download.status === "queued" || download.status === "downloading" || download.status === "fetching_nzb" || download.status === "verifying" || download.status === "waiting_for_provider" || download.status === "waiting_for_nzb") {
        nextStatus = "queued";
        nextJobId = null;
        nextError = "Queue entry has no active worker job yet";
      }

      if (nextStatus !== download.status || nextJobId !== (download.jobId ? String(download.jobId) : null) || nextError !== download.error) {
        await prisma.download.update({
          where: { id: download.id },
          data: {
            status: nextStatus,
            jobId: nextJobId,
            error: nextError
          }
        }).catch(() => undefined);
      }

      return {
        ...download,
        status: nextStatus,
        jobId: nextJobId,
        error: humanizeDownloadError(nextError),
        statusLabel: statusLabelForDownload(nextStatus, nextError)
      };
    })
  );

  return normalized.sort((a, b) => {
    const statusRank: Record<string, number> = {
      downloading: 0,
      verifying: 1,
      fetching_nzb: 2,
      prepared: 3,
      waiting_for_provider: 4,
      waiting_for_nzb: 5,
      queued: 6,
      paused: 7,
      mounted: 8
    };
    const aRank = statusRank[a.status] ?? 50;
    const bRank = statusRank[b.status] ?? 50;
    if (aRank !== bRank) return aRank - bRank;
    if ((b.speedBytesSec ?? 0) !== (a.speedBytesSec ?? 0)) return (b.speedBytesSec ?? 0) - (a.speedBytesSec ?? 0);
    const aLive = liveOrder.get(a.id);
    const bLive = liveOrder.get(b.id);
    if (aLive !== undefined || bLive !== undefined) {
      if (aLive === undefined) return 1;
      if (bLive === undefined) return -1;
      return aLive - bLive;
    }
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

export async function getQueue() {
  if (cachedQueue && cachedQueue.expiresAt > Date.now()) return cachedQueue.value;
  const value = await buildQueue();
  cachedQueue = { value, expiresAt: Date.now() + DOWNLOAD_QUEUE_CACHE_MS };
  return value;
}

function paginateDownloads<T>(items: T[], page = 1, limit = 25) {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const offset = (safePage - 1) * safeLimit;
  return {
    items: items.slice(offset, offset + safeLimit),
    page: safePage,
    limit: safeLimit,
    total,
    totalPages
  };
}

export async function getQueuePage(input?: { page?: number; limit?: number }) {
  return paginateDownloads(await getQueue(), input?.page, input?.limit);
}

async function buildHistory() {
  return prisma.download.findMany({
    where: { status: { in: ["available", "completed", "failed", "cancelled"] } },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { nzbDocument: true }
  }).then((downloads) =>
    downloads.map((download) => ({
      ...download,
      error: humanizeDownloadError(download.error),
      statusLabel: statusLabelForDownload(download.status, download.error)
    }))
  );
}

export async function getHistory() {
  if (cachedHistory && cachedHistory.expiresAt > Date.now()) return cachedHistory.value;
  const value = await buildHistory();
  cachedHistory = { value, expiresAt: Date.now() + DOWNLOAD_HISTORY_CACHE_MS };
  return value;
}

export async function getHistoryPage(input?: { page?: number; limit?: number }) {
  return paginateDownloads(await getHistory(), input?.page, input?.limit);
}

export async function cleanupDownloadHistory(input?: { keepFailed?: number; keepCancelled?: number }) {
  const keepFailed = input?.keepFailed ?? 0;
  const keepCancelled = input?.keepCancelled ?? 0;
  const terminalDownloads = await prisma.download.findMany({
    where: {
      OR: [
        { status: { in: ["failed", "cancelled"] } },
        { status: "queued", nzbDocumentId: null, jobId: null }
      ]
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true, nzbDocumentId: true, error: true }
  });
  const seen: Record<string, number> = { failed: 0, cancelled: 0 };
  const toDelete = terminalDownloads.filter((download) => {
    if (/duplicate nzb already exists|unique constraint failed on the fields: \(`guid`\)/i.test(download.error ?? "")) return true;
    const count = (seen[download.status] ?? 0) + 1;
    seen[download.status] = count;
    if (download.status === "queued") return true;
    return download.status === "failed" ? count > keepFailed : count > keepCancelled;
  });
  const cleanedFailedJobs = await nzbDownloadQueue.clean(0, 1000, "failed").catch(() => []);
  if (toDelete.length === 0) {
    return {
      deleted: 0,
      cleanedFailedJobs: cleanedFailedJobs.length,
      keptFailed: Math.min(seen.failed ?? 0, keepFailed),
      keptCancelled: Math.min(seen.cancelled ?? 0, keepCancelled)
    };
  }

  const documentIds = toDelete.flatMap((download) => (download.nzbDocumentId ? [download.nzbDocumentId] : []));
  const deleteIds = toDelete.map((download) => download.id);
  await prisma.mediaRequest.updateMany({
    where: { downloadId: { in: deleteIds } },
    data: { downloadId: null }
  }).catch(() => undefined);
  await prisma.download.deleteMany({ where: { id: { in: deleteIds } } });
  if (documentIds.length > 0) {
    await prisma.nzbDocument.deleteMany({ where: { id: { in: documentIds } } }).catch(() => undefined);
  }
  await prisma.failedRelease.deleteMany({ where: { downloadId: { in: deleteIds } } }).catch(() => undefined);
  return {
    deleted: toDelete.length,
    cleanedFailedJobs: cleanedFailedJobs.length,
    keptFailed: Math.min(seen.failed ?? 0, keepFailed),
    keptCancelled: Math.min(seen.cancelled ?? 0, keepCancelled)
  };
}

export async function makeDownloadAvailable(id: string) {
  const request = await prisma.mediaRequest.findFirst({ where: { downloadId: id }, select: { id: true } });
  const existingImport = request ? null : await prisma.importItem.findFirst({ where: { downloadId: id, requestId: { not: null } }, select: { requestId: true } });
  return makeMountedDownloadAvailable({ downloadId: id, requestId: request?.id ?? existingImport?.requestId ?? undefined });
}

export async function setDownloadStatus(id: string, status: string) {
  const data = status === "completed" ? { status, completedAt: new Date() } : { status };
  return prisma.download.update({ where: { id }, data });
}

export async function enqueueDownload(id: string) {
  const download = await prisma.download.findUniqueOrThrow({ where: { id } });
  const job = await queueDownloadJob(download, "retry-download", {
    downloadId: download.id,
    nzbDocumentId: download.nzbDocumentId ?? undefined,
    title: download.title
  });
  return prisma.download.update({
    where: { id },
    data: {
      status: "queued",
      jobId: job.id,
      error: null,
      progress: 0,
      downloaded: 0,
      speedBytesSec: 0,
      etaSeconds: null
    }
  });
}

export async function deleteDownload(id: string) {
  await prisma.download.delete({ where: { id } });
  return { ok: true };
}
