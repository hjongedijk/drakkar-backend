import { getHealthOverview, getImportHealthChecks } from "../services/healthService.js";
import { DRAKKAR_VERSION } from "../models/version.js";

export async function getHealthHandler() {
  return {
    status: "ok",
    database: "unknown",
    valkey: "unknown",
    version: DRAKKAR_VERSION,
    servicesUp: 0,
    servicesTotal: 0,
    healthPercent: 100,
    checks: []
  };
}

export async function getHealthChecksHandler() {
  return getImportHealthChecks();
}
