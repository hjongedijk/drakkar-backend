import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../services/config/env.js";
import { listVfs, statVfs, streamVfsFile } from "../services/vfsService.js";
import { recordWebdavActivity } from "../services/webdavActivity.js";
import { stopStreamSession } from "../services/mountedStream.service.js";

type DavNode = {
  path: string;
  name?: string;
  type?: string;
  size?: number;
  modifiedAt?: string;
  isDirectory?: boolean;
};

type PropfindCacheEntry = {
  body: string;
  expiresAt: number;
};

const PROPFIND_CACHE_TTL_MS = 20_000;
const PROPFIND_MOUNTED_CACHE_TTL_MS = 120_000;
const propfindResponseCache = new Map<string, PropfindCacheEntry>();

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeDavPath(path: string) {
  const normalized = (path || "/").replace(/\/+/g, "/");
  if (normalized === "/") return "/dav/";
  const encoded = normalized
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const suffix = normalized.endsWith("/") ? "/" : "";
  return `/dav/${encoded}${suffix}`;
}

function requestDavPath(url = "/dav") {
  const parsed = new URL(url, env.APP_BASE_URL);
  const rawPath = parsed.pathname.startsWith("/dav") ? parsed.pathname.slice(4) : "/";
  const decoded = rawPath
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
  const normalized = decoded.replace(/\/+/g, "/");
  return normalized === "" ? "/" : normalized;
}

function unauthorized(reply: FastifyReply) {
  reply.header("www-authenticate", 'Basic realm="Drakkar WebDAV"');
  return reply.status(401).send("Authentication required");
}

function propfindCacheKey(path: string, depth: number) {
  return `${depth}:${path}`;
}

function propfindCacheTtl(path: string) {
  if (path === "/dav" || path === "/") return PROPFIND_CACHE_TTL_MS;
  if (path.startsWith("/mounted/releases/")) return PROPFIND_MOUNTED_CACHE_TTL_MS;
  if (path.startsWith("/mounted/")) return PROPFIND_MOUNTED_CACHE_TTL_MS;
  return PROPFIND_CACHE_TTL_MS;
}

function getCachedPropfindResponse(path: string, depth: number) {
  const entry = propfindResponseCache.get(propfindCacheKey(path, depth));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    propfindResponseCache.delete(propfindCacheKey(path, depth));
    return null;
  }
  return entry.body;
}

function setCachedPropfindResponse(path: string, depth: number, body: string) {
  propfindResponseCache.set(propfindCacheKey(path, depth), {
    body,
    expiresAt: Date.now() + propfindCacheTtl(path)
  });
}

function isAuthorized(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";
  return ["admin", "drakkar"].includes(username) && password === env.getDrakkarApiToken(env.CONFIG_DIR);
}

function formatLastModified(value?: string) {
  const date = value ? new Date(value) : new Date();
  return date.toUTCString();
}

function davNodeXml(node: DavNode) {
  const hrefPath = node.isDirectory && node.path !== "/" && !node.path.endsWith("/")
    ? `${node.path}/`
    : node.path;
  const isDirectory = Boolean(node.isDirectory);
  const contentLength = isDirectory ? "" : `<d:getcontentlength>${Math.max(0, Number(node.size ?? 0))}</d:getcontentlength>`;
  const contentType = isDirectory
    ? ""
    : "<d:getcontenttype>application/octet-stream</d:getcontenttype>";
  const resourceType = isDirectory ? "<d:collection/>" : "";
  return `<d:response><d:href>${xmlEscape(encodeDavPath(hrefPath))}</d:href><d:propstat><d:prop><d:displayname>${xmlEscape(node.name ?? (node.path === "/" ? "root" : node.path.split("/").filter(Boolean).at(-1) ?? ""))}</d:displayname><d:resourcetype>${resourceType}</d:resourcetype>${contentLength}${contentType}<d:getlastmodified>${xmlEscape(formatLastModified(node.modifiedAt))}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

async function davStatNode(path: string): Promise<DavNode> {
  const stat = await statVfs(path);
  return {
    path,
    name: path === "/" ? "root" : path.split("/").filter(Boolean).at(-1) ?? "",
    size: stat.size,
    modifiedAt: stat.modifiedAt,
    isDirectory: stat.isDirectory,
    type: stat.type
  };
}

async function propfindHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!isAuthorized(request)) return unauthorized(reply);
  const path = requestDavPath(request.url);
  recordWebdavActivity("PROPFIND", path);
  const depthHeader = Array.isArray(request.headers.depth) ? request.headers.depth[0] : request.headers.depth;
  const depth = depthHeader === "0" ? 0 : 1;
  const cached = getCachedPropfindResponse(path, depth);
  if (cached) {
    reply.code(207);
    reply.header("content-type", 'application/xml; charset="utf-8"');
    reply.header("dav", "1");
    return reply.send(cached);
  }
  const root = await davStatNode(path);
  const responses: string[] = [davNodeXml(root)];
  if (root.isDirectory && depth > 0) {
    const children = await listVfs(path, true);
    for (const child of children) {
      responses.push(davNodeXml({
        path: child.path,
        name: child.name,
        type: child.type,
        size: child.size,
        modifiedAt: child.modifiedAt,
        isDirectory: child.type === "folder" || child.type === "virtual-release"
      }));
    }
  }
  const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`;
  setCachedPropfindResponse(path, depth, body);
  reply.code(207);
  reply.header("content-type", 'application/xml; charset="utf-8"');
  reply.header("dav", "1");
  return reply.send(body);
}

