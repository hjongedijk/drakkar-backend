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

export function decodeYenc(body: string): Buffer {
  const ybeginIndex = body.search(/^=ybegin/m);
  const payload = ybeginIndex >= 0 ? body.slice(ybeginIndex) : body;
  const out = Buffer.allocUnsafe(payload.length);
  let outIndex = 0;
  let index = 0;
  let lineStart = 0;
  let skipLine = false;

  while (index <= payload.length) {
    const code = index < payload.length ? payload.charCodeAt(index) : 10;
    const isLineEnd = index >= payload.length || code === 10 || code === 13;

    if (index === lineStart) {
      skipLine =
        payload.startsWith("=ybegin", index) ||
        payload.startsWith("=ypart", index) ||
        payload.startsWith("=yend", index);
    }

    if (isLineEnd) {
      index += code === 13 && payload.charCodeAt(index + 1) === 10 ? 2 : 1;
      lineStart = index;
      skipLine = false;
      continue;
    }

    if (!skipLine) {
      let value = code & 0xff;
      if (value === 61) {
        index += 1;
        value = ((payload.charCodeAt(index) & 0xff) - 64 + 256) % 256;
      }
      out[outIndex] = (value - 42 + 256) % 256;
      outIndex += 1;
    }

    index += 1;
  }

  return out.subarray(0, outIndex);
}

export function decodeArticleBody(body: string): Buffer {
  return body.includes("=ybegin") ? decodeYenc(body) : Buffer.from(body, "binary");
}
