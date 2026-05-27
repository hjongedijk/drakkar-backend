import { getHealthOverview, getImportHealthChecks } from "../services/healthService.js";

export async function getHealthHandler() {
  return getHealthOverview();
}

export async function getHealthChecksHandler() {
  return getImportHealthChecks();
}
