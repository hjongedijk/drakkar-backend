import { access, mkdir, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join } from "node:path";
import { detectArchive, type ArchiveKind } from "./detect.js";

export type ExtractionResult = {
  archivePath: string;
  outputDir: string;
  kind: Exclude<ArchiveKind, "none">;
  tool: string;
  output: string;
};

async function toolAvailable(name: string) {
  const paths = (process.env.PATH ?? "").split(":").map((path) => join(path, name));
  for (const path of paths) {
    try {
      await access(path);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

function runTool(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8").trim();
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with ${code}: ${output}`));
    });
  });
}

async function walk(path: string): Promise<string[]> {
  const stats = await stat(path);
  if (!stats.isDirectory()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const children = await Promise.all(entries.map((entry) => walk(join(path, entry.name))));
  return children.flat();
}

function extractionDir(archivePath: string, outputRootDir?: string) {
  const ext = extname(archivePath);
  const base = basename(archivePath, ext).replace(/\.part0*1$/i, "");
  return outputRootDir ? join(outputRootDir, `${base}_extracted`) : join(dirname(archivePath), `${base}_extracted`);
}

async function extractArchive(
  archivePath: string,
  kind: Exclude<ArchiveKind, "none">,
  outputRootDir?: string
): Promise<ExtractionResult> {
  const outputDir = extractionDir(archivePath, outputRootDir);
  await mkdir(outputDir, { recursive: true });

  if (kind === "zip" && (await toolAvailable("unzip"))) {
    const output = await runTool("unzip", ["-o", archivePath, "-d", outputDir]);
    return { archivePath, outputDir, kind, tool: "unzip", output };
  }

  if (await toolAvailable("7z")) {
    const output = await runTool("7z", ["x", "-y", `-o${outputDir}`, archivePath]);
    return { archivePath, outputDir, kind, tool: "7z", output };
  }

  if ((kind === "rar" || kind === "rar-part") && (await toolAvailable("unrar"))) {
    const output = await runTool("unrar", ["x", "-o+", archivePath, `${outputDir}/`]);
    return { archivePath, outputDir, kind, tool: "unrar", output };
  }

  throw new Error(`no extractor available for ${kind} archive ${archivePath}`);
}

export async function extractArchiveFiles(
  archives: Array<{ archivePath: string; kind: Exclude<ArchiveKind, "none"> }>,
  options?: { outputRootDir?: string }
) {
  const results: ExtractionResult[] = [];
  for (const archive of archives) {
    results.push(await extractArchive(archive.archivePath, archive.kind, options?.outputRootDir));
  }
  return results;
}

export async function extractArchivesInPath(path: string, options?: { outputRootDir?: string }) {
  const files = await walk(path);
  const archives = files
    .map((archivePath) => ({ archivePath, kind: detectArchive(archivePath) }))
    .filter((archive): archive is { archivePath: string; kind: Exclude<ArchiveKind, "none"> } => archive.kind !== "none");
  return extractArchiveFiles(archives, options);
}
