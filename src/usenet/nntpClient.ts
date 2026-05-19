import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import type { UsenetServer } from "@prisma/client";

type Socket = net.Socket | tls.TLSSocket;

export class NntpClient {
  private socket?: Socket;
  private buffer = "";

  constructor(private readonly server: UsenetServer) {}

  async connect(signal?: AbortSignal) {
    this.socket = this.server.ssl
      ? tls.connect({ host: this.server.host, port: this.server.port, servername: this.server.host })
      : net.connect({ host: this.server.host, port: this.server.port });
    this.socket.setTimeout(30000);
    this.socket.setEncoding("binary");
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
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

    await Promise.race([
      once(this.socket, event),
      once(this.socket, "error").then(([error]) => {
        throw error;
      }),
      new Promise((_, reject) => {
        if (!signal) return;
        const onAbort = () => {
          this.socket?.destroy(this.abortError());
          reject(this.abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
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
    if (!this.socket.write(data, "binary")) await once(this.socket, "drain");
  }

  private async readLine(signal?: AbortSignal): Promise<string> {
    while (!this.buffer.includes("\r\n")) {
      if (!this.socket) throw new Error("NNTP socket is not connected");
      await this.waitForSocket("data", signal);
    }
    const index = this.buffer.indexOf("\r\n");
    const line = this.buffer.slice(0, index);
    this.buffer = this.buffer.slice(index + 2);
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
