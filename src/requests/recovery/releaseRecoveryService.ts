import { prisma } from "../../db/prisma.js";
import { createBlocklistItem, isReleaseBlocklisted } from "../../policies/policyService.js";
import { toPublicRelease } from "../../releases/public.js";
import { grabBestForRequest, grabMissingTvForRequest } from "../sync/service.js";

const inFlightRecoveryByRequest = new Map<string, Promise<unknown>>();

type BlockReason =
  | "no_video_content"
  | "missing_articles"
  | "passworded_archive"
  | "unsupported_archive"
  | "grab_failed"
  | "import_failed";

function releaseFromJson(value: unknown): { guid?: string; title: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : undefined;
  if (!title) return null;
  const guid = record.guid === undefined || record.guid === null ? undefined : String(record.guid);
  return {
    title,
    guid
  };
}

function classifyFailure(message: string): BlockReason {
  if (/no streamable video|no video|sample|ignored/i.test(message)) return "no_video_content";
  if (/missing|all providers failed|stat|article|segment/i.test(message)) return "missing_articles";
  if (/archive|rar|7z|password/i.test(message)) return /password/i.test(message) ? "passworded_archive" : "unsupported_archive";
  return "grab_failed";
}

function titleNeedle(title: string) {
  return (title.split(":")[0] ?? title).trim();
}

async function resolveRequestForFailedDownload(input: { downloadId: string; requestId?: string; title?: string }) {
  if (input.requestId) {
    const direct = await prisma.mediaRequest.findUnique({ where: { id: input.requestId } });
    if (direct) return direct;
  }

  const linked = await prisma.mediaRequest.findFirst({ where: { downloadId: input.downloadId } });
  if (linked) return linked;

  if (!input.title) return null;
  const needle = titleNeedle(input.title);
  const candidates = await prisma.mediaRequest.findMany({
    where: {
      mediaType: "tv",
      status: { in: ["approved", "grabbed", "available", "release_failed", "no_release_found", "auto_grab_failed", "import_failed"] }
    },
    orderBy: { updatedAt: "desc" },
    take: 25
  });
  return candidates.find((candidate) => needle.toLowerCase().includes(titleNeedle(candidate.title).toLowerCase())) ?? null;
}

export async function recoverFailedDownloadForRequest(input: { downloadId: string; requestId?: string; title?: string; error: string; source?: string; blocklist?: boolean }) {
  const request = await resolveRequestForFailedDownload(input);
  if (!request) return { recovered: false, reason: "download is not attached to a request" };
  const existingRecovery = inFlightRecoveryByRequest.get(request.id);
  if (existingRecovery) return { recovered: false, requestId: request.id, reason: "replacement search already running" };

  const download = await prisma.download.findUnique({
    where: { id: input.downloadId },
    include: { nzbDocument: true }
  });
  const release = releaseFromJson(request.selectedRelease);
  const fallbackTitle = download?.title ?? request.title;
  const fallbackGuid = download?.nzbDocument?.guid ?? undefined;
  const blocklistedRelease = release ?? { title: fallbackTitle, guid: fallbackGuid };
  const reason = classifyFailure(input.error);

  if (input.blocklist !== false && !(await isReleaseBlocklisted(blocklistedRelease))) {
    await createBlocklistItem({
      guid: blocklistedRelease.guid ? String(blocklistedRelease.guid) : undefined,
      title: blocklistedRelease.title,
      reason,
      source: input.source ?? "auto-validation",
      release: request.selectedRelease ?? undefined
    });
  }

  await prisma.mediaRequest.update({
    where: { id: request.id },
    data: {
      status: "release_failed",
      downloadId: null
    }
  });

  const recovery = (async () => {
    try {
      const next = request.mediaType === "tv"
        ? await grabMissingTvForRequest(request.id)
        : await grabBestForRequest(request.id);
      const safeNext = "release" in next && next.release ? { ...next, release: toPublicRelease(next.release) } : next;
      return {
        recovered: next.grabbed,
        requestId: request.id,
        blocklisted: blocklistedRelease.title,
        next: safeNext
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "could not queue replacement release";
      await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "no_release_found" } });
      return { recovered: false, requestId: request.id, blocklisted: blocklistedRelease.title, reason: message };
    } finally {
      inFlightRecoveryByRequest.delete(request.id);
    }
  })();
  inFlightRecoveryByRequest.set(request.id, recovery);
  return recovery;
}
