import { spawn } from "node:child_process";
import { extname } from "node:path";
import { resolveVfsPlaybackPath } from "../vfs/vfsService.js";

const DIRECT_EXTENSIONS = new Set([".mp4", ".m4v", ".webm"]);
const DIRECT_AUDIO_EXTENSIONS = new Set([".mp4", ".m4v"]);
function ffmpegArgs(sourcePath: string) {
  const copyVideo = DIRECT_EXTENSIONS.has(extname(sourcePath).toLowerCase());
  const copyAudio = DIRECT_AUDIO_EXTENSIONS.has(extname(sourcePath).toLowerCase());

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+nobuffer",
    "-probesize",
    "2M",
    "-analyzeduration",
    "512k",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    ...(copyVideo
      ? ["-c:v", "copy"]
      : [
          "-vf",
          "scale='min(1280,iw)':-2",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "24",
          "-pix_fmt",
          "yuv420p"
        ]),
    ...(copyAudio
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-ac", "2", "-b:a", "160k"]),
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof+faststart",
    "-f",
    "mp4",
    "pipe:1"
  ];
}

export async function createBrowserPlayableStream(path: string) {
  const sourcePath = await resolveVfsPlaybackPath(path);
  const child = spawn("ffmpeg", ffmpegArgs(sourcePath), {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.once("error", () => {
    child.kill("SIGKILL");
  });

  return {
    stream: child.stdout,
    kill: () => child.kill("SIGKILL"),
    contentType: "video/mp4",
    stderr: () => stderr
  };
}
