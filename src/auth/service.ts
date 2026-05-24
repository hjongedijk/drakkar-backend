import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { hashPassword, verifyPassword } from "./password.js";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
};

function apiKeyHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function toAuthUser(user: { id: string; email: string; displayName: string | null; isAdmin: boolean }): AuthUser {
  return {
    id: user.id,
    username: user.email,
    displayName: user.displayName?.trim() || user.email,
    isAdmin: user.isAdmin
  };
}

export async function ensureDefaultAdminUser() {
  // Legacy hook kept for migrations/imports. Fresh installs create admin through setup wizard.
  return;
}

export async function countAdminUsers() {
  return prisma.user.count({ where: { isAdmin: true } });
}

export async function createInitialAdminUser(input: { username: string; displayName?: string; password: string }) {
  const username = input.username.trim();
  if (!username) throw new Error("username is required");
  if (input.password.length < 8) throw new Error("password must be at least 8 characters");
  const existingAdmins = await countAdminUsers();
  if (existingAdmins > 0) throw new Error("admin user already exists");

  const user = await prisma.user.create({
    data: {
      email: username,
      displayName: input.displayName?.trim() || username,
      isAdmin: true,
      passwordHash: hashPassword(input.password)
    },
    select: { id: true, email: true, displayName: true, isAdmin: true }
  });
  return toAuthUser(user);
}

export async function loginUser(username: string, password: string) {
  const normalized = username.trim();
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: normalized }, { displayName: normalized }]
    }
  });
  if (!user || !verifyPassword(password, user.passwordHash)) return undefined;
  return toAuthUser(user);
}

export async function getAuthUserById(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, isAdmin: true }
  });
  return user ? toAuthUser(user) : undefined;
}

export async function getFirstAdminAuthUser() {
  const user = await prisma.user.findFirst({
    where: { isAdmin: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, displayName: true, isAdmin: true }
  });
  return user ? toAuthUser(user) : undefined;
}

export async function getAuthUserByApiKey(token: string | undefined) {
  if (!token) return undefined;
  const keyHash = apiKeyHash(token);
  const apiKey = await prisma.apiKey.findFirst({
    where: { keyHash, revokedAt: null, userId: { not: null } },
    include: { user: { select: { id: true, email: true, displayName: true, isAdmin: true } } }
  });
  if (!apiKey?.user) return undefined;
  await prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() }
  }).catch(() => undefined);
  return toAuthUser(apiKey.user);
}

export async function updateCurrentUser(userId: string, input: { username: string; displayName?: string }) {
  const username = input.username.trim();
  if (!username) throw new Error("username is required");
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      email: username,
      displayName: input.displayName?.trim() || username
    },
    select: { id: true, email: true, displayName: true, isAdmin: true }
  });
  return toAuthUser(user);
}

export async function changeCurrentUserPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) throw new Error("current password is incorrect");
  if (newPassword.length < 8) throw new Error("new password must be at least 8 characters");
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: hashPassword(newPassword) }
  });
  return { ok: true };
}

export async function listUserApiKeys(userId: string) {
  return prisma.apiKey.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true }
  });
}

export async function createUserApiKey(userId: string, name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("token name is required");
  const rawToken = `uvfs_${randomBytes(24).toString("base64url")}`;
  const apiKey = await prisma.apiKey.create({
    data: {
      userId,
      name: trimmedName,
      keyHash: apiKeyHash(rawToken)
    },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true }
  });
  return { token: rawToken, apiKey };
}

export async function revokeUserApiKey(userId: string, apiKeyId: string) {
  await prisma.apiKey.updateMany({
    where: { id: apiKeyId, userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  return { ok: true };
}
