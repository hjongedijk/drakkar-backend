import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  changeCurrentUserPassword,
  createUser,
  createUserApiKey,
  deleteUserByAdmin,
  listUserApiKeys,
  listUsers,
  loginUser,
  resetUserPasswordByAdmin,
  revokeUserApiKey,
  updateUserByAdmin,
  updateCurrentUser
} from "../auth/service.js";
import { authCookieName, clearSessionCookie, createSession, destroySession, parseCookie, serializeSessionCookie } from "../auth/session.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const profileSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().optional()
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

const apiKeySchema = z.object({
  name: z.string().min(1)
});

const adminUserCreateSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().optional(),
  password: z.string().min(8),
  isAdmin: z.boolean().default(false),
  mustChangePassword: z.boolean().default(true)
});

const adminUserUpdateSchema = z.object({
  username: z.string().min(1).optional(),
  displayName: z.string().optional(),
  isAdmin: z.boolean().optional(),
  mustChangePassword: z.boolean().optional()
});

const adminPasswordResetSchema = z.object({
  newPassword: z.string().min(8)
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body ?? {});
    const user = await loginUser(body.username, body.password);
    if (!user) return reply.status(401).send({ message: "Invalid username or password." });
    const sessionToken = await createSession(user.id);
    reply.header("set-cookie", serializeSessionCookie(sessionToken));
    return { user };
  });

  app.get("/api/auth/me", async (request) => ({ user: request.authUser! }));

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionToken = parseCookie(request.headers.cookie, authCookieName);
    await destroySession(sessionToken);
    reply.header("set-cookie", clearSessionCookie());
    return { ok: true };
  });

  app.patch("/api/auth/profile", async (request) => {
    const body = profileSchema.parse(request.body ?? {});
    const user = await updateCurrentUser(request.authUser!.id, body);
    return { user };
  });

  app.patch("/api/auth/password", async (request) => {
    const body = passwordSchema.parse(request.body ?? {});
    return changeCurrentUserPassword(request.authUser!.id, body.currentPassword, body.newPassword);
  });

  app.get("/api/auth/tokens", async (request) => ({
    tokens: await listUserApiKeys(request.authUser!.id)
  }));

  app.post("/api/auth/tokens", async (request) => {
    const body = apiKeySchema.parse(request.body ?? {});
    return createUserApiKey(request.authUser!.id, body.name);
  });

  app.delete("/api/auth/tokens/:id", async (request) => {
    const params = request.params as { id: string };
    return revokeUserApiKey(request.authUser!.id, params.id);
  });

  app.get("/api/auth/admin/users", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return { users: await listUsers() };
  });

  app.post("/api/auth/admin/users", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    return { user: await createUser(adminUserCreateSchema.parse(request.body ?? {})) };
  });

  app.patch("/api/auth/admin/users/:id", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    const params = request.params as { id: string };
    return { user: await updateUserByAdmin(params.id, adminUserUpdateSchema.parse(request.body ?? {})) };
  });

  app.post("/api/auth/admin/users/:id/reset-password", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    const params = request.params as { id: string };
    return resetUserPasswordByAdmin(params.id, adminPasswordResetSchema.parse(request.body ?? {}).newPassword);
  });

  app.delete("/api/auth/admin/users/:id", async (request, reply) => {
    if (!request.authUser?.isAdmin) return reply.status(403).send({ message: "Admin access required." });
    const params = request.params as { id: string };
    return deleteUserByAdmin(request.authUser.id, params.id);
  });
}
