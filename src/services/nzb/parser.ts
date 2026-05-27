import { XMLParser } from "fast-xml-parser";

export type ParsedNzbSegment = {
  number: number;
  bytes: number;
  articleId: string;
};

export type ParsedNzbFile = {
  subject: string;
  poster?: string;
  date?: Date;
  groups: string[];
  size: number;
  segments: ParsedNzbSegment[];
};

export type ParsedNzb = {
  title: string;
  poster?: string;
  groups: string[];
  totalSize: number;
  fileCount: number;
  segmentCount: number;
  valid: boolean;
  errors: string[];
  files: ParsedNzbFile[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  processEntities: false,
  htmlEntities: false,
  isArray: (name) => ["file", "group", "segment"].includes(name)
});

type RawNzb = {
  nzb?: {
    file?: Array<{
      poster?: string;
      date?: string;
      subject?: string;
      groups?: { group?: string[] };
      segments?: {
        segment?: Array<{
          number?: string;
          bytes?: string;
          text?: string;
        }>;
      };
    }>;
  };
};

export function parseNzbXml(xml: string, fallbackTitle = "Untitled NZB"): ParsedNzb {
  const errors: string[] = [];
  const sanitizedXml = xml
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "");
  const parsed = parser.parse(sanitizedXml) as RawNzb;
  const rawFiles = parsed.nzb?.file ?? [];

  if (!parsed.nzb) errors.push("missing NZB root element");
  if (rawFiles.length === 0) errors.push("NZB contains no files");

  const files = rawFiles.map((file, index): ParsedNzbFile => {
    const segments = file.segments?.segment ?? [];
    if (!file.subject) errors.push(`file ${index + 1} is missing a subject`);
    if (segments.length === 0) errors.push(`file ${index + 1} has no segments`);

    const normalizedSegments = segments.map((segment, segmentIndex): ParsedNzbSegment => {
      const number = Number(segment.number ?? segmentIndex + 1);
      const bytes = Number(segment.bytes ?? 0);
      const articleId = String(segment.text ?? "").trim();
      if (!articleId) errors.push(`file ${index + 1} segment ${segmentIndex + 1} is missing an article id`);
      if (!Number.isFinite(bytes) || bytes <= 0) errors.push(`file ${index + 1} segment ${segmentIndex + 1} has invalid bytes`);
      return { number, bytes: Number.isFinite(bytes) ? bytes : 0, articleId };
    });

    return {
      subject: file.subject ?? `file-${index + 1}`,
      poster: file.poster,
      date: file.date ? new Date(Number(file.date) * 1000) : undefined,
      groups: file.groups?.group ?? [],
      size: normalizedSegments.reduce((sum, segment) => sum + segment.bytes, 0),
      segments: normalizedSegments
    };
  });

  const groupSet = new Set(files.flatMap((file) => file.groups));
  return {
    title: files[0]?.subject ?? fallbackTitle,
    poster: files[0]?.poster,
    groups: [...groupSet],
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    fileCount: files.length,
    segmentCount: files.reduce((sum, file) => sum + file.segments.length, 0),
    valid: errors.length === 0,
    errors,
    files
  };
}
