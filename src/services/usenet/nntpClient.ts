import net from "node:net";
import tls from "node:tls";
import type { UsenetServer } from "../../repositories/db/prisma.js";

type Socket = net.Socket | tls.TLSSocket;
const CRLF = Buffer.from("\r\n", "ascii");

function startsWithAscii(buffer: Buffer, value: string) {
  return buffer.subarray(0, value.length).equals(Buffer.from(value, "ascii"));
}

export class NntpClient {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private socketError: Error | null = null;

  constructor(private readonly server: UsenetServer) {}

  async connect(signal?: AbortSignal) {
    this.socketError = null;
    this.socket = this.server.ssl
      ? tls.connect({ host: this.server.host, port: this.server.port, servername: this.server.host })
      : net.connect({ host: this.server.host, port: this.server.port });
    this.socket.setKeepAlive(true, 30_000);
    this.socket.setNoDelay(true);
    this.socket.setTimeout(120000);
    this.socket.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    });
    this.socket.on("error", (error) => {
      this.socketError = error;
    });
    this.socket.on("close", () => {
      this.socketError ??= new Error("NNTP socket closed");
    });
    this.socket.on("timeout", () => this.socket?.destroy(new Error("NNTP socket timeout")));
    await this.waitForSocket("connect", signal);
    const greeting = await this.readLine(signal);
    if (!greeting.startsWith("200") && !greeting.startsWith("201")) throw new Error(`NNTP rejected connection: ${greeting}`);
    if (this.server.username && this.server.password) {
      await this.command(`AUTHINFO USER ${this.server.username}`, ["381", "281"], signal);
      await this.command(`AUTHINFO PASS ${this.server.password}`, ["281"], signal);
    }
  }

  async article(articleId: string, signal?: AbortSignal) {
    const normalized = articleId.startsWith("<") ? articleId : `<${articleId}>`;
    await this.write(`ARTICLE ${normalized}\r\n`, signal);
    const status = await this.readLine(signal);
    if (!status.startsWith("220")) throw new Error(`ARTICLE failed: ${status}`);
    return this.readMultiline(signal);
  }

  async body(articleId: string, signal?: AbortSignal) {
    const normalized = articleId.startsWith("<") ? articleId : `<${articleId}>`;
    await this.write(`BODY ${normalized}\r\n`, signal);
    const status = await this.readLine(signal);
    if (!status.startsWith("222")) throw new Error(`BODY failed: ${status}`);
    return this.readMultiline(signal);
  }

  async yencPartHeader(articleId: string, signal?: AbortSignal) {
    const normalized = articleId.startsWith("<") ? articleId : `<${articleId}>`;
    let ybegin: string | undefined;
    let ypart: string | undefined;
    let yend: string | undefined;

    await this.write(`BODY ${normalized}\r\n`, signal);
    const status = await this.readLine(signal);
    if (!status.startsWith("222")) throw new Error(`BODY failed: ${status}`);

    while (true) {
      const line = await this.readLineBuffer(signal);
      if (line.length === 1 && line[0] === 46) break;
      const text = line.toString("latin1");
      if (text.startsWith("=ybegin")) ybegin = text;
      else if (text.startsWith("=ypart")) {
        ypart = text;
        break;
      } else if (text.startsWith("=yend")) {
        yend = text;
        break;
      }
    }

    this.socket?.destroy();
    this.socket = undefined;
    return { ybegin, ypart, yend };
  }

  async *decodedBodyChunks(articleId: string, decodeLine: (line: string) => Buffer, signal?: AbortSignal): AsyncGenerator<Buffer> {
    yield* this.decodedBodyBufferChunks(articleId, (line) => decodeLine(line.toString("latin1")), signal);
  }

  async *decodedBodyBufferChunks(articleId: string, decodeLine: (line: Buffer) => Buffer, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const normalized = articleId.startsWith("<") ? articleId : `<${articleId}>`;
    let yenc = false;

    await this.write(`BODY ${normalized}\r\n`, signal);
    const status = await this.readLine(signal);
    if (!status.startsWith("222")) throw new Error(`BODY failed: ${status}`);

    while (true) {
      const line = await this.readLineBuffer(signal);
      if (line.length === 1 && line[0] === 46) break;
      if (startsWithAscii(line, "=ybegin")) {
        yenc = true;
        continue;
      }
      if (yenc && (startsWithAscii(line, "=ypart") || startsWithAscii(line, "=yend"))) continue;
      const normalizedLine = line.length > 1 && line[0] === 46 && line[1] === 46 ? line.subarray(1) : line;
      yield yenc ? decodeLine(normalizedLine) : normalizedLine;
    }
  }

  async bodySlice(articleId: string, startOffset: number, length: number, decodeLine: (line: Buffer) => Buffer, signal?: AbortSignal) {
    const normalized = articleId.startsWith("<") ? articleId : `<${articleId}>`;
    const targetEnd = startOffset + length;
    const chunks: Buffer[] = [];
    let total = 0;
    let decodedOffset = 0;
    let yenc = false;

    await this.write(`BODY ${normalized}\r\n`, signal);
    const status = await this.readLine(signal);
    if (!status.startsWith("222")) throw new Error(`BODY failed: ${status}`);

    while (true) {
      const line = await this.readLineBuffer(signal);
      if (line.length === 1 && line[0] === 46) break;
      if (startsWithAscii(line, "=ybegin")) {
        yenc = true;
        continue;
      }
      if (yenc && (startsWithAscii(line, "=ypart") || startsWithAscii(line, "=yend"))) continue;

      const normalizedLine = line.length > 1 && line[0] === 46 && line[1] === 46 ? line.subarray(1) : line;
      const decoded = yenc ? decodeLine(normalizedLine) : normalizedLine;
      const lineStart = decodedOffset;
      const lineEnd = decodedOffset + decoded.length;
      decodedOffset = lineEnd;

      if (lineEnd <= startOffset) continue;
      const sliceStart = Math.max(0, startOffset - lineStart);
      const sliceEnd = Math.min(decoded.length, targetEnd - lineStart);
      if (sliceEnd > sliceStart) {
        const chunk = decoded.subarray(sliceStart, sliceEnd);
        chunks.push(chunk);
        total += chunk.length;
      }

      if (decodedOffset >= targetEnd) {
        this.socket?.destroy();
        this.socket = undefined;
        return Buffer.concat(chunks, total);
      }
    }

    return Buffer.concat(chunks, total);
  }

  async stat(articleId: string, signal?: AbortSignal) {
    const normalized = articleId.startsWith("<") ? articleId : `<${articleId}>`;
    const status = await this.command(`STAT ${normalized}`, ["223"], signal);
    return status;
  }

  async quit() {
    if (!this.socket) return;
    try {
      await this.write("QUIT\r\n");
    } finally {
      this.socket.end();
      this.socket.destroy();
    }
  }

  private abortError() {
    const error = new Error("NNTP operation aborted");
    error.name = "AbortError";
    return error;
  }

  private async waitForSocket(event: "connect" | "data", signal?: AbortSignal) {
    if (!this.socket) throw new Error("NNTP socket is not connected");
    if (signal?.aborted) throw this.abortError();
    if (this.socketError) throw this.socketError;
    const socket = this.socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy(this.abortError());
        reject(this.abortError());
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(this.socketError ?? new Error("NNTP socket closed"));
      };
      const cleanup = () => {
        socket.off(event, onReady);
        socket.off("close", onClose);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      socket.on(event, onReady);
      socket.on("close", onClose);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async command(command: string, accepted: string[], signal?: AbortSignal) {
    await this.write(`${command}\r\n`, signal);
    const line = await this.readLine(signal);
    if (!accepted.some((code) => line.startsWith(code))) throw new Error(`NNTP command failed: ${line}`);
    return line;
  }

  private async write(data: string, signal?: AbortSignal) {
    if (!this.socket) throw new Error("NNTP socket is not connected");
    if (signal?.aborted) throw this.abortError();
    if (this.socketError) throw this.socketError;
    if (this.socket.write(data, "binary")) return;

    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy(this.abortError());
        reject(this.abortError());
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(this.socketError ?? new Error("NNTP socket closed"));
      };
      const cleanup = () => {
        socket.off("drain", onDrain);
        socket.off("close", onClose);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      socket.on("drain", onDrain);
      socket.on("close", onClose);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async readLine(signal?: AbortSignal): Promise<string> {
    return (await this.readLineBuffer(signal)).toString("latin1");
  }

  private async readLineBuffer(signal?: AbortSignal): Promise<Buffer> {
    let index = this.buffer.indexOf(CRLF);
    while (index === -1) {
      if (!this.socket) throw new Error("NNTP socket is not connected");
      await this.waitForSocket("data", signal);
      index = this.buffer.indexOf(CRLF);
    }
    const line = this.buffer.subarray(0, index);
    this.buffer = this.buffer.subarray(index + CRLF.length);
    return line;
  }

  private async readMultiline(signal?: AbortSignal): Promise<string> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine(signal);
      if (line === ".") break;
      lines.push(line.startsWith("..") ? line.slice(1) : line);
    }
    return lines.join("\r\n");
  }
}
