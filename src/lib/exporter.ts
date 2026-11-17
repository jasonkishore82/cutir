import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { ASPECT_SIZES, drawFrame, type MediaSource } from "./renderer";
import type { Project } from "../store/project";

/**
 * MP4 export. Frames are rendered with the SAME drawFrame() as the preview, then encoded by ffmpeg.wasm.
 * To keep memory bounded on long songs, frames are encoded in segments (JPEG frames are deleted after each
 * segment is encoded) and the segments are concatenated with the original audio muxed in at the end.
 */

export type ExportProgress = { stage: string; fraction: number };
type Opts = { duration: number; onProgress: (p: ExportProgress) => void; signal: AbortSignal };

const SEGMENT_FRAMES = 150;
const JPEG_QUALITY = 0.92;

const abortError = () => new DOMException("Export cancelled", "AbortError");

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the background image"));
    img.src = url;
  });
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error("Could not load the background video"));
    v.src = url;
  });
}

async function seekVideo(v: HTMLVideoElement, t: number) {
  const target = v.duration > 0 ? t % v.duration : 0;
  if (Math.abs(v.currentTime - target) < 0.001) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      v.removeEventListener("seeked", done);
      resolve();
    };
    v.addEventListener("seeked", done);
    v.currentTime = target;
  });
}

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob(
      async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error("Frame encode failed"))),
      "image/jpeg",
      JPEG_QUALITY
    )
  );

const pad = (n: number, w = 5) => String(n).padStart(w, "0");

export async function exportMp4(project: Project, { duration, onProgress, signal }: Opts): Promise<Blob> {
  if (!(duration > 0)) throw new Error("Nothing to export yet. Add audio or lyrics first.");
  const { w, h } = ASPECT_SIZES[project.aspect];
  const fps = project.fps;
  const total = Math.max(1, Math.ceil(duration * fps));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");

  // fonts must be ready before the first frame, or early frames fall back to a default font
  try {
    await document.fonts.load(`48px "${project.style.fontFamily}"`);
  } catch {
    /* draw with whatever is available */
  }

  let bg: MediaSource | undefined;
  let bgVideo: HTMLVideoElement | undefined;
  const asset = project.background.type === "asset" ? project.background.asset : undefined;
  if (asset?.url) {
    if (asset.kind === "video") bg = bgVideo = await loadVideo(asset.url);
    else bg = await loadImage(asset.url);
  }

  onProgress({ stage: "Loading encoder", fraction: 0 });
  const ffmpeg = new FFmpeg();
  const onAbort = () => ffmpeg.terminate();
  signal.addEventListener("abort", onAbort);
  const check = () => {
    if (signal.aborted) throw abortError();
  };

  try {
    await ffmpeg.load({ coreURL, wasmURL });
    check();

    /* audio */
    let audioName: string | undefined;
    if (project.audio?.url) {
      const ext = (/\.([a-z0-9]+)$/i.exec(project.audio.name)?.[1] ?? "mp3").toLowerCase();
      audioName = `audio.${ext}`;
      const buf = await (await fetch(project.audio.url)).arrayBuffer();
      await ffmpeg.writeFile(audioName, new Uint8Array(buf));
    }
    check();

    /* frames -> segments */
    const segments: string[] = [];
    let rendered = 0;
    let encoded = 0;
    const report = (stage: string) =>
      onProgress({ stage, fraction: Math.min(0.97, (rendered * 0.6 + encoded * 0.37) / total) });

    for (let first = 0, seg = 0; first < total; first += SEGMENT_FRAMES, seg++) {
      const count = Math.min(SEGMENT_FRAMES, total - first);

      for (let i = 0; i < count; i++) {
        check();
        const t = (first + i) / fps;
        if (bgVideo) await seekVideo(bgVideo, t);
        drawFrame(ctx, project, t, w, h, { bg });
        await ffmpeg.writeFile(`f${pad(i)}.jpg`, await toJpeg(canvas));
        rendered++;
        if (i % 5 === 0) report(`Rendering frames ${rendered}/${total}`);
      }

      report("Encoding video");
      const name = `seg${pad(seg, 3)}.mp4`;
      const code = await ffmpeg.exec([
        "-framerate", String(fps),
        "-i", "f%05d.jpg",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        name,
      ]);
      check();
      if (code !== 0) throw new Error(`Video encoding failed (ffmpeg exit ${code})`);
      segments.push(name);
      encoded += count;
      for (let i = 0; i < count; i++) await ffmpeg.deleteFile(`f${pad(i)}.jpg`);
      report(`Rendering frames ${rendered}/${total}`);
    }

    /* join segments + mux the original audio */
    onProgress({ stage: "Muxing audio", fraction: 0.97 });
    await ffmpeg.writeFile("list.txt", new TextEncoder().encode(segments.map((s) => `file '${s}'`).join("\n")));
    const args = ["-f", "concat", "-safe", "0", "-i", "list.txt"];
    if (audioName) {
      args.push("-i", audioName, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest");
    } else {
      args.push("-c", "copy");
    }
    args.push("-movflags", "+faststart", "out.mp4");
    const code = await ffmpeg.exec(args);
    check();
    if (code !== 0) throw new Error(`Muxing failed (ffmpeg exit ${code})`);

    const data = (await ffmpeg.readFile("out.mp4")) as Uint8Array;
    onProgress({ stage: "Done", fraction: 1 });
    return new Blob([data.slice().buffer], { type: "video/mp4" });
  } catch (e) {
    if (signal.aborted) throw abortError();
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      ffmpeg.terminate();
    } catch {
      /* already terminated */
    }
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
