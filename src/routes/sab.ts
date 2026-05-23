import type { FastifyInstance } from "fastify";
import { DRAKKAR_VERSION } from "../version.js";
import { addNzbUpload, addUrl, getHistory, getQueue, setDownloadStatus } from "../downloads/downloadService.js";

export async function sabRoutes(app: FastifyInstance): Promise<void> {
  app.get("/sabnzbd/api", async (request) => {
    const query = request.query as { mode?: string; name?: string; value?: string };
    switch (query.mode) {
      case "version":
        return { version: DRAKKAR_VERSION };
      case "queue":
        return { queue: { slots: await getQueue() } };
      case "history":
        return { history: { slots: await getHistory() } };
      case "addurl":
        if (!query.name) return { status: false, error: "name is required" };
        return { status: true, nzo_ids: [(await addUrl(query.name)).id] };
      case "addfile":
        return { status: false, error: "use POST /sabnzbd/api with JSON { mode, name, content }" };
      case "pause":
        if (query.value) await setDownloadStatus(query.value, "paused");
        return { status: true };
      case "resume":
        if (query.value) await setDownloadStatus(query.value, "queued");
        return { status: true };
      case "delete":
        if (query.value) await setDownloadStatus(query.value, "cancelled");
        return { status: true };
      case "get_config":
        return { config: { misc: { complete_dir: "/data/completed", download_dir: "/data/downloads" } } };
      default:
        return { status: false, error: "unsupported mode" };
    }
  });

  app.post("/sabnzbd/api", async (request) => {
    const body = request.body as { mode?: string; name?: string; content?: string };
    if (body.mode !== "addfile") return { status: false, error: "unsupported mode" };
    if (!body.content) return { status: false, error: "content is required" };
    const download = await addNzbUpload({ filename: body.name, content: body.content, title: body.name, queueDownload: true });
    return { status: true, nzo_ids: [download.id] };
  });

  app.get("/api/sabnzbd", async (request, reply) => app.inject({ method: "GET", url: `/sabnzbd/api?${new URLSearchParams(request.query as Record<string, string>)}` }).then((response) => reply.status(response.statusCode).send(JSON.parse(response.body))));
}
