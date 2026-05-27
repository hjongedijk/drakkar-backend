import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { redis } from "../../repositories/db/redis.js";

export const authCookieName = "usenet_vfs_session";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sessionKey(token: string) {
  return `auth:session:${hashToken(token)}`;
}

function sessionMaxAgeSeconds() {
  return env.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60;
}

function secureCookieSuffix() {
  return env.APP_BASE_URL.startsWith("https://") ? "; Secure" : "";
}

export function parseCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const key = sessionKey(token);
  await redis.hset(key, {
    userId,
    createdAt: new Date().toISOString()
  });
  await redis.expire(key, sessionMaxAgeSeconds());
  return token;
}

export async function getSessionUserId(token: string | undefined) {
  if (!token) return undefined;
  const payload = await redis.hgetall(sessionKey(token));
  return payload.userId || undefined;
}

export async function destroySession(token: string | undefined) {
  if (!token) return;
  await redis.del(sessionKey(token));
}

export function serializeSessionCookie(token: string) {
  return `${authCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds()}${secureCookieSuffix()}`;
}

export function clearSessionCookie() {
  return `${authCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix()}`;
}
