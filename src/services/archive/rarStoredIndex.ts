import { basename } from "node:path";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { prisma, type NzbFile, type NzbSegment, type UsenetServer } from "../../repositories/db/prisma.js";
import { filenameFromSubject } from "../usenet/filename.js";
import { NntpClient } from "../usenet/nntpClient.js";
import { decodeYencBufferLine } from "../usenet/yenc.js";
import { buildDecodedYencSegments } from "../yencManifest.service.js";

type NzbFileWithSegments = NzbFile & { segments: NzbSegment[] };

export type ArchiveVirtualSegment = {
  fileId: string;
  articleId: string;
  segmentNumber: number;
  bytes: number;
  start: number;
  end: number;
  sourceOffset: number;
};

export type ArchiveVirtualEntry = {
  documentId: string;
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  segments: ArchiveVirtualSegment[];
};

type RarStoredFileHeader = {
  name: string;
  dataStart: number;
  packedSize: number;
  unpackedSize: number;
  method: number;
  partNumber: number;
};

type SharpCompressHeader = {
  kind?: string;
  name?: string;
  dataStart?: number;
  packedSize?: number;
  unpackedSize?: number;
  compressionMethod?: number;
  isEncrypted?: boolean;
  isSolid?: boolean;
  volumeNumber?: number | null;
  isFirstVolume?: boolean;
};

const ARCHIVE_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const ARCHIVE_INDEX_FAILURE_TTL_MS = 15 * 60 * 1000;
const RAR_HEADER_READ_BYTES = 384 * 1024;
const RAR_HEADER_TIMEOUT_MS = 15_000;
const ARCHIVE_PROBE_PATH = process.env.ARCHIVE_PROBE_PATH ?? "/app/archive-probe/Drakkar.ArchiveProbe";

function oneLineLog(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
const archiveIndexCache = new Map<string, { value: ArchiveVirtualEntry[]; expiresAt: number }>();
const archiveIndexFailureCache = new Map<string, { error: Error; expiresAt: number }>();
const execFileAsync = promisify(execFile);
const ARCHIVE_SEGMENT_BATCH_SIZE = 1000;

function isRarName(name: string) {
  return /\.(?:part\d+\.rar|rar|r\d{2,3})$/i.test(name);
}

function isVideoName(name: string) {
  return /\.(mkv|mp4|avi|mov|m4v|ts)$/i.test(name);
}

function safeVirtualName(value: string, fallback: string) {
  const name = basename(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name || fallback;
}

function rarPartNumber(name: string) {
  const part = name.match(/\.part(\d+)\.rar$/i)?.[1];
  if (part) return Number(part);
  if (/\.rar$/i.test(name)) return 0;
  const r = name.match(/\.r(\d{2,3})$/i)?.[1];
  if (r) return Number(r) + 1;
  return 0;
}

function decodeRarName(raw: Buffer, unicode: boolean) {
  const nul = raw.indexOf(0);
  const plain = raw.subarray(0, nul >= 0 ? nul : raw.length).toString("utf8").trim();
  if (plain) return plain;
  return raw.toString(unicode ? "utf16le" : "latin1").replace(/\0/g, "").trim();
}

export function parseStoredRarHeaders(buffer: Buffer): RarStoredFileHeader[] {
  if (buffer.length < 7 || !buffer.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))) return [];
  const headers: RarStoredFileHeader[] = [];
  let offset = 7;

  while (offset + 7 <= buffer.length) {
    const blockStart = offset;
    const type = buffer.readUInt8(offset + 2);
    const flags = buffer.readUInt16LE(offset + 3);
    const headSize = buffer.readUInt16LE(offset + 5);
    if (headSize < 7 || blockStart + headSize > buffer.length) break;

    const hasData = (flags & 0x8000) !== 0;
    const addSize = hasData && blockStart + 11 <= buffer.length ? buffer.readUInt32LE(offset + 7) : 0;
    if (type === 0x74 && headSize >= 32) {
      const body = blockStart + 7;
      const lowPackSize = buffer.readUInt32LE(body);
      const lowUnpackedSize = buffer.readUInt32LE(body + 4);
      const method = buffer.readUInt8(body + 18);
      const nameSize = buffer.readUInt16LE(body + 19);
      const large = (flags & 0x0100) !== 0;
      const nameOffset = body + (large ? 33 : 25);
      const nameEnd = nameOffset + nameSize;
      if (nameEnd > blockStart + headSize) break;
      const highPackSize = large ? buffer.readUInt32LE(body + 25) : 0;
      const highUnpackedSize = large ? buffer.readUInt32LE(body + 29) : 0;
      const packedSize = highPackSize * 0x100000000 + lowPackSize;
      const unpackedSize = highUnpackedSize * 0x100000000 + lowUnpackedSize;
      const name = decodeRarName(buffer.subarray(nameOffset, nameEnd), (flags & 0x0200) !== 0);
      headers.push({
        name,
        dataStart: blockStart + headSize,
        packedSize,
        unpackedSize,
        method,
        partNumber: 0
      });
    }

    const next = blockStart + headSize + addSize;
    if (next <= offset) break;
    offset = next;
  }

  return headers;
}

