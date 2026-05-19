import type { FastifyInstance } from "fastify";
import { createUsenetServer, deleteUsenetServer, listUsenetServers, updateUsenetServer } from "../usenet/settings.js";

function idParam(request: { params: unknown }) {
  return (request.params as { id: string }).id;
}

function publicServer(server: Record<string, unknown>) {
  const { password, ...safeServer } = server;
  void password;
  return safeServer;
}

export async function usenetRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/usenet/servers", async () => (await listUsenetServers()).map(publicServer));
  app.post("/api/usenet/servers", async (request) => publicServer(await createUsenetServer(request.body)));
  app.put("/api/usenet/servers/:id", async (request) => publicServer(await updateUsenetServer(idParam(request), request.body)));
  app.delete("/api/usenet/servers/:id", async (request) => publicServer(await deleteUsenetServer(idParam(request))));
}
