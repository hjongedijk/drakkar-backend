import { dirname, relative } from "node:path";
import { env } from "./config/env.js";

function normalizeVfsDir(path: string) {
  const rel = relative(env.VFS_ROOT, path);
  if (rel.startsWith("..")) return null;
  const normalized = `/${rel.replace(/\\/g, "/")}`.replace(/\/+/g, "/");
  return normalized === "/." ? "/" : normalized;
}

export function vfsForgetPathsForFilesystemPaths(paths: Iterable<string>) {
  return [...new Set(
    [...paths]
      .map((path) => normalizeVfsDir(path))
      .filter((path): path is string => Boolean(path))
  )];
}

export async function forgetRcloneVfsPaths(paths: Iterable<string>) {
  const dirs = [...new Set([...paths].filter(Boolean))];
  if (dirs.length === 0) return { ok: true, skipped: true, paths: [] as string[] };
  const body = Object.fromEntries(dirs.map((dir, index) => [index === 0 ? "dir" : `dir${index + 1}`, dir]));
  try {
    const response = await fetch(`${env.RCLONE_RC_URL.replace(/\/+$/, "")}/vfs/forget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      return { ok: false, skipped: false, paths: dirs, error: `HTTP ${response.status}` };
    }
    return { ok: true, skipped: false, paths: dirs };
  } catch (error) {
    return { ok: false, skipped: false, paths: dirs, error: error instanceof Error ? error.message : String(error) };
  }
}

export function libraryForgetPaths(linkPath: string, sourcePath?: string | null) {
  const dirs = new Set<string>();
  const linkDir = normalizeVfsDir(dirname(linkPath));
  if (linkDir) dirs.add(linkDir);
  if (sourcePath) {
    const sourceDir = normalizeVfsDir(dirname(sourcePath));
    if (sourceDir) dirs.add(sourceDir);
  }
  dirs.add("/completed-symlinks");
  return [...dirs];
}
