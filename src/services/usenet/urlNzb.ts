import { mkdir, writeFile } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../../repositories/db/prisma.js";
import { storeNzbForDownload } from "../downloadService.js";
import { parseNzbXml } from "../nzb/parser.js";
import { getSettings } from "../settings/settingsStore.js";
import { fetchNzbUrl } from "./nzbUrlFetch.js";
import { safeUpdateDownload } from "../downloads/downloadState.js";

function safeTestName(name: string) {
  const cleaned = name.replace(/[^a-z0-9._-]+/gi, "_").replace(/_+/g, "_").slice(0, 140) || "download";
  return cleaned.toLowerCase().endsWith(".nzb") ? cleaned : `${cleaned}.nzb`;
}

export async function testNzbUrl(url: string, title?: string) {
  const fetched = await fetchNzbUrl(url);
  const parsed = parseNzbXml(fetched.buffer.toString("utf8"), title ?? fetched.filename);
  const settings = await getSettings();
  await mkdir(env.VFS_NZB_DIR, { recursive: true });
  const filename = safeTestName(`test-${Date.now()}-${title ?? fetched.filename}`);
  const primaryPath = `${env.VFS_NZB_DIR}/${filename}`;
  const backupPath = `${env.NZB_BACKUPS_DIR}/${filename}`;
  await writeFile(primaryPath, fetched.buffer);
  if (settings.backupNzbFiles) {
    await mkdir(env.NZB_BACKUPS_DIR, { recursive: true });
    await writeFile(backupPath, fetched.buffer);
  }
  return {
    ok: parsed.valid,
    looksLikeNzb: fetched.looksLikeNzb,
    contentType: fetched.contentType,
    bytes: fetched.buffer.length,
    primaryPath,
    backupPath: settings.backupNzbFiles ? backupPath : "",
    title: parsed.title,
    fileCount: parsed.fileCount,
    segmentCount: parsed.segmentCount,
    totalSize: parsed.totalSize,
    errors: parsed.errors
  };
}

export async function fetchAndStoreNzbForDownload(input: { downloadId: string; logger: FastifyBaseLogger }) {
  const download = await prisma.download.findUniqueOrThrow({ where: { id: input.downloadId } });
  await safeUpdateDownload(input.downloadId, { status: "fetching_nzb", error: null });

  const fetched = await fetchNzbUrl(download.source);
  if (!fetched.looksLikeNzb) {
    input.logger.warn({ contentType: fetched.contentType, source: download.source }, "URL response does not look like an NZB; attempting parse anyway");
  }

  return storeNzbForDownload({
    downloadId: download.id,
    filename: fetched.filename,
    content: fetched.buffer,
    title: download.title
  });
}
