import type { FastifyInstance } from "fastify";
import { getAuthUserByApiKey, getAuthUserById } from "../services/authService.js";
import { authCookieName, getSessionUserId, parseCookie } from "../services/auth/session.js";
import { env } from "../services/config/env.js";
import { getSetupStatus } from "../services/setupService.js";

const API_TOKEN_AUTH_USER = {
  id: "drakkar-api-token",
  username: "drakkar",
  displayName: "Drakkar API",
  isAdmin: true,
  mustChangePassword: false
} as const;

const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/setup/status"
]);

const SETUP_BYPASS_PATHS = new Set([
  "/api/auth/login",
  "/api/webhooks/seerr"
]);

function isApiRequest(url: string) {
  return url.startsWith("/api/");
}

function parseApiUrl(url: string) {
  return new URL(url, env.APP_BASE_URL);
}

function getHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function registerAuthenticationHooks(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS" || !isApiRequest(request.url)) return;

    const parsedUrl = parseApiUrl(request.url);
    if (PUBLIC_API_PATHS.has(parsedUrl.pathname)) return;
    const drakkarApiToken = env.getDrakkarApiToken(env.CONFIG_DIR);
    const authorization = request.headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
    const headerToken = getHeaderValue(request.headers["x-api-token"]);
    const apiToken = headerToken ?? parsedUrl.searchParams.get("apiToken") ?? (bearerToken === drakkarApiToken ? bearerToken : "");
    if (!apiToken || apiToken !== drakkarApiToken) return;
    request.authUser = { ...API_TOKEN_AUTH_USER };
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || !isApiRequest(request.url)) return;

    const parsedUrl = parseApiUrl(request.url);
    if (PUBLIC_API_PATHS.has(parsedUrl.pathname)) return;

    const setup = await getSetupStatus();
    if (parsedUrl.pathname === "/api/setup/complete") {
      if (!setup.completed) return;
    } else if (!setup.completed) {
      return reply.status(428).send({ message: "Setup must be completed before using Drakkar." });
    }

    if (SETUP_BYPASS_PATHS.has(parsedUrl.pathname) || request.authUser) return;

    const authorization = request.headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
    const sessionToken = parseCookie(request.headers.cookie, authCookieName);
    const sessionUserId = await getSessionUserId(sessionToken);
    const user = sessionUserId
      ? await getAuthUserById(sessionUserId)
      : await getAuthUserByApiKey(bearerToken);

    if (!user) {
      return reply.status(401).send({ message: "Authentication required." });
    }
    request.authUser = user;
  });
}
