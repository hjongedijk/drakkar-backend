import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../services/config/env.js";
import { prisma } from "../repositories/db/prisma.js";
import { safeUpdateDownload } from "./downloads/downloadState.js";
import { detectArchive } from "../services/extract/detect.js";
import { extractArchivesInPath } from "../services/extractService.js";
import { importCompletedPath } from "../services/importService.js";
import { verifyAndRepairPar2 } from "./par2Service.js";
import { listMountedFiles, statMountedPath } from "../services/mountedNzbService.js";
import { readMountedFileRange } from "../services/mountedStream.service.js";
import { BACKGROUND_REPAIR_INTERVAL_MS, BACKGROUND_REPAIR_TASK_ID, registerCoreTasks, resolveTaskIntervalMs } from "../workers/tasks/coreTasks.js";
import { getSettings } from "../services/settings/settingsStore.js";
import { runTrackedTask, setTaskNextRun } from "../workers/tasks/taskRegistry.js";
import { runRepairAssessmentMachine } from "../state-machines/repairAssessmentMachine.js";

const BACKGROUND_HEALTHCHECK_INITIAL_DELAY_MS = 30_000;
const BACKGROUND_HEALTHCHECK_MIN_ITEM_INTERVAL_MS = 6 * 60 * 60_000;
const BACKGROUND_HEALTHCHECK_MAX_ITEM_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const BACKGROUND_HEALTHCHECK_MAX_CHECKS_PER_SWEEP = 8;
const BACKGROUND_HEALTHCHECK_BACKLOG_CHECKS_PER_SWEEP = 32;
const BACKGROUND_HEALTHCHECK_BACKLOG_INTERVAL_MS = 5 * 60_000;
const BACKGROUND_HEALTHCHECK_STALE_RUNNING_MS = 30 * 60_000;
const BACKGROUND_MOUNTED_HEALTHCHECK_TYPE = "background-mounted-healthcheck";

