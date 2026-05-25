import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createVfsFile,
  createVfsFolder,
  deleteVfsPath,
  listVfs,
  readVfsBytes,
  readVfsTextFile,
  refreshVfs,
  renameVfsPath,
  statVfs,
  streamVfsFile,
  treeVfs,
  updateVfsFile
} from "../vfs/vfsService.js";
import { listMounts } from "../vfs/mountedNzbService.js";
import { getStreamMetrics, listActiveStreamSessions, stopStreamSession } from "../streaming/mountedStream.service.js";
import { planMountedFileRange } from "../streaming/rangePlanner.service.js";
import { getBandwidthStatus } from "../bandwidth/bandwidthScheduler.js";
import { getFuseMountStatus } from "../vfs/fuseMountService.js";

export async function vfsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vfs/list", async (request) => {
    const query = request.query as { path?: string; showHidden?: string };
    return listVfs(query.path, query.showHidden === "true");
  });

  app.get("/api/vfs/tree", async (request) => {
    const query = request.query as { path?: string; depth?: string; showHidden?: string };
    return treeVfs(query.path, query.depth ? Number(query.depth) : 4, query.showHidden === "true");
  });

  app.get("/api/vfs/stat", async (request) => statVfs((request.query as { path?: string }).path));
  app.get("/api/vfs/text", async (request) => readVfsTextFile((request.query as { path?: string }).path ?? "/"));
  app.get("/api/vfs/mounts", async () => listMounts());
  app.get("/api/vfs/streams", async () => listActiveStreamSessions());
  app.get("/api/vfs/streams/metrics", async () => getStreamMetrics());
  app.post("/api/vfs/streams/:id/stop", async (request) => stopStreamSession((request.params as { id: string }).id));
  app.get("/api/vfs/range-plan", async (request) => {
    const query = request.query as { path?: string; range?: string };
    if (!query.path) throw new Error("path is required");
    return planMountedFileRange(query.path, query.range);
  });
  app.get("/api/vfs/bandwidth", async () => getBandwidthStatus());
  app.get("/api/vfs/fuse", async () => getFuseMountStatus());

  async function sendFile(request: FastifyRequest<{ Querystring: { path?: string } }>, reply: FastifyReply) {
    const query = request.query as { path?: string };
    if (!query.path) return reply.status(400).send({ error: "path is required" });
    const result = await streamVfsFile(query.path, request.headers.range);
    reply.header("accept-ranges", "bytes");
    reply.header("content-length", String(result.end - result.start + 1));
    if ("sessionId" in result) reply.header("x-stream-session-id", result.sessionId);
    if (result.partial) {
      reply.status(206);
      reply.header("content-range", `bytes ${result.start}-${result.end}/${result.size}`);
    }
    return reply.send(result.stream);
  }

  app.get("/api/vfs/file", sendFile);
  app.get("/api/vfs/stream", sendFile);
  app.get("/api/vfs/subtitle", async (request, reply) => {
    const query = request.query as { path?: string };
    if (!query.path) return reply.status(400).send({ error: "path is required" });
    const stats = await statVfs(query.path);
    if (stats.isDirectory) return reply.status(400).send({ error: "path must be a subtitle file" });
    if ((stats.size ?? 0) > 10 * 1024 * 1024) return reply.status(413).send({ error: "subtitle file is too large" });

    const raw = await readVfsBytes(query.path, 0, stats.size ?? 0, "subtitle");
    const text = raw.toString("utf8").replace(/^\uFEFF/, "");
    reply.header("content-type", "text/vtt; charset=utf-8");
    reply.header("cache-control", "private, max-age=300");
    return reply.send(toWebVtt(text));
  });
  app.post("/api/vfs/refresh", async () => refreshVfs());
  app.post("/api/vfs/folder", async (request) => {
    const body = request.body as { path?: string };
    if (!body.path) throw new Error("path is required");
    return createVfsFolder(body.path);
  });
  app.post("/api/vfs/file", async (request) => {
    const body = request.body as { path?: string; content?: string };
    if (!body.path) throw new Error("path is required");
    return createVfsFile(body.path, body.content ?? "");
  });
  app.put("/api/vfs/file", async (request) => {
    const body = request.body as { path?: string; content?: string };
    if (!body.path) throw new Error("path is required");
    return updateVfsFile(body.path, body.content ?? "");
  });
  app.post("/api/vfs/rename", async (request) => {
    const body = request.body as { path?: string; nextPath?: string };
    if (!body.path || !body.nextPath) throw new Error("path and nextPath are required");
    return renameVfsPath(body.path, body.nextPath);
  });
  app.delete("/api/vfs/path", async (request) => {
    const query = request.query as { path?: string };
    if (!query.path) throw new Error("path is required");
    return deleteVfsPath(query.path);
  });
}

function toWebVtt(text: string) {
  if (/^\s*WEBVTT/i.test(text)) return text;
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2 --> $3.$4");
  return `WEBVTT\n\n${normalized}`;
}
