import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
const READ_PROBE_TIMEOUT_MS = 12_000;
const READ_PROBE_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 45_000;
const PROBE_CACHE_TTL_MS = 15 * 60_000;

type ProbeResult = {
  ok: boolean;
  hasVideo: boolean;
  reason?: string;
};

const probeCache = new Map<string, { value: ProbeResult; expiresAt: number; mtimeMs: number; size: number }>();

function cachedProbe(path: string, mtimeMs: number, size: number) {
  const entry = probeCache.get(path);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    probeCache.delete(path);
    return null;
  }
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
    probeCache.delete(path);
    return null;
  }
  return entry.value;
}

function storeProbe(path: string, mtimeMs: number, size: number, value: ProbeResult) {
  probeCache.set(path, {
    value,
    expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
    mtimeMs,
    size
  });
  return value;
}

type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string };

async function runCommandWithDeadline(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer?: number }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length >= maxBuffer) return;
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) stdout = stdout.slice(0, maxBuffer);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= maxBuffer) return;
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) stderr = stderr.slice(0, maxBuffer);
    });
    child.on("error", (error) => {
      finish({ ok: false, reason: error.message });
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish({ ok: true, stdout });
        return;
      }
      const reason = stderr.trim()
        || stdout.trim()
        || (signal ? `terminated by ${signal}` : `exited with code ${code ?? "unknown"}`);
      finish({ ok: false, reason });
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill failures; the point is to stop waiting on the child.
      }
      child.unref();
      finish({ ok: false, reason: `timed out after ${options.timeoutMs}ms` });
    }, options.timeoutMs);
  });
}

async function readProbeFile(path: string) {
  const result = await runCommandWithDeadline(
    "dd",
    [
      `if=${path}`,
      "of=/dev/null",
      "bs=1M",
      `count=${Math.max(1, Math.ceil(READ_PROBE_BYTES / (1024 * 1024)))}`,
      "status=none"
    ],
    { timeoutMs: READ_PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 }
  );
  if (!result.ok) throw new Error(result.reason);
}

export async function probeMediaFile(path: string): Promise<ProbeResult> {
  let fileStats;
  try {
    fileStats = await stat(path);
  } catch (error) {
    return {
      ok: false,
      hasVideo: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const cached = cachedProbe(path, fileStats.mtimeMs, fileStats.size);
  if (cached) return cached;
  try {
    await readProbeFile(path);
    const probeResult = await runCommandWithDeadline(
      "ffprobe",
      [
        "-v", "error",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        "-analyzeduration", "20000000",
        "-probesize", "20000000",
        path
      ],
      { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
    );
    if (!probeResult.ok) {
      throw new Error(probeResult.reason);
    }
    const stdout = probeResult.stdout;
    const parsed = JSON.parse(stdout || "{}") as {
      streams?: Array<{ codec_type?: string | null }>;
      format?: { format_name?: string | null };
    };
    const hasVideo = Array.isArray(parsed.streams) && parsed.streams.some((stream) => stream?.codec_type === "video");
    if (!hasVideo) {
      return storeProbe(path, fileStats.mtimeMs, fileStats.size, {
        ok: false,
        hasVideo: false,
        reason: "ffprobe found no video stream"
      });
    }
    return storeProbe(path, fileStats.mtimeMs, fileStats.size, {
      ok: true,
      hasVideo: true
    });
  } catch (error) {
    return storeProbe(path, fileStats.mtimeMs, fileStats.size, {
      ok: false,
      hasVideo: false,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}
