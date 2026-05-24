import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createBlocklistItem,
  clearBlocklistItems,
  deleteBlocklistItem,
  deleteExpiredBlocklistItems,
  getBlocklistStats,
  getIgnoredPatterns,
  getPolicyUsageReport,
  getPolicySettings,
  listBlocklist,
  matchBlocklistRelease,
  testIgnoredPath,
  updateBlocklistItem,
  updateIgnoredPatterns,
  updatePolicySettings,
  blocklistQuerySchema
} from "../policies/policyService.js";

const ignoredTestSchema = z.object({
  path: z.string().min(1)
});

const blocklistMatchSchema = z.object({
  guid: z.string().optional(),
  title: z.string().min(1)
});

function idParam(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

export async function policyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/policies", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return getPolicySettings();
  });
  app.get("/api/settings/policies/usage", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return getPolicyUsageReport();
  });
  app.put("/api/settings/policies", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return updatePolicySettings(request.body);
  });

  app.get("/api/ignored-files", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return getIgnoredPatterns();
  });
  app.put("/api/ignored-files", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return updateIgnoredPatterns(request.body);
  });
  app.post("/api/ignored-files/test", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return testIgnoredPath(ignoredTestSchema.parse(request.body).path);
  });

  app.get("/api/blocklist", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return listBlocklist(blocklistQuerySchema.parse(request.query));
  });
  app.get("/api/blacklist", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return listBlocklist(blocklistQuerySchema.parse(request.query));
  });
  app.get("/api/blocklist/stats", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return getBlocklistStats();
  });
  app.get("/api/blacklist/stats", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return getBlocklistStats();
  });
  app.post("/api/blocklist", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return createBlocklistItem(request.body);
  });
  app.post("/api/blacklist", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return createBlocklistItem(request.body);
  });
  app.post("/api/blocklist/match", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return matchBlocklistRelease(blocklistMatchSchema.parse(request.body));
  });
  app.post("/api/blacklist/match", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return matchBlocklistRelease(blocklistMatchSchema.parse(request.body));
  });
  app.put("/api/blocklist/:id", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return updateBlocklistItem(idParam(request), request.body);
  });
  app.put("/api/blacklist/:id", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return updateBlocklistItem(idParam(request), request.body);
  });
  app.delete("/api/blocklist/:id", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return deleteBlocklistItem(idParam(request));
  });
  app.delete("/api/blacklist/:id", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return deleteBlocklistItem(idParam(request));
  });
  app.post("/api/blocklist/cleanup-expired", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return deleteExpiredBlocklistItems();
  });
  app.post("/api/blacklist/cleanup-expired", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return deleteExpiredBlocklistItems();
  });
  app.delete("/api/blocklist", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return clearBlocklistItems();
  });
  app.delete("/api/blacklist", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return clearBlocklistItems();
  });
}
