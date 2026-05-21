import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { classifyRepairOutcome, deriveImportHealth, estimateHealthProgress, isCompletedHealthJob } from "../health/checks.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            database: { type: "string" },
            valkey: { type: "string" },
            version: { type: "string" },
            servicesUp: { type: "number" },
            servicesTotal: { type: "number" },
            healthPercent: { type: "number" },
            checks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  status: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  }, async () => {
    let database = "ok";
    let valkeyStatus = "ok";

    try {
      await prisma.$queryRaw`SELECT 1`;
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
      version: "0.1.1",
      servicesUp,
      servicesTotal,
      healthPercent: Math.round((servicesUp / servicesTotal) * 100),
      checks
    };
  });

  app.get("/api/health/checks", async () => {
    const historyWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [imports, repairJobs] = await Promise.all([
      prisma.importItem.findMany({
        include: {
          symlinks: { orderBy: { updatedAt: "desc" } },
          request: true,
          download: true
        },
        orderBy: { createdAt: "desc" }
      }),
      prisma.repairJob.findMany({
        orderBy: { createdAt: "desc" }
      })
    ]);

    const latestRepairByDownload = new Map<string, (typeof repairJobs)[number]>();
    for (const job of repairJobs) {
      if (!latestRepairByDownload.has(job.downloadId)) latestRepairByDownload.set(job.downloadId, job);
    }

    const scheduleItems = imports.map((item) => {
      const repair = item.downloadId ? latestRepairByDownload.get(item.downloadId) : undefined;
      const primarySymlink = item.symlinks[0];
      const lastCheck = repair?.completedAt ?? repair?.updatedAt ?? null;
      const nextCheck = lastCheck ? new Date(lastCheck.getTime() + 10 * 60 * 1000) : null;
      const activeProgress = estimateHealthProgress(repair);
      return {
        id: item.id,
        name: item.title,
        path: primarySymlink?.linkPath ?? item.completedPath,
        createdAt: item.createdAt,
        lastCheckAt: lastCheck?.toISOString() ?? null,
        nextCheckAt: activeProgress > 0 ? null : nextCheck?.toISOString() ?? null,
        progress: activeProgress,
        health: deriveImportHealth({ repair, primarySymlink }),
        status: repair?.status ?? "scheduled"
      };
    }).sort((a, b) => {
      const aDue = a.nextCheckAt ? Date.parse(a.nextCheckAt) : -1;
      const bDue = b.nextCheckAt ? Date.parse(b.nextCheckAt) : -1;
      return aDue - bDue || Date.parse(a.createdAt.toISOString()) - Date.parse(b.createdAt.toISOString());
    });

    const recentResults = repairJobs
      .filter((job) => isCompletedHealthJob(job))
      .filter((job) => (job.completedAt ?? job.updatedAt) >= historyWindowStart)
      .map((job) => classifyRepairOutcome(job))
      .filter((outcome) => outcome !== "unknown");
    const totalChecked = recentResults.length;
    const healthyCount = recentResults.filter((item) => item === "healthy").length;
    const repairedCount = recentResults.filter((item) => item === "repaired").length;
    const deletedCount = recentResults.filter((item) => item === "deleted").length;
    const uncheckedCount = scheduleItems.filter((item) => !item.lastCheckAt).length;

    return {
      overview: {
        totalChecked,
        healthy: healthyCount,
        repaired: repairedCount,
        deleted: deletedCount
      },
      uncheckedCount,
      schedule: scheduleItems.slice(0, 50)
    };
  });
}
