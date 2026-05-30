import type { FastifyBaseLogger } from "fastify";

type LogValue = Record<string, unknown> | Error | string | number | boolean | null | undefined;

const colors = {
  trace: "\x1b[90m",
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[35m",
  reset: "\x1b[0m",
  dim: "\x1b[2m"
};

const fieldColors = {
  key: "\x1b[36m",
  value: "\x1b[37m"
};

const compactKeys = new Set([
  "reqId",
  "method",
  "path",
  "statusCode",
  "ms",
  "downloadId",
  "requestId",
  "title",
  "status",
  "streams",
  "ioAvg10",
  "recovered",
  "retried",
  "queueSeedTarget",
  "pendingQueueItems",
  "recoveryBatchLimit",
  "activeStreamCount",
  "mediaPropfindCount",
  "propfindCount",
  "error",
  "err.message"
]);

const levelOrder: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 99
};

function cleanLine(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function formatPrimitive(value: unknown): string {
  if (value instanceof Error) return cleanLine(value.message);
  if (Array.isArray(value)) return value.map((entry) => formatPrimitive(entry)).filter(Boolean).join(",");
  if (typeof value === "string") {
    const cleaned = cleanLine(value);
    if (cleaned.length > 180) return `${cleaned.slice(0, 177)}...`;
    return cleaned;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return cleanLine(JSON.stringify(value));
}

function basenameLike(value: string) {
  const normalized = value.replace(/\\/g, "/");
  return normalized.includes("/") ? normalized.split("/").filter(Boolean).pop() ?? value : value;
}

function flattenFields(value: LogValue, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (value instanceof Error) return [`${prefix || "error"}="${formatPrimitive(value)}"`];
  const fields: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || typeof raw === "function") continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (raw instanceof Error) {
      if (compactKeys.size > 0 && prefix === "" && !compactKeys.has(name)) continue;
      fields.push(`${name}="${formatPrimitive(raw)}"`);
    } else if (raw && typeof raw === "object" && !Array.isArray(raw) && !(raw instanceof Date)) {
      fields.push(...flattenFields(raw as Record<string, unknown>, name));
    } else {
      if (compactKeys.size > 0 && !compactKeys.has(name)) continue;
      const formatted = name.toLowerCase().includes("path") ? basenameLike(formatPrimitive(raw)) : formatPrimitive(raw);
      if (formatted) fields.push(`${name}="${formatted}"`);
    }
  }
  return fields;
}

function parseArgs(args: unknown[]) {
  const fields: string[] = [];
  const messages: string[] = [];
  for (const arg of args) {
    if (arg && typeof arg === "object" && !(arg instanceof Error) && !Array.isArray(arg)) {
      fields.push(...flattenFields(arg as Record<string, unknown>));
    } else {
      const message = formatPrimitive(arg);
      if (message) messages.push(message);
    }
  }
  return { message: messages.join(" "), fields };
}

export function buildLineLogger(minLevel = "info", bindings: Record<string, unknown> = {}): FastifyBaseLogger {
  const threshold = levelOrder[minLevel] ?? 30;

  const write = (level: keyof typeof levelOrder, args: unknown[]) => {
    if ((levelOrder[level] ?? 99) < threshold) return;
    const { message, fields } = parseArgs(args);
    const bindingFields = flattenFields(bindings);
    const time = new Date().toISOString();
    const color = colors[level as keyof typeof colors] ?? "";
    const suffix = [...bindingFields, ...fields]
      .map((field) => {
        const [key, ...rest] = field.split("=");
        return `${fieldColors.key}${key}${colors.reset}=${fieldColors.value}${rest.join("=")}${colors.reset}`;
      })
      .join(" ");
    const shortTime = time.slice(11, 19);
    const line = `${colors.dim}${shortTime}${colors.reset} ${color}${level.toUpperCase().padEnd(5)}${colors.reset} ${message}${suffix ? ` ${suffix}` : ""}`;
    process[level === "error" || level === "fatal" ? "stderr" : "stdout"].write(`${line}\n`);
  };

  const logger = {
    level: minLevel,
    trace: (...args: unknown[]) => write("trace", args),
    debug: (...args: unknown[]) => write("debug", args),
    info: (...args: unknown[]) => write("info", args),
    warn: (...args: unknown[]) => write("warn", args),
    error: (...args: unknown[]) => write("error", args),
    fatal: (...args: unknown[]) => write("fatal", args),
    silent: () => undefined,
    child: (childBindings: Record<string, unknown>, _options?: unknown) => {
      void _options;
      return buildLineLogger(minLevel, { ...bindings, ...childBindings });
    }
  };

  return logger as unknown as FastifyBaseLogger;
}
