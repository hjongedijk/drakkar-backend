import yencode from "yencode";

export type YencInfo = {
  name?: string;
  size?: number;
  part?: number;
  total?: number;
};

function parseAttributes(line: string) {
  const attrs: Record<string, string> = {};
  for (const match of line.matchAll(/([a-zA-Z]+)=("[^"]+"|\S+)/g)) {
    attrs[match[1]!] = match[2]!.replace(/^"|"$/g, "");
  }
  return attrs;
}

export function parseYencInfo(body: string): YencInfo {
  const begin = body.split(/\r?\n/).find((line) => line.startsWith("=ybegin"));
  if (!begin) return {};
  const attrs = parseAttributes(begin);
  return {
    name: attrs.name,
    size: attrs.size ? Number(attrs.size) : undefined,
    part: attrs.part ? Number(attrs.part) : undefined,
    total: attrs.total ? Number(attrs.total) : undefined
  };
}

function nativeDecode(input: Buffer) {
  return yencode.decode(input, false);
}

function extractPayloadBuffers(body: string) {
  const lines = body.split(/\r?\n/);
  const payload: Buffer[] = [];
  let inYenc = false;
  for (const line of lines) {
    if (line.startsWith("=ybegin")) {
      inYenc = true;
      continue;
    }
    if (!inYenc) continue;
    if (line.startsWith("=ypart") || line.startsWith("=yend")) continue;
    payload.push(Buffer.from(line, "latin1"));
  }
  return payload;
}

export function decodeYenc(body: string): Buffer {
  const payload = extractPayloadBuffers(body);
  return nativeDecode(payload.length === 1 ? payload[0]! : Buffer.concat(payload));
}

export function decodeYencLine(line: string): Buffer {
  return nativeDecode(Buffer.from(line, "latin1"));
}

export function decodeYencBufferLine(line: Buffer): Buffer {
  return nativeDecode(line);
}

export function decodeArticleBody(body: string): Buffer {
  return body.includes("=ybegin") ? decodeYenc(body) : Buffer.from(body, "binary");
}
