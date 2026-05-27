import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { blocklistMatchSchema, ignoredTestSchema } from "../models/schemas/policySchemas.js";
import {
  blocklistQuerySchema,
  clearBlocklistItems,
  createBlocklistItem,
  deleteBlocklistItem,
  deleteExpiredBlocklistItems,
  getBlocklistStats,
  getIgnoredPatterns,
  getPolicySettings,
  getPolicyUsageReport,
  listBlocklist,
  matchBlocklistRelease,
  testIgnoredPath,
  updateBlocklistItem,
  updateIgnoredPatterns,
  updatePolicySettings
} from "../services/policyService.js";

function idParam(request: FastifyRequest) {
  return (request.params as { id: string }).id;
}

function guardAdmin(request: FastifyRequest, reply: FastifyReply) {
  return requireAdmin(request, reply);
}

export async function getPolicySettingsHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return getPolicySettings();
}

export async function getPolicyUsageHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return getPolicyUsageReport();
}

export async function updatePolicySettingsHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return updatePolicySettings(request.body);
}

export async function getIgnoredFilesHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return getIgnoredPatterns();
}

export async function updateIgnoredFilesHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return updateIgnoredPatterns(request.body);
}

export async function testIgnoredFileHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return testIgnoredPath(ignoredTestSchema.parse(request.body).path);
}

export async function listBlocklistHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return listBlocklist(blocklistQuerySchema.parse(request.query));
}

export async function getBlocklistStatsHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return getBlocklistStats();
}

export async function createBlocklistHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return createBlocklistItem(request.body);
}

export async function matchBlocklistHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return matchBlocklistRelease(blocklistMatchSchema.parse(request.body));
}

export async function updateBlocklistHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return updateBlocklistItem(idParam(request), request.body);
}

export async function deleteBlocklistHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return deleteBlocklistItem(idParam(request));
}

export async function cleanupExpiredBlocklistHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return deleteExpiredBlocklistItems();
}

export async function clearBlocklistHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!guardAdmin(request, reply)) return;
  return clearBlocklistItems();
}
