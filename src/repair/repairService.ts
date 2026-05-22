import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { repairQueue } from "../queues/downloadQueue.js";
import { detectArchive } from "../extract/detect.js";
import { extractArchivesInPath } from "../extract/extractService.js";
import { importCompletedPath } from "../import/importService.js";
import { verifyAndRepairPar2 } from "./par2Service.js";
import { listMountedFiles } from "../vfs/mountedNzbService.js";
import { readMountedFileRange } from "../streaming/mountedStream.service.js";
import { BACKGROUND_REPAIR_INTERVAL_MS, BACKGROUND_REPAIR_TASK_ID, registerCoreTasks } from "../tasks/coreTasks.js";
import { runTrackedTask, setTaskNextRun } from "../tasks/taskRegistry.js";

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
  const probe = await readMountedFileRange({
    path,
    start: 0,
    length: 64 * 1024,
    source: "api"
  });
  return probe.length;
}

export function listRepairJobs() {
  return prisma.repairJob.findMany({ orderBy: { createdAt: "desc" }, include: { download: true } });
}

export async function runRepair(downloadId: string) {
  const download = await prisma.download.findUniqueOrThrow({ where: { id: downloadId }, include: { nzbDocument: true } });
  const job = await prisma.repairJob.create({
    data: { downloadId, type: "post-download-healthcheck", status: "running", startedAt: new Date() }
  });
  await repairQueue.add("manual-repair", { downloadId, title: download.title });

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
      type: "background-mounted-healthcheck"
    },
    orderBy: { createdAt: "desc" }
  });
  if (existing && Date.now() - existing.createdAt.getTime() < 15 * 60 * 1000) return existing;

  const job = await prisma.repairJob.create({
    data: {
      downloadId,
      type: "background-mounted-healthcheck",
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

export async function runBackgroundRepairSweep(logger: { warn: (...args: unknown[]) => void }) {
  await runTrackedTask(BACKGROUND_REPAIR_TASK_ID, async () => {
    const downloads = await prisma.download.findMany({
      where: {
        status: { in: ["available", "completed"] }
      },
      select: { id: true }
    });
    for (const download of downloads) {
      await assessMountedDownload(download.id);
    }
    return { checked: downloads.length };
  }).catch((error) => {
    logger.warn({ err: error }, "background repair sweep failed");
  });
  setTaskNextRun(BACKGROUND_REPAIR_TASK_ID, new Date(Date.now() + BACKGROUND_REPAIR_INTERVAL_MS));
}

export function startBackgroundRepairSchedule(logger: { warn: (...args: unknown[]) => void }) {
  if (repairTimer || initialRepairTimer) return;
  registerCoreTasks();
  setTaskNextRun(BACKGROUND_REPAIR_TASK_ID, new Date(Date.now() + 30_000));
  initialRepairTimer = setTimeout(() => {
    initialRepairTimer = undefined;
    void runBackgroundRepairSweep(logger);
  }, 30_000);
  repairTimer = setInterval(() => {
    void runBackgroundRepairSweep(logger);
  }, BACKGROUND_REPAIR_INTERVAL_MS);
}

export function stopBackgroundRepairSchedule() {
  if (initialRepairTimer) clearTimeout(initialRepairTimer);
  if (repairTimer) clearInterval(repairTimer);
  initialRepairTimer = undefined;
  repairTimer = undefined;
}

export async function runCompletedHealthcheck() {
  const downloads = await prisma.download.findMany({ where: { status: { in: ["completed", "queued"] } } });
  const jobs = [];
  for (const download of downloads) jobs.push(await runRepair(download.id));
  return { checked: jobs.length, jobs };
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