async function toolAvailable(name: string) {
  const paths = (process.env.PATH ?? "").split(":").map((path) => join(path, name));
  for (const path of paths) {
    try {
      await access(path);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

async function listFiles(path: string): Promise<string[]> {
  const stats = await stat(path);
  if (!stats.isDirectory()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const children = await Promise.all(entries.map((entry) => listFiles(join(path, entry.name))));
  return children.flat();
}

function mountedVideoFiles(files: Awaited<ReturnType<typeof listMountedFiles>>) {
  return files.filter((file) => /\.(mkv|mp4|avi|mov|m4v|ts)$/i.test(file.name) && !/sample/i.test(file.name));
}

async function probeMountedVideo(path: string) {
  const head = await readMountedFileRange({
    path,
    start: 0,
    length: 64 * 1024,
    source: "api"
  });
  const mountedStats = await statMountedPath(path);
  const fileSize = mountedStats.size;
  if (fileSize <= head.length) return head.length;

  const midStart = Math.max(0, Math.floor(fileSize / 2) - 4096);
  const tailStart = Math.max(0, fileSize - 64 * 1024);
  const tinyTailStart = Math.max(0, fileSize - 8192);

  const [mid, tail, tinyTail] = await Promise.all([
    readMountedFileRange({
      path,
      start: midStart,
      length: 8192,
      source: "api"
    }),
    readMountedFileRange({
      path,
      start: tailStart,
      length: Math.min(64 * 1024, fileSize - tailStart),
      source: "api"
    }),
    readMountedFileRange({
      path,
      start: tinyTailStart,
      length: Math.min(8192, fileSize - tinyTailStart),
      source: "api"
    })
  ]);

  if (mid.length < Math.min(8192, Math.max(0, fileSize - midStart))) throw new Error("mounted healthcheck short read in middle of file");
  if (tail.length < Math.min(64 * 1024, Math.max(0, fileSize - tailStart))) throw new Error("mounted healthcheck short read at tail of file");
  if (tinyTail.length < Math.min(8192, Math.max(0, fileSize - tinyTailStart))) throw new Error("mounted healthcheck short read at tiny tail window");
  return head.length + mid.length + tail.length + tinyTail.length;
}

export function listRepairJobs() {
  return prisma.repairJob.findMany({ orderBy: { createdAt: "desc" }, include: { download: true } });
}

export async function runRepair(downloadId: string) {
  await prisma.download.findUniqueOrThrow({ where: { id: downloadId }, select: { id: true } });
  const job = await prisma.repairJob.create({
    data: { downloadId, type: "post-download-healthcheck", status: "running", startedAt: new Date() }
  });
  const sourcePath = join(env.VFS_DOWNLOADS_DIR, downloadId);
  const messages: string[] = [];
  const outputs: string[] = [];
  let status = "completed";

  try {
    await stat(sourcePath);
  } catch {
    messages.push("download has no local payload path yet");
    status = "failed";
  }

  if (status !== "failed") {
    const files = await listFiles(sourcePath).catch(() => []);
    const hasPar2 = files.some((file) => file.toLowerCase().endsWith(".par2"));
    const archiveKinds = files.map(detectArchive).filter((kind) => kind !== "none");
    if (hasPar2) {
      await prisma.repairJob.update({ where: { id: job.id }, data: { type: "par2-verify-repair", message: "running PAR2 verify/repair" } });
      const par2 = await verifyAndRepairPar2(sourcePath);
      messages.push(par2.message);
      if (par2.output) outputs.push(par2.output);
      if (par2.status === "failed" || par2.status === "tool_missing") status = "needs_attention";
    }
    if (archiveKinds.length > 0 && !(await toolAvailable("7z")) && !(await toolAvailable("unrar"))) messages.push("archives detected but no extractor is installed");
    if (files.length === 0) messages.push("no completed files available for repair/import");
  }

  if (messages.some((message) => message.includes("not installed") || message.includes("no completed"))) status = "needs_attention";

  return prisma.repairJob.update({
    where: { id: job.id },
    data: { status, message: messages.join("; ") || "healthcheck passed", output: outputs.join("\n\n") || undefined, completedAt: new Date() }
  });
}

async function assessMountedDownload(downloadId: string) {
  const download = await prisma.download.findUnique({
    where: { id: downloadId },
    include: { nzbDocument: true }
  });
  if (!download?.nzbDocumentId) return null;

  const existing = await prisma.repairJob.findFirst({
    where: {
      downloadId,
      type: BACKGROUND_MOUNTED_HEALTHCHECK_TYPE
    },
    orderBy: { createdAt: "desc" }
  });
  if (existing && Date.now() - existing.createdAt.getTime() < 15 * 60 * 1000) return existing;

  const job = await prisma.repairJob.create({
    data: {
      downloadId,
      type: BACKGROUND_MOUNTED_HEALTHCHECK_TYPE,
      status: "running",
      startedAt: new Date(),
      message: "checking mounted NZB for playable video files"
    }
  });

  await runRepairAssessmentMachine({
    handlers: {
      createJob: async () => job,
      listFiles: async () => listMountedFiles(`/mounted/releases/${download.nzbDocumentId}`),
      pickVideos: mountedVideoFiles,
      probeVideo: async (video) => probeMountedVideo(video.path),
      finalize: async (createdJob, result) => {
        if (result.status === "needs_attention" && /no playable video files found/i.test(result.message)) {
          await safeUpdateDownload(downloadId, { error: result.message }).catch(() => undefined);
        }
        return prisma.repairJob.update({
          where: { id: createdJob.id },
          data: {
            status: result.status,
            message: result.message,
            completedAt: new Date()
          }
        });
      }
    }
  });
  return prisma.repairJob.findUniqueOrThrow({ where: { id: job.id } });
}

let repairTimer: NodeJS.Timeout | undefined;

function clampMs(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function nextBackgroundHealthcheckAt(input: { createdAt: Date; lastCheckedAt: Date | null }) {
  if (!input.lastCheckedAt) return null;
  const itemAgeAtLastCheck = Math.max(0, input.lastCheckedAt.getTime() - input.createdAt.getTime());
  const delayMs = clampMs(itemAgeAtLastCheck, BACKGROUND_HEALTHCHECK_MIN_ITEM_INTERVAL_MS, BACKGROUND_HEALTHCHECK_MAX_ITEM_INTERVAL_MS);
  return new Date(input.lastCheckedAt.getTime() + delayMs);
}

export async function runBackgroundRepairSweep(logger: { warn: (...args: unknown[]) => void }) {
  const summary = await runTrackedTask(BACKGROUND_REPAIR_TASK_ID, async () => {
    const downloads = await prisma.download.findMany({
      where: {
        status: { in: ["available", "completed"] }
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });
    const latestHealthJobs = await prisma.repairJob.findMany({
      where: {
        type: BACKGROUND_MOUNTED_HEALTHCHECK_TYPE,
        downloadId: { in: downloads.map((download) => download.id) }
      },
      orderBy: [{ downloadId: "asc" }, { createdAt: "desc" }],
      distinct: ["downloadId"],
      select: { downloadId: true, status: true, completedAt: true, updatedAt: true }
    });
    const latestHealthJobByDownload = new Map(latestHealthJobs.map((job) => [job.downloadId, job]));
    const now = Date.now();
    const uncheckedDownloads = downloads.filter((download) => {
      const latest = latestHealthJobByDownload.get(download.id);
      return !(latest?.completedAt ?? latest?.updatedAt);
    }).length;
    const maxChecksPerSweep = uncheckedDownloads > 0
      ? BACKGROUND_HEALTHCHECK_BACKLOG_CHECKS_PER_SWEEP
      : BACKGROUND_HEALTHCHECK_MAX_CHECKS_PER_SWEEP;
    let skipped = 0;
    let checked = 0;
    let checkedUnchecked = 0;
    for (const download of downloads) {
      if (checked >= maxChecksPerSweep) break;
      const latest = latestHealthJobByDownload.get(download.id);
      if (latest?.status === "running") {
        const latestUpdatedAt = latest.updatedAt?.getTime?.() ?? 0;
        if (latestUpdatedAt > 0 && now - latestUpdatedAt <= BACKGROUND_HEALTHCHECK_STALE_RUNNING_MS) {
          skipped += 1;
          continue;
        }
        await prisma.repairJob.updateMany({
          where: {
            downloadId: download.id,
            type: BACKGROUND_MOUNTED_HEALTHCHECK_TYPE,
            status: "running"
          },
          data: {
            status: "needs_attention",
            message: "mounted healthcheck timed out before completion",
            completedAt: new Date()
          }
        }).catch(() => undefined);
      }
      const lastCheckedAt = latest?.completedAt ?? latest?.updatedAt ?? null;
      const nextRunAt = nextBackgroundHealthcheckAt({ createdAt: download.createdAt, lastCheckedAt });
      if (nextRunAt && nextRunAt.getTime() > now) {
        skipped += 1;
        continue;
      }
      if (!lastCheckedAt) checkedUnchecked += 1;
      await assessMountedDownload(download.id);
      checked += 1;
    }
    return {
      checked,
      skipped,
      total: downloads.length,
      uncheckedRemaining: Math.max(0, uncheckedDownloads - checkedUnchecked)
    };
  }).catch((error) => {
    logger.warn({ err: error }, "background repair sweep failed");
    return undefined;
  });
  const settings = await getSettings().catch(() => null);
  registerCoreTasks(settings ?? undefined);
  const intervalMs = resolveTaskIntervalMs(BACKGROUND_REPAIR_TASK_ID, settings) ?? BACKGROUND_REPAIR_INTERVAL_MS;
  const nextDelayMs = summary?.uncheckedRemaining ? Math.min(intervalMs, BACKGROUND_HEALTHCHECK_BACKLOG_INTERVAL_MS) : intervalMs;
  setTaskNextRun(BACKGROUND_REPAIR_TASK_ID, new Date(Date.now() + nextDelayMs));
  return { ...summary, nextDelayMs };
}

export function startBackgroundRepairSchedule(logger: { warn: (...args: unknown[]) => void }) {
  if (repairTimer) return;
  registerCoreTasks();
  void getSettings().then((settings) => registerCoreTasks(settings)).catch(() => undefined);
  const scheduleNext = async (delayMs?: number) => {
    const settings = await getSettings().catch(() => null);
    const intervalMs = resolveTaskIntervalMs(BACKGROUND_REPAIR_TASK_ID, settings) ?? BACKGROUND_REPAIR_INTERVAL_MS;
    const nextDelayMs = delayMs ?? intervalMs;
    repairTimer = setTimeout(async () => {
      const summary = await runBackgroundRepairSweep(logger);
      void scheduleNext(summary?.nextDelayMs ?? intervalMs);
    }, nextDelayMs);
    setTaskNextRun(BACKGROUND_REPAIR_TASK_ID, new Date(Date.now() + nextDelayMs));
  };
  void scheduleNext(BACKGROUND_HEALTHCHECK_INITIAL_DELAY_MS);
}

export function stopBackgroundRepairSchedule() {
  if (repairTimer) clearTimeout(repairTimer);
  repairTimer = undefined;
}

export async function blocklistFailedRelease(input: { title: string; guid?: string; reason: string; downloadId?: string }) {
  return prisma.failedRelease.create({ data: input });
}

export async function importDownloadPath(downloadId: string, path: string) {
  return importCompletedPath({ downloadId, sourcePath: path });
}

export async function extractDownloadPath(path: string) {
  return extractArchivesInPath(path);
}