async function getHeadHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!isAuthorized(request)) return unauthorized(reply);
  const path = requestDavPath(request.url);
  recordWebdavActivity(request.method, path);
  if (request.method === "HEAD") {
    const info = await statVfs(path);
    if (info.isDirectory) {
      reply.header("accept-ranges", "bytes");
      reply.header("content-length", "0");
      return reply.send();
    }
    reply.header("accept-ranges", "bytes");
    reply.header("content-length", String(Math.max(0, Number(info.size ?? 0))));
    if (request.headers.range) {
      const match = request.headers.range.match(/bytes=(\d*)-(\d*)/);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : Math.max(0, Number(info.size ?? 0) - 1);
      if (start <= end && start < Number(info.size ?? 0)) {
        reply.status(206);
        reply.header("content-range", `bytes ${start}-${Math.min(end, Number(info.size ?? 0) - 1)}/${Number(info.size ?? 0)}`);
        reply.header("content-length", String(Math.min(end, Number(info.size ?? 0) - 1) - start + 1));
      } else {
        reply.status(200);
        reply.header("content-length", "0");
        reply.header("content-range", `bytes */${Math.max(0, Number(info.size ?? 0))}`);
      }
    }
    return reply.send();
  }
  const controller = new AbortController();
  let stopped = false;
  const stopRequest = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
  };
  request.raw.once("aborted", stopRequest);
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) stopRequest();
  });

  let result;
  try {
    result = await streamVfsFile(path, request.headers.range, controller.signal);
  } catch (error) {
    if (error instanceof Error && error.message === "range start exceeds file size") {
      const info = await statVfs(path);
      reply.status(200);
      reply.header("accept-ranges", "bytes");
      reply.header("content-length", "0");
      reply.header("content-range", `bytes */${Math.max(0, Number(info.size ?? 0))}`);
      return reply.send();
    }
    throw error;
  }
  if ("sessionId" in result && result.sessionId) {
    const stopSession = () => {
      void stopStreamSession(result.sessionId).catch(() => undefined);
    };
    // Tie the session stop to the same lifecycle events already wired above
    request.raw.once("aborted", stopSession);
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) stopSession();
    });
  }
  reply.header("accept-ranges", "bytes");
  reply.header("content-length", String(result.end - result.start + 1));
  reply.header("content-type", "application/octet-stream");
  if (result.partial) {
    reply.status(206);
    reply.header("content-range", `bytes ${result.start}-${result.end}/${result.size}`);
  }
  return reply.send(result.stream);
}

async function optionsHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!isAuthorized(request)) return unauthorized(reply);
  reply.header("dav", "1");
  reply.header("allow", "OPTIONS, PROPFIND, GET, HEAD");
  reply.header("ms-author-via", "DAV");
  return reply.status(200).send();
}

export async function webdavRoutes(app: FastifyInstance): Promise<void> {
  app.route({ method: "OPTIONS", url: "/dav", handler: optionsHandler });
  app.route({ method: "OPTIONS", url: "/dav/*", handler: optionsHandler });
  app.route({ method: "PROPFIND", url: "/dav", handler: propfindHandler });
  app.route({ method: "PROPFIND", url: "/dav/*", handler: propfindHandler });
  app.route({ method: "HEAD", url: "/dav/*", handler: getHeadHandler });
  app.route({ method: "GET", url: "/dav/*", handler: getHeadHandler });
}