async function archiveProbeAvailable() {
  try {
    await access(ARCHIVE_PROBE_PATH);
    return true;
  } catch {
    return false;
  }
}

async function parseStoredRarHeadersWithSharpCompress(buffer: Buffer): Promise<RarStoredFileHeader[]> {
  if (!(await archiveProbeAvailable())) return parseStoredRarHeaders(buffer);
  const dir = await mkdtemp(join(tmpdir(), "drakkar-rar-"));
  const file = join(dir, "header.rar");
  try {
    await writeFile(file, buffer);
    const { stdout } = await execFileAsync(ARCHIVE_PROBE_PATH, [file], {
      timeout: RAR_HEADER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(stdout) as { headers?: SharpCompressHeader[] };
    return (parsed.headers ?? [])
      .filter((header) => header.kind === "File" && header.name && typeof header.dataStart === "number")
      .map((header) => ({
        name: header.name!,
        dataStart: Math.floor(header.dataStart ?? 0),
        packedSize: Math.floor(header.packedSize ?? 0),
        unpackedSize: Math.floor(header.unpackedSize ?? 0),
        method: header.compressionMethod === 0 ? 0x30 : Math.floor(header.compressionMethod ?? -1),
        partNumber: 0
      }));
  } catch (error) {
    console.warn(oneLineLog(`[archive] SharpCompress probe failed; using fallback parser: ${error instanceof Error ? error.message : "unknown error"}`));
    return parseStoredRarHeaders(buffer);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function providers() {
  return prisma.usenetServer.findMany({
    where: { enabled: true },
    orderBy: [{ isBackup: "asc" }, { priority: "asc" }]
  });
}

async function readPersistedArchiveEntries(documentId: string): Promise<ArchiveVirtualEntry[]> {
  const entries = await prisma.archiveEntry.findMany({
    where: { nzbDocumentId: documentId, status: "streamable" },
    include: { segments: { orderBy: { start: "asc" } } },
    orderBy: { createdAt: "asc" }
  });

  return entries.map((entry) => ({
    documentId,
    name: entry.name,
    path: entry.path,
    size: Math.floor(entry.size),
    modifiedAt: entry.modifiedAt,
    segments: entry.segments.map((segment) => ({
      fileId: segment.nzbFileId,
      articleId: segment.articleId,
      segmentNumber: segment.segmentNumber,
      bytes: Math.floor(segment.bytes),
      start: Math.floor(segment.start),
      end: Math.floor(segment.end),
      sourceOffset: Math.floor(segment.sourceOffset)
    }))
  })).filter((entry) => entry.size > 0 && entry.segments.length > 0);
}

async function persistArchiveEntries(documentId: string, entries: ArchiveVirtualEntry[]) {
  await prisma.$transaction(async (tx) => {
    // Serialize archive-index refresh per NZB document so concurrent mounted
    // probes/reconciles cannot race on (nzbDocumentId, path).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${documentId}))`;

    await tx.archiveEntry.deleteMany({ where: { nzbDocumentId: documentId } });
    if (entries.length === 0) return;

    await tx.archiveEntry.createMany({
      data: entries.map((entry) => ({
        nzbDocumentId: documentId,
        name: entry.name,
        path: entry.path,
        format: "rar",
        compression: "store",
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        status: "streamable"
      })),
      skipDuplicates: true
    });

    const persistedEntries = await tx.archiveEntry.findMany({
      where: { nzbDocumentId: documentId },
      select: { id: true, path: true }
    });
    const byPath = new Map(persistedEntries.map((entry) => [entry.path, entry.id]));
    const allSegments = entries.flatMap((entry) => {
      const archiveEntryId = byPath.get(entry.path);
      if (!archiveEntryId) return [];
      return entry.segments.map((segment) => ({
        archiveEntryId,
        nzbFileId: segment.fileId,
        articleId: segment.articleId,
        segmentNumber: segment.segmentNumber,
        bytes: segment.bytes,
        start: segment.start,
        end: segment.end,
        sourceOffset: segment.sourceOffset
      }));
    });

    for (let index = 0; index < allSegments.length; index += ARCHIVE_SEGMENT_BATCH_SIZE) {
      await tx.archiveSegment.createMany({
        data: allSegments.slice(index, index + ARCHIVE_SEGMENT_BATCH_SIZE)
      });
    }
  }, {
    maxWait: 5_000,
    timeout: 20_000
  });
}

async function fetchArticleSlice(articleId: string, startOffset: number, length: number, servers: UsenetServer[], signal?: AbortSignal) {
  const errors: string[] = [];
  for (const server of servers) {
    const client = new NntpClient(server);
    try {
      await client.connect(signal);
      return await client.bodySlice(articleId, startOffset, length, decodeYencBufferLine, signal);
    } catch (error) {
      errors.push(`${server.name}: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      await client.quit().catch(() => undefined);
    }
  }
  throw new Error(`archive header read failed for ${articleId}: ${errors.join("; ")}`);
}

async function readDecodedRange(file: NzbFileWithSegments, start: number, length: number, servers: UsenetServer[], signal?: AbortSignal) {
  const decoded = await buildDecodedYencSegments(file, servers, signal, { mode: "fast" });
  const segments = decoded?.segments ?? file.segments.map((segment, index) => {
    const bytes = Math.floor(segment.bytes);
    const segmentStart = file.segments.slice(0, index).reduce((sum, item) => sum + Math.floor(item.bytes), 0);
    return { segment, bytes, start: segmentStart, end: segmentStart + bytes - 1 };
  });
  const chunks: Buffer[] = [];
  let total = 0;

  for (const item of segments) {
    if (item.end < start) continue;
    if (item.start >= start + length) break;
    const sliceStart = Math.max(start, item.start);
    const take = Math.min(start + length - sliceStart, item.end - sliceStart + 1);
    if (take <= 0) continue;
    const chunk = await fetchArticleSlice(item.segment.articleId, sliceStart - item.start, take, servers, signal);
    chunks.push(chunk);
    total += chunk.length;
    if (total >= length) break;
  }

  return Buffer.concat(chunks, total);
}

async function buildVirtualSegments(file: NzbFileWithSegments, dataStart: number, byteCount: number, entryStart: number, servers: UsenetServer[]) {
  const decoded = await buildDecodedYencSegments(file, servers, undefined, { mode: "fast" });
  const segments = decoded?.segments ?? file.segments.map((segment, index) => {
    const bytes = Math.floor(segment.bytes);
    const segmentStart = file.segments.slice(0, index).reduce((sum, item) => sum + Math.floor(item.bytes), 0);
    return { segment, bytes, start: segmentStart, end: segmentStart + bytes - 1 };
  });
  const out: ArchiveVirtualSegment[] = [];
  const sourceEnd = dataStart + byteCount - 1;
  for (const item of segments) {
    if (item.end < dataStart) continue;
    if (item.start > sourceEnd) break;
    const overlapStart = Math.max(item.start, dataStart);
    const overlapEnd = Math.min(item.end, sourceEnd);
    const relativeStart = entryStart + (overlapStart - dataStart);
    out.push({
      fileId: file.id,
      articleId: item.segment.articleId,
      segmentNumber: item.segment.number,
      bytes: item.bytes,
      start: relativeStart,
      end: relativeStart + (overlapEnd - overlapStart),
      sourceOffset: overlapStart - item.start
    });
  }
  return out;
}

export async function listStoredArchiveEntries(documentId: string): Promise<ArchiveVirtualEntry[]> {
  const cached = archiveIndexCache.get(documentId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const cachedFailure = archiveIndexFailureCache.get(documentId);
  if (cachedFailure && cachedFailure.expiresAt > Date.now()) throw cachedFailure.error;
  const persisted = await readPersistedArchiveEntries(documentId);
  if (persisted.length > 0) {
    archiveIndexCache.set(documentId, { value: persisted, expiresAt: Date.now() + ARCHIVE_INDEX_TTL_MS });
    archiveIndexFailureCache.delete(documentId);
    return persisted;
  }
  const servers = await providers();
  if (servers.length === 0) return [];
  const document = await prisma.nzbDocument.findUnique({
    where: { id: documentId },
    include: { files: { include: { segments: { orderBy: { number: "asc" } } } } }
  });
  if (!document) return [];

  const rarFiles = document.files
    .map((file, index) => ({ file, name: filenameFromSubject(file.subject, index) }))
    .filter((item) => isRarName(item.name))
    .sort((a, b) => rarPartNumber(a.name) - rarPartNumber(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const firstRar = rarFiles[0];
  if (!firstRar) {
    await persistArchiveEntries(documentId, []);
    archiveIndexCache.set(documentId, { value: [], expiresAt: Date.now() + ARCHIVE_INDEX_TTL_MS });
    return [];
  }

  try {
    const firstSignal = AbortSignal.timeout(RAR_HEADER_TIMEOUT_MS);
    const firstHead = await readDecodedRange(firstRar.file, 0, Math.min(RAR_HEADER_READ_BYTES, Math.floor(firstRar.file.size)), servers, firstSignal);
    const firstHeaders = await parseStoredRarHeadersWithSharpCompress(firstHead);
    const hasStoredVideo = firstHeaders.some((header) => header.method === 0x30 && isVideoName(header.name));
    if (!hasStoredVideo) {
      const methodSummary = [...new Set(firstHeaders.map((header) => `0x${header.method.toString(16)}`))];
      const videoHeaderCount = firstHeaders.filter((header) => isVideoName(header.name)).length;
      if (firstHeaders.length > 0) {
        console.info(
          oneLineLog(
            `[archive] ${document.title} has no direct-streamable stored video entries in scanned RAR headers; videoHeaders=${videoHeaderCount}; methods=${methodSummary.join(",") || "none"}`
          )
        );
      } else {
        console.info(oneLineLog(`[archive] ${document.title} has no readable RAR headers for direct-stream scan`));
      }
      await persistArchiveEntries(documentId, []);
      archiveIndexCache.set(documentId, { value: [], expiresAt: Date.now() + ARCHIVE_INDEX_TTL_MS });
      archiveIndexFailureCache.delete(documentId);
      return [];
    }

    const grouped = new Map<string, { name: string; expectedSize: number; modifiedAt: Date; parts: Array<{ partNumber: number; packedSize: number; segments: ArchiveVirtualSegment[] }> }>();
    for (const { file, name: rarName } of rarFiles) {
      const signal = AbortSignal.timeout(RAR_HEADER_TIMEOUT_MS);
      const head = file.id === firstRar.file.id
        ? firstHead
        : await readDecodedRange(file, 0, Math.min(RAR_HEADER_READ_BYTES, Math.floor(file.size)), servers, signal);
      const filePartNumber = rarPartNumber(rarName);
      const headers = (await parseStoredRarHeadersWithSharpCompress(head))
        .filter((header) => header.method === 0x30 && isVideoName(header.name))
        .map((header) => ({ ...header, partNumber: filePartNumber }));
      for (const header of headers) {
        const virtualName = safeVirtualName(header.name, `${document.title}.mkv`);
        const current = grouped.get(virtualName) ?? { name: virtualName, expectedSize: header.unpackedSize || 0, modifiedAt: file.date ?? document.createdAt, parts: [] };
        const entryStart = current.parts.reduce((sum, part) => sum + part.packedSize, 0);
        const segments = await buildVirtualSegments(file, header.dataStart, header.packedSize, entryStart, servers);
        current.expectedSize = Math.max(current.expectedSize, header.unpackedSize || 0);
        current.parts.push({ partNumber: header.partNumber, packedSize: header.packedSize, segments });
        current.modifiedAt = file.date ?? current.modifiedAt;
        grouped.set(virtualName, current);
      }
      if (grouped.size > 0 && !/\.part\d+\.rar$/i.test(rarName) && !/\.r\d{2,3}$/i.test(rarName)) break;
    }

    const used = new Map<string, number>();
    const entries = [...grouped.values()].map((entry) => {
      const count = used.get(entry.name) ?? 0;
      used.set(entry.name, count + 1);
      const name = count === 0 ? entry.name : entry.name.replace(/(\.[^.]+)?$/, `-${count + 1}$1`);
      const partNumbers = entry.parts.map((part) => part.partNumber);
      if (partNumbers.length !== new Set(partNumbers).size) throw new Error("Rar archive has duplicate volume numbers.");
      const parts = entry.parts.sort((a, b) => a.partNumber - b.partNumber);
      const totalPackedSize = parts.reduce((sum, part) => sum + part.packedSize, 0);
      if (entry.expectedSize > 0 && Math.abs(totalPackedSize - entry.expectedSize) > 16) {
        throw new Error("Missing rar volumes detected.");
      }
      let cursor = 0;
      const segments = parts.flatMap((part) => {
        const shifted = part.segments.map((segment) => ({
          ...segment,
          start: cursor + (segment.start - part.segments[0]!.start),
          end: cursor + (segment.end - part.segments[0]!.start)
        }));
        cursor += part.packedSize;
        return shifted;
      });
      return {
        documentId,
        name,
        path: `/mounted/releases/${documentId}/archive/${encodeURIComponent(name)}`,
        size: entry.expectedSize || totalPackedSize,
        modifiedAt: entry.modifiedAt,
        segments: segments.sort((a, b) => a.start - b.start)
      };
    }).filter((entry) => entry.size > 0 && entry.segments.length > 0);

    await persistArchiveEntries(documentId, entries);
    archiveIndexCache.set(documentId, { value: entries, expiresAt: Date.now() + ARCHIVE_INDEX_TTL_MS });
    archiveIndexFailureCache.delete(documentId);
    return entries;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    archiveIndexFailureCache.set(documentId, {
      error: failure,
      expiresAt: Date.now() + ARCHIVE_INDEX_FAILURE_TTL_MS
    });
    throw failure;
  }
}

export async function getStoredArchiveEntryByPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  const releases = parts[1] === "releases";
  const documentId = releases ? parts[2] : parts[1];
  const archiveIndex = releases ? 3 : 2;
  if (!documentId) return null;
  const archivePath = parts[archiveIndex] === "archive";
  const name = decodeURIComponent(parts[archivePath ? archiveIndex + 1 : archiveIndex] ?? "");
  if (!name) return null;
  const entries = await listStoredArchiveEntries(documentId);
  return entries.find((entry) => entry.name === name) ?? null;
}
