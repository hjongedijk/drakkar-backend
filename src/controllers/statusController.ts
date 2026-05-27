import { getDiagnosticsStatus, getSystemStatus, getUsenetDebugStatus } from "../services/statusService.js";

export async function getStatusHandler() {
  return getSystemStatus();
}

export async function getDiagnosticsHandler() {
  return getDiagnosticsStatus();
}

export async function getUsenetDebugHandler() {
  return getUsenetDebugStatus();
}
