import { redis } from "../repositories/db/redis.js";
import { prisma } from "../repositories/db/prisma.js";
import { classifyRepairOutcome, deriveImportHealth, estimateHealthProgress, healthRepairIsActive, isCompletedHealthJob } from "../services/health/checks.js";
import { listAvailableDownloadsForHealth, listRecentRepairJobs, pingDatabase } from "../repositories/healthRepository.js";
import { DRAKKAR_VERSION } from "../models/version.js";
import { nextBackgroundHealthcheckAt } from "./repairService.js";

export async function getHealthOverview() {
  let database = "ok";
  let valkeyStatus = "ok";

  try {
    await pingDatabase();
  } catch {
    database = "error";
  }

  try {
    await redis.ping();
  } catch {
    valkeyStatus = "error";
  }

  const healthy = database === "ok" && valkeyStatus === "ok";
  const checks = [
    { name: "database", status: database },
    { name: "valkey", status: valkeyStatus }
  ];
  const servicesUp = checks.filter((check) => check.status === "ok").length;
  const servicesTotal = checks.length;

  return {
    status: healthy ? "ok" : "degraded",
    database,
    valkey: valkeyStatus,
    version: DRAKKAR_VERSION,
    servicesUp,
    servicesTotal,
    healthPercent: Math.round((servicesUp / servicesTotal) * 100),
    checks
  };
}

export async function getImportHealthChecks() {
  const [downloads, repairJobs, failedImportsCount, brokenSymlinksCount] = await Promise.all([
    listAvailableDownloadsForHealth(),
    listRecentRepairJobs(),
    prisma.importItem.count({ where: { status: "import_failed" } }),
    prisma.symlink.count({ where: { status: "broken" } })
  ]);

  const latestRepairByDownload = new Map<string, (typeof repairJobs)[number]>();
  for (const job of repairJobs) {
    if (!latestRepairByDownload.has(job.downloadId)) latestRepairByDownload.set(job.downloadId, job);
  }

  const scheduleItems = downloads.map((download) => {
    const repair = latestRepairByDownload.get(download.id);
    const latestImport = download.imports[0];
    const primarySymlink = latestImport?.symlinks[0];
    const lastCheck = repair?.completedAt ?? repair?.updatedAt ?? null;
    const nextCheck = nextBackgroundHealthcheckAt({ createdAt: download.createdAt, lastCheckedAt: lastCheck });
    const repairActive = healthRepairIsActive(repair);
    const activeProgress = estimateHealthProgress(repair);
    return {
      id: download.id,
      name: download.title,
      path: primarySymlink?.linkPath ?? latestImport?.completedPath ?? `/mounted/releases/${download.nzbDocumentId ?? download.id}`,
      createdAt: download.createdAt,
      lastCheckAt: lastCheck?.toISOString() ?? null,
      nextCheckAt: repairActive ? null : nextCheck?.toISOString() ?? null,
      progress: activeProgress,
      health: deriveImportHealth({ repair, primarySymlink }),
      status: repairActive ? "running" : "scheduled"
    };
  }).sort((a, b) => {
    const aDue = a.nextCheckAt ? Date.parse(a.nextCheckAt) : -1;
    const bDue = b.nextCheckAt ? Date.parse(b.nextCheckAt) : -1;
    return aDue - bDue || Date.parse(a.createdAt.toISOString()) - Date.parse(b.createdAt.toISOString());
  });

  const checkedItems = scheduleItems.filter((item) => item.lastCheckAt);
  const runningChecks = scheduleItems.filter((item) => item.status === "running").length;
  const totalChecked = checkedItems.length;
  const healthyCount = checkedItems.filter((item) => item.health === "healthy").length;
  const repairedCount = checkedItems.filter((item) => item.health === "repaired").length;
  const deletedCount = checkedItems.filter((item) => item.health === "deleted").length;
  const uncheckedCount = scheduleItems.length - totalChecked;
  const recentResults = repairJobs
    .filter((job) => isCompletedHealthJob(job))
    .slice(0, 25)
    .map((job) => ({
      id: job.id,
      downloadId: job.downloadId,
      completedAt: (job.completedAt ?? job.updatedAt).toISOString(),
      outcome: classifyRepairOutcome(job),
      message: job.message ?? ""
    }));

  return {
    overview: {
      totalChecked,
      healthy: healthyCount,
      repaired: repairedCount,
      deleted: deletedCount,
      running: runningChecks,
      pending: uncheckedCount,
      failedImports: failedImportsCount,
      brokenSymlinks: brokenSymlinksCount
    },
    uncheckedCount,
    schedule: scheduleItems.slice(0, 100),
    recentResults
  };
}
