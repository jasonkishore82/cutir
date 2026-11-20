import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import { ASPECT_SIZES, type MediaSource } from "./renderer";
import { useProject, type Project } from "../store/project";
import { ensureFont } from "./fonts";
import { viewToDoc } from "../model/convert";
import type { ProjectDoc } from "../model/types";
import { needsAt, renderFrame } from "../render/compositor";
import { exactFrames } from "../render/sources";
import { mixInputs, mixPlan, mixdown } from "../render/audio";
import { useMedia } from "../store/media";

/**
 * MP4 export. Every frame is drawn with the SAME renderFrame() the preview uses (lyric background, timeline video and
 * image tracks, lyric text); export waits until each clip's frame is exactly decoded. The sound is one mix of the
 * song and every audible audio clip.
 *
 *  1. Fast path (WebCodecs): frames go straight from the canvas into the browser's H.264 encoder (hardware
 *     accelerated where available) and are muxed to MP4 with Mediabunny. Audio is encoded to AAC the same way.
 *  2. Compatibility path (ffmpeg.wasm): used automatically when WebCodecs cannot encode H.264 at this size.
 *     Much slower (single-threaded WebAssembly), but works everywhere.
 */

export type ExportProgress = { stage: string; fraction: number; engine?: "gpu" | "cpu" };
/** Output size as a multiple of the 1080p-based canvas: 1 = 1080p, 2 = 4K (3840x2160). */
export type ExportScale = 1 | 2;
type Opts = { duration: number; onProgress: (p: ExportProgress) => void; signal: AbortSignal; scale?: ExportScale };

const abortError = () => new DOMException("Export cancelled", "AbortError");
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0)); // let the UI repaint the progress bar

class Unsupported extends Error {}

/* ---------- shared setup ---------- */

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

/** The document behind a lyric view: the live one when exporting the open project. */
function docFor(project: Project): ProjectDoc {
  const st = useProject.getState();
  return project === st.project ? st.doc : viewToDoc(project);
}

const urlOfMedia = (doc: ProjectDoc) => (mediaId: string) => {
  const pool = doc.media.find((m) => m.id === mediaId)?.poolId;
  return pool ? useMedia.getState().urls[pool] : undefined;
};

/** The exported sound: the song and every audible timeline audio clip, mixed to one stereo track. */
async function exportAudio(project: Project, duration: number, signal: AbortSignal): Promise<AudioBuffer | null> {
  const doc = docFor(project);
  return mixdown(mixInputs(doc, project.audio?.url, duration, urlOfMedia(doc)), duration, 48000, signal, mixPlan(doc, duration));
}

/** 16-bit PCM WAV of a buffer, for the ffmpeg paths. */
function wavOf(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + n * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 2) data.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 0x7fff, true);
  return new Blob([data.buffer], { type: "audio/wav" });
}

async function setup(project: Project, duration: number, scale: ExportScale = 1) {
  if (!(duration > 0)) throw new Error("Nothing to export yet. Add audio or lyrics first.");
  const base = ASPECT_SIZES[project.aspect];
  const w = base.w * scale;
  const h = base.h * scale;
  const fps = project.fps;
  const total = Math.max(1, Math.ceil(duration * fps));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");

  // fonts must be ready before the first frame, or early frames fall back to a default font
  try {
    await ensureFont(project.style.fontFamily, project.lines.map((l) => l.text).join(" "));
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

  const doc = docFor(project);
  const frames = exactFrames();

  /** Draw frame `i` onto the canvas: wait for the exact pictures of every clip at t, then composite. */
  const render = async (i: number) => {
    const t = i / fps;
    if (bgVideo) await seekVideo(bgVideo, t);
    await frames.prepare(needsAt(doc, t));
    renderFrame(ctx, doc, project, t, w, h, { bg }, frames);
  };

  return { w, h, fps, total, canvas, render };
}

/* ---------- fast path: WebCodecs + Mediabunny ---------- */

async function exportViaWebCodecs(project: Project, { duration, onProgress, signal, scale }: Opts): Promise<Blob> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") throw new Unsupported("WebCodecs is not available");

  const { w, h, fps, total, canvas, render } = await setup(project, duration, scale);
  const check = () => {
    if (signal.aborted) throw abortError();
  };

  // Explicit bitrate (~0.25 bits per pixel per frame: 1080p30 ≈ 15 Mbps, 4K30 ≈ 62 Mbps). QUALITY_HIGH alone is far lower
  // and smears fine text and gradients.
  const bitrate = Math.round(w * h * fps * 0.25);
  if (!(await canEncodeVideo("avc", { width: w, height: h, frameRate: fps, bitrate }))) {
    throw new Unsupported(`This browser cannot encode H.264 at ${w}x${h}`);
  }

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: "avc", bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: fps });

  /* audio: mix the song and the timeline's audio clips once, then encode to AAC with the same muxer when possible */
  let audio: AudioBufferSource | undefined;
  let audioFileForFallback: { url: string; name: string } | undefined;
  onProgress({ stage: "Mixing audio", fraction: 0 });
  const audioBuffer = (await exportAudio(project, duration, signal)) ?? undefined;
  check();
  if (audioBuffer) {
    if (await canEncodeAudio("aac", { numberOfChannels: audioBuffer.numberOfChannels, sampleRate: audioBuffer.sampleRate, quality: QUALITY_HIGH })) {
      audio = new AudioBufferSource({ codec: "aac", quality: QUALITY_HIGH });
      output.addAudioTrack(audio);
    } else {
      audioFileForFallback = { url: URL.createObjectURL(wavOf(audioBuffer)), name: "mix.wav" }; // video-only now, audio muxed by ffmpeg below
    }
  }

  try {
    await output.start();

    // Audio and video are added concurrently: the muxer holds back whichever track runs ahead.
    const audioDone = audio && audioBuffer ? audio.add(audioBuffer).then(() => audio!.close()) : Promise.resolve();

    for (let i = 0; i < total; i++) {
      check();
      await render(i);
      await video.add(i / fps, 1 / fps); // resolves when the encoder can take more frames (backpressure)
      if (i % 10 === 0) {
        onProgress({ stage: `Rendering + encoding ${i + 1}/${total}`, fraction: Math.min(0.96, (i / total) * 0.96) });
        if (i % 60 === 0) await nextTask();
      }
    }
    video.close();
    onProgress({ stage: "Finishing", fraction: 0.97 });
    await audioDone;
    await output.finalize();
  } catch (e) {
    try {
      await output.cancel();
    } catch {
      /* already closed */
    }
    throw e;
  }

  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error("The encoder produced no data");
  let blob = new Blob([buffer], { type: "video/mp4" });

  if (audioFileForFallback) {
    onProgress({ stage: "Adding audio", fraction: 0.97 });
    try {
      blob = await muxAudioWithFfmpeg(blob, audioFileForFallback, signal);
    } finally {
      URL.revokeObjectURL(audioFileForFallback.url);
    }
  }
  onProgress({ stage: "Done", fraction: 1 });
  return blob;
}

