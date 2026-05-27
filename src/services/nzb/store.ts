import { prisma } from "../../repositories/db/prisma.js";
import type { ParsedNzb } from "./parser.js";

function safeMountName(value: string) {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 180) || "Mounted NZB";
}

export async function storeNzbDocument(input: {
  parsed: ParsedNzb;
  path: string;
  backupPath?: string;
  guid?: string;
}) {
  const document = await prisma.nzbDocument.create({
    data: {
      title: input.parsed.title,
      guid: input.guid,
      path: input.path,
      backupPath: input.backupPath,
      poster: input.parsed.poster,
      groups: input.parsed.groups,
      totalSize: input.parsed.totalSize,
      fileCount: input.parsed.fileCount,
      segmentCount: input.parsed.segmentCount,
      valid: input.parsed.valid,
      errors: input.parsed.errors,
      files: {
        create: input.parsed.files.map((file) => ({
          subject: file.subject,
          poster: file.poster,
          date: file.date,
          groups: file.groups,
          size: file.size,
          segments: {
            create: file.segments.map((segment) => ({
              number: segment.number,
              bytes: segment.bytes,
              articleId: segment.articleId
            }))
          }
        }))
      }
    },
    include: { files: { include: { segments: true } } }
  });
  const name = safeMountName(document.title);
  await prisma.vfsMount.create({
    data: {
      nzbDocumentId: document.id,
      name,
      path: `/mounted/${document.id}`,
      status: "pending",
      streamable: false
    }
  });
  return document;
}
