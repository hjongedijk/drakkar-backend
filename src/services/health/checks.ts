import type { RepairJob, Symlink } from "../../repositories/db/prisma.js";

export type HealthOutcome = "healthy" | "repaired" | "deleted" | "unknown";
const STALE_RUNNING_REPAIR_MS = 10 * 60 * 1000;

export function classifyRepairOutcome(repair?: Pick<RepairJob, "type" | "status" | "message"> | null): HealthOutcome {
  if (!repair) return "unknown";
  const message = (repair.message ?? "").toLowerCase();
  const type = repair.type.toLowerCase();
  if (message.includes("deleted")) return "deleted";
  if (repair.status === "completed" && (message.includes("repair completed") || (type.includes("repair") && !message.includes("verify passed")))) {
    return "repaired";
  }
  if (repair.status === "completed" && /(passed|playable video|healthy|verify passed)/i.test(repair.message ?? "")) {
    return "healthy";
  }
  return "unknown";
}

export function deriveImportHealth(input: {
  repair?: Pick<RepairJob, "type" | "status" | "message"> | null;
  primarySymlink?: Pick<Symlink, "status"> | null;
}) {
  const outcome = classifyRepairOutcome(input.repair);
  if (outcome === "deleted" || outcome === "repaired") return outcome;
  if (outcome === "healthy") return "healthy";
  if (!input.primarySymlink || input.primarySymlink.status === "ok") return "healthy";
  return "unknown";
}

export function healthRepairIsActive(repair?: Pick<RepairJob, "status" | "updatedAt" | "startedAt"> | null) {
  if (!repair || repair.status !== "running") return false;
  const lastTouch = repair.updatedAt ?? repair.startedAt;
  if (!lastTouch) return false;
  return Date.now() - new Date(lastTouch).getTime() < STALE_RUNNING_REPAIR_MS;
}

export function estimateHealthProgress(repair?: Pick<RepairJob, "type" | "status" | "message" | "updatedAt" | "startedAt"> | null) {
  if (!repair) return 0;
  if (!healthRepairIsActive(repair)) return 0;
  const message = (repair.message ?? "").toLowerCase();
  const type = repair.type.toLowerCase();
  if (message.includes("par2") || type.includes("repair")) return 70;
  if (type.includes("mounted")) return 45;
  return 20;
}

export function isCompletedHealthJob(repair: Pick<RepairJob, "status" | "completedAt" | "updatedAt">) {
  if (repair.status !== "completed") return false;
  return Boolean(repair.completedAt ?? repair.updatedAt);
}