/** Only used when the browser has no AAC encoder: copy the finished video and add the original audio as AAC. */
async function muxAudioWithFfmpeg(video: Blob, audio: { url: string; name: string }, signal: AbortSignal): Promise<Blob> {
  const ffmpeg = new FFmpeg();
  const onAbort = () => ffmpeg.terminate();
  signal.addEventListener("abort", onAbort);
  try {
    await ffmpeg.load({ coreURL, wasmURL });
    const ext = (/\.([a-z0-9]+)$/i.exec(audio.name)?.[1] ?? "mp3").toLowerCase();
    await ffmpeg.writeFile("video.mp4", new Uint8Array(await video.arrayBuffer()));
    await ffmpeg.writeFile(`audio.${ext}`, new Uint8Array(await (await fetch(audio.url)).arrayBuffer()));
    const code = await ffmpeg.exec([
      "-i", "video.mp4", "-i", `audio.${ext}`,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
      "-movflags", "+faststart", "out.mp4",
    ]);
    if (signal.aborted) throw abortError();
    if (code !== 0) throw new Error(`Adding audio failed (ffmpeg exit ${code})`);
    const data = (await ffmpeg.readFile("out.mp4")) as Uint8Array;
    return new Blob([data.slice().buffer], { type: "video/mp4" });
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      ffmpeg.terminate();
    } catch {
      /* already terminated */
    }
  }
}

/* ---------- compatibility path: ffmpeg.wasm ---------- */

const SEGMENT_FRAMES = 150;
const JPEG_QUALITY = 0.98;
const pad = (n: number, w = 5) => String(n).padStart(w, "0");

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob(
      async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error("Frame encode failed"))),
      "image/jpeg",
      JPEG_QUALITY
    )
  );

/**
 * Frames are encoded in segments (JPEG frames are deleted after each segment is encoded) and the segments are
 * concatenated with the original audio muxed in at the end, to keep memory bounded on long songs.
 */
async function exportViaFfmpeg(project: Project, { duration, onProgress, signal, scale }: Opts): Promise<Blob> {
  const { fps, total, canvas, render } = await setup(project, duration, scale);

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

    let audioName: string | undefined;
    const mix = await exportAudio(project, duration, signal);
    if (mix) {
      audioName = "mix.wav";
      await ffmpeg.writeFile(audioName, new Uint8Array(await wavOf(mix).arrayBuffer()));
    }
    check();

    const segments: string[] = [];
    let rendered = 0;
    let encoded = 0;
    const report = (stage: string) => onProgress({ stage, fraction: Math.min(0.97, (rendered * 0.6 + encoded * 0.37) / total) });

    for (let first = 0, seg = 0; first < total; first += SEGMENT_FRAMES, seg++) {
      const count = Math.min(SEGMENT_FRAMES, total - first);

      for (let i = 0; i < count; i++) {
        check();
        await render(first + i);
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
        "-preset", "superfast",
        "-crf", "16",
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

/* ---------- entry point ---------- */

/** Export to MP4. Tries the fast GPU path first and falls back to ffmpeg.wasm if that is not possible. */
export async function exportMp4(project: Project, opts: Opts): Promise<Blob> {
  try {
    return await exportViaWebCodecs(project, { ...opts, onProgress: (p) => opts.onProgress({ ...p, engine: "gpu" }) });
  } catch (e) {
    if (opts.signal.aborted || (e as Error).name === "AbortError") throw abortError();
    if (!(e instanceof Unsupported)) console.warn("Fast export failed, using the compatibility encoder:", e);
    opts.onProgress({ stage: "Using the compatibility encoder (slower)", fraction: 0, engine: "cpu" });
    return exportViaFfmpeg(project, { ...opts, onProgress: (p) => opts.onProgress({ ...p, engine: "cpu" }) });
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
