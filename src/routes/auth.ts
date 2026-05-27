import type { FastifyInstance } from "fastify";
import {
  changePasswordHandler,
  createAdminUserHandler,
  createTokenHandler,
  currentUserHandler,
  deleteAdminUserHandler,
  listAdminUsersHandler,
  listTokensHandler,
  loginHandler,
  logoutHandler,
  resetAdminPasswordHandler,
  revokeTokenHandler,
  updateAdminUserHandler,
  updateProfileHandler
} from "../controllers/authController.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", loginHandler);
  app.get("/api/auth/me", currentUserHandler);
  app.post("/api/auth/logout", logoutHandler);
  app.patch("/api/auth/profile", updateProfileHandler);
  app.patch("/api/auth/password", changePasswordHandler);
  app.get("/api/auth/tokens", listTokensHandler);
  app.post("/api/auth/tokens", createTokenHandler);
  app.delete("/api/auth/tokens/:id", revokeTokenHandler);
  app.get("/api/auth/admin/users", listAdminUsersHandler);
  app.post("/api/auth/admin/users", createAdminUserHandler);
  app.patch("/api/auth/admin/users/:id", updateAdminUserHandler);
  app.post("/api/auth/admin/users/:id/reset-password", resetAdminPasswordHandler);
  app.delete("/api/auth/admin/users/:id", deleteAdminUserHandler);
}
