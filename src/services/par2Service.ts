import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export type Par2Result = {
  status: "not_found" | "verified" | "repaired" | "failed" | "tool_missing";
  par2Files: string[];
  message: string;
  output?: string;
};

async function toolPath(name: string) {
  const paths = (process.env.PATH ?? "").split(":").map((path) => join(path, name));
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function listFiles(path: string): Promise<string[]> {
  const stats = await stat(path);
  if (!stats.isDirectory()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const children = await Promise.all(entries.map((entry) => listFiles(join(path, entry.name))));
  return children.flat();
}

function primaryPar2(files: string[]) {
  return (
    files.find((file) => /\.par2$/i.test(file) && !/\.vol\d+\+\d+\.par2$/i.test(file)) ??
    files.find((file) => /\.par2$/i.test(file))
  );
}

function trimOutput(stdout = "", stderr = "") {
  return `${stdout}\n${stderr}`.trim().slice(-8000);
}

export async function verifyAndRepairPar2(path: string): Promise<Par2Result> {
  const files = await listFiles(path).catch(() => []);
  const par2Files = files.filter((file) => file.toLowerCase().endsWith(".par2"));
  const par2File = primaryPar2(par2Files);
  if (!par2File) return { status: "not_found", par2Files, message: "no PAR2 files found" };

  const par2 = await toolPath("par2");
  if (!par2) return { status: "tool_missing", par2Files, message: "PAR2 files detected but par2 is not installed" };

  try {
    const verify = await execFileAsync(par2, ["verify", basename(par2File)], {
      cwd: dirname(par2File),
      timeout: 1000 * 60 * 30,
      maxBuffer: 1024 * 1024 * 4
    });
    return {
      status: "verified",
      par2Files,
      message: "PAR2 verify passed",
      output: trimOutput(verify.stdout, verify.stderr)
    };
  } catch {
    try {
      const repair = await execFileAsync(par2, ["repair", basename(par2File)], {
        cwd: dirname(par2File),
        timeout: 1000 * 60 * 60,
        maxBuffer: 1024 * 1024 * 4
      });
      return {
        status: "repaired",
        par2Files,
        message: "PAR2 repair completed",
        output: trimOutput(repair.stdout, repair.stderr)
      };
    } catch (repairError) {
      const error = repairError as { stdout?: string; stderr?: string; message?: string };
      return {
        status: "failed",
        par2Files,
        message: error.message ?? "PAR2 repair failed",
        output: trimOutput(error.stdout, error.stderr)
      };
    }
  }
}
