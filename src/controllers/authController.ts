import type { FastifyReply, FastifyRequest } from "fastify";
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
} from "../services/authService.js";
import { authCookieName, clearSessionCookie, createSession, destroySession, parseCookie, serializeSessionCookie } from "../services/auth/session.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { adminPasswordResetSchema, adminUserCreateSchema, adminUserUpdateSchema, apiKeySchema, loginSchema, passwordSchema, profileSchema } from "../models/schemas/authSchemas.js";

function idParam(request: FastifyRequest) {
  return (request.params as { id: string }).id;
}

export async function loginHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = loginSchema.parse(request.body ?? {});
  const user = await loginUser(body.username, body.password);
  if (!user) return reply.status(401).send({ message: "Invalid username or password." });
  const sessionToken = await createSession(user.id);
  reply.header("set-cookie", serializeSessionCookie(sessionToken));
  return { user };
}

export async function currentUserHandler(request: FastifyRequest) {
  return { user: request.authUser! };
}

export async function logoutHandler(request: FastifyRequest, reply: FastifyReply) {
  const sessionToken = parseCookie(request.headers.cookie, authCookieName);
  await destroySession(sessionToken);
  reply.header("set-cookie", clearSessionCookie());
  return { ok: true };
}

export async function updateProfileHandler(request: FastifyRequest) {
  const body = profileSchema.parse(request.body ?? {});
  const user = await updateCurrentUser(request.authUser!.id, body);
  return { user };
}

export async function changePasswordHandler(request: FastifyRequest) {
  const body = passwordSchema.parse(request.body ?? {});
  return changeCurrentUserPassword(request.authUser!.id, body.currentPassword, body.newPassword);
}

export async function listTokensHandler(request: FastifyRequest) {
  return { tokens: await listUserApiKeys(request.authUser!.id) };
}

export async function createTokenHandler(request: FastifyRequest) {
  const body = apiKeySchema.parse(request.body ?? {});
  return createUserApiKey(request.authUser!.id, body.name);
}

export async function revokeTokenHandler(request: FastifyRequest) {
  return revokeUserApiKey(request.authUser!.id, idParam(request));
}

export async function listAdminUsersHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return { users: await listUsers() };
}

export async function createAdminUserHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return { user: await createUser(adminUserCreateSchema.parse(request.body ?? {})) };
}

export async function updateAdminUserHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return { user: await updateUserByAdmin(idParam(request), adminUserUpdateSchema.parse(request.body ?? {})) };
}

export async function resetAdminPasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return resetUserPasswordByAdmin(idParam(request), adminPasswordResetSchema.parse(request.body ?? {}).newPassword);
}

export async function deleteAdminUserHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdmin(request, reply)) return;
  return deleteUserByAdmin(request.authUser!.id, idParam(request));
}
