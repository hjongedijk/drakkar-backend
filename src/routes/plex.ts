import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listPlexLibraries, pollPlexOauth, refreshPlexPath, startPlexOauth, testPlexConnection } from "../services/plexService.js";

export async function plexRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/plex/libraries", async () => ({ libraries: await listPlexLibraries() }));
  app.post("/api/plex/test", async () => testPlexConnection());
  app.post("/api/plex/refresh", async (request) => {
    const body = z.object({ path: z.string().min(1) }).parse(request.body);
    return refreshPlexPath(body.path);
  });
  app.post("/api/plex/oauth/start", async () => startPlexOauth());
  app.post("/api/plex/oauth/poll", async (request) => {
    const body = z.object({ pinId: z.number().int().positive() }).parse(request.body);
    return pollPlexOauth(body.pinId);
  });
}
