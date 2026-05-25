import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { detectArchive } from "../extract/detect.js";
import { extractArchivesInPath } from "../extract/extractService.js";
import { importCompletedPath } from "../import/importService.js";
import { verifyAndRepairPar2 } from "./par2Service.js";
import { listMountedFiles } from "../vfs/mountedNzbService.js";
import { readMountedFileRange } from "../streaming/mountedStream.service.js";
import { BACKGROUND_REPAIR_INTERVAL_MS, BACKGROUND_REPAIR_TASK_ID, registerCoreTasks, resolveTaskIntervalMs } from "../tasks/coreTasks.js";
import { getSettings } from "../settings/settingsStore.js";
import { runTrackedTask, setTaskNextRun } from "../tasks/taskRegistry.js";

const BACKGROUND_HEALTHCHECK_INITIAL_DELAY_MS = 5 * 60_000;
const BACKGROUND_HEALTHCHECK_MIN_ITEM_INTERVAL_MS = 6 * 60 * 60_000;
const BACKGROUND_HEALTHCHECK_MAX_ITEM_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const BACKGROUND_HEALTHCHECK_MAX_CHECKS_PER_SWEEP = 25;
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
  const fileSize = await stat(path).then((row) => row.size);
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

  try {
    const files = await listMountedFiles(`/mounted/releases/${download.nzbDocumentId}`);
    const videos = mountedVideoFiles(files);
    let probedBytes = 0;
    if (videos[0]) probedBytes = await probeMountedVideo(videos[0].path);
    const status = videos.length > 0 && probedBytes > 0 ? "completed" : "needs_attention";
    const message = videos.length > 0 && probedBytes > 0
      ? `mounted healthcheck passed: ${videos.length} playable video file(s); probed ${probedBytes} bytes`
      : videos.length > 0
        ? "mounted healthcheck failed: could not probe stream bytes from mounted video"
        : "mounted healthcheck failed: no playable video files found";
    if (videos.length === 0) {
      await prisma.download.update({
        where: { id: downloadId },
        data: { error: message }
      }).catch(() => undefined);
    }
    return prisma.repairJob.update({
      where: { id: job.id },
      data: {
        status,
        message,
        completedAt: new Date()
      }
    });
  } catch (error) {
    return prisma.repairJob.update({
      where: { id: job.id },
      data: {
        status: "needs_attention",
        message: error instanceof Error ? error.message : "mounted healthcheck failed",
        completedAt: new Date()
      }
    });
  }
}

let repairTimer: NodeJS.Timeout | undefined;
let initialRepairTimer: NodeJS.Timeout | undefined;

function clampMs(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function nextBackgroundHealthcheckAt(input: { createdAt: Date; lastCheckedAt: Date | null }) {
  if (!input.lastCheckedAt) return null;
  const itemAgeAtLastCheck = Math.max(0, input.lastCheckedAt.getTime() - input.createdAt.getTime());
  const delayMs = clampMs(itemAgeAtLastCheck, BACKGROUND_HEALTHCHECK_MIN_ITEM_INTERVAL_MS, BACKGROUND_HEALTHCHECK_MAX_ITEM_INTERVAL_MS);
  return new Date(input.lastCheckedAt.getTime() + delayMs);
}

export async function runBackgroundRepairSweep(logger: { warn: (...args: unknown[]) => void }) {
  await runTrackedTask(BACKGROUND_REPAIR_TASK_ID, async () => {
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
    let skipped = 0;
    let checked = 0;
    for (const download of downloads) {
      if (checked >= BACKGROUND_HEALTHCHECK_MAX_CHECKS_PER_SWEEP) break;
      const latest = latestHealthJobByDownload.get(download.id);
      if (latest?.status === "running") {
        skipped += 1;
        continue;
      }
      const lastCheckedAt = latest?.completedAt ?? latest?.updatedAt ?? null;
      const nextRunAt = nextBackgroundHealthcheckAt({ createdAt: download.createdAt, lastCheckedAt });
      if (nextRunAt && nextRunAt.getTime() > now) {
        skipped += 1;
        continue;
      }
      await assessMountedDownload(download.id);
      checked += 1;
    }
    return { checked, skipped, total: downloads.length };
  }).catch((error) => {
    logger.warn({ err: error }, "background repair sweep failed");
  });
  const settings = await getSettings().catch(() => null);
  registerCoreTasks(settings ?? undefined);
  const intervalMs = resolveTaskIntervalMs(BACKGROUND_REPAIR_TASK_ID, settings) ?? BACKGROUND_REPAIR_INTERVAL_MS;
  setTaskNextRun(BACKGROUND_REPAIR_TASK_ID, new Date(Date.now() + intervalMs));
}

export function startBackgroundRepairSchedule(logger: { warn: (...args: unknown[]) => void }) {
  if (repairTimer || initialRepairTimer) return;
  void getSettings().then((settings) => registerCoreTasks(settings)).catch(() => registerCoreTasks());
  setTaskNextRun(BACKGROUND_REPAIR_TASK_ID, new Date(Date.now() + BACKGROUND_HEALTHCHECK_INITIAL_DELAY_MS));
  initialRepairTimer = setTimeout(() => {
    initialRepairTimer = undefined;
    void runBackgroundRepairSweep(logger);
  }, BACKGROUND_HEALTHCHECK_INITIAL_DELAY_MS);
  const scheduleNext = async () => {
    const settings = await getSettings().catch(() => null);
    const intervalMs = resolveTaskIntervalMs(BACKGROUND_REPAIR_TASK_ID, settings) ?? BACKGROUND_REPAIR_INTERVAL_MS;
    repairTimer = setTimeout(async () => {
      await runBackgroundRepairSweep(logger);
      void scheduleNext();
    }, intervalMs);
  };
  void scheduleNext();
}

export function stopBackgroundRepairSchedule() {
  if (initialRepairTimer) clearTimeout(initialRepairTimer);
  if (repairTimer) clearTimeout(repairTimer);
  initialRepairTimer = undefined;
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
