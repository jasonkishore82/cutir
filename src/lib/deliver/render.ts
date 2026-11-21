import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  FlacOutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from "mediabunny";
import type { Project } from "../../store/project";
import type { ProjectDoc } from "../../model/types";
import { abortError, exportAudio, nextTask, setup, type ExportProgress } from "../exporter";
import { CONTAINER_MIME, fitSize, fpsFor, isAudioOnly, type AudioCodecId, type Container, type DeliverPreset, type SourceChoice, type VideoCodecId } from "./presets";
import { ASPECT_SIZES } from "../renderer";
import { zipStore } from "./zip";

/** Phase 26: render one delivery job: a preset applied to one timeline over a range. */

export type RenderSpec = {
  preset: DeliverPreset;
  project: Project;
  doc: ProjectDoc;
  start: number;
  end: number;
  source: SourceChoice;
  onProgress: (p: ExportProgress) => void;
  signal: AbortSignal;
};

const VCODEC: Record<VideoCodecId, VideoCodec> = { avc: "avc", hevc: "hevc", vp9: "vp9", av1: "av1" };
const ACODEC: Record<AudioCodecId, AudioCodec> = { aac: "aac", opus: "opus", flac: "flac", wav: "pcm-s16" };
const QUALITY = { low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH, "very-high": QUALITY_VERY_HIGH };
const NAMES: Record<string, string> = { avc: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1", aac: "AAC", opus: "Opus", flac: "FLAC", wav: "WAV" };

const formatOf = (c: Container): OutputFormat =>
  c === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : c === "webm" ? new WebMOutputFormat() : c === "wav" ? new WavOutputFormat() : c === "flac" ? new FlacOutputFormat() : new OggOutputFormat();

/** The frame size and rate a preset gives a project. */
export function targetOf(preset: DeliverPreset, project: Project) {
  const base = ASPECT_SIZES[project.aspect];
  return { ...fitSize(preset, { w: base.w, h: base.h }), fps: fpsFor(preset, project.fps) };
}

/** Ask the browser whether it can encode what the preset needs. Returns a message in plain words when it cannot. */
export async function capabilityProblem(preset: DeliverPreset, w: number, h: number, fps: number): Promise<string | null> {
  const c = preset.container;
  if (c === "gif" || c === "png-seq") return null;
  if (!isAudioOnly(c)) {
    if (typeof VideoEncoder === "undefined") return "This browser has no video encoder (WebCodecs). Try a recent Chrome or Edge.";
    const ok = await canEncodeVideo(VCODEC[preset.video], { width: w, height: h, frameRate: fps, bitrate: Math.round(preset.bitrateMbps * 1e6) });
    if (!ok) return `This browser cannot encode ${NAMES[preset.video]} at ${w}x${h}. Pick another codec or a smaller size.`;
  }
  if (preset.audio !== "wav") {
    const ok = await canEncodeAudio(ACODEC[preset.audio], { numberOfChannels: 2, sampleRate: 48000, bitrate: preset.audioKbps * 1000 });
    if (!ok) return `This browser cannot encode ${NAMES[preset.audio]} audio. Pick another audio format.`;
  }
  return null;
}

/** The part of a buffer between two times, for ranges that do not start at zero. */
function slice(buf: AudioBuffer, start: number, end: number): AudioBuffer {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.min(buf.length, Math.round(start * sr)));
  const b = Math.max(a + 1, Math.min(buf.length, Math.round(end * sr)));
  if (a === 0 && b === buf.length) return buf;
  const out = new AudioBuffer({ length: b - a, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, b), c);
  return out;
}

async function mixRange(s: RenderSpec): Promise<AudioBuffer | null> {
  const buf = await exportAudio(s.project, s.end, s.signal, s.doc);
  return buf ? slice(buf, s.start, s.end) : null;
}

/** Render the job. Throws AbortError when cancelled and an Error with a readable message when something cannot be done. */
export async function renderDeliver(s: RenderSpec): Promise<{ blob: Blob; audio: boolean }> {
  const { preset, signal, onProgress } = s;
  const seconds = s.end - s.start;
  if (!(seconds > 0)) throw new Error("The range is empty.");
  const check = () => {
    if (signal.aborted) throw abortError();
  };
  const { w, h, fps } = targetOf(preset, s.project);
  const problem = await capabilityProblem(preset, w, h, fps);
  if (problem) throw new Error(problem);

  if (isAudioOnly(preset.container)) return { blob: await renderAudioOnly(s, seconds), audio: true };
  if (preset.container === "png-seq" || preset.container === "gif") return { blob: await renderStills(s, seconds, w, h, fps), audio: false };

  const { total, canvas, render } = await setup(s.project, seconds, 1, { doc: s.doc, size: { w, h }, fps, start: s.start, source: s.source });
  const output = new Output({ format: formatOf(preset.container), target: new BufferTarget() });
  const rate =
    preset.rateMode === "quality" ? { quality: QUALITY[preset.quality] } : { bitrate: Math.round(preset.bitrateMbps * 1e6) };
  const video = new CanvasSource(canvas, { codec: VCODEC[preset.video], keyFrameInterval: preset.keyframeSeconds, ...rate });
  output.addVideoTrack(video, { frameRate: fps });

  onProgress({ stage: "Mixing audio", fraction: 0 });
  const mix = await mixRange(s);
  check();
  let audio: AudioBufferSource | undefined;
  if (mix) {
    audio = new AudioBufferSource({ codec: ACODEC[preset.audio], bitrate: preset.audioKbps * 1000 });
    output.addAudioTrack(audio);
  }

  try {
    await output.start();
    const audioDone = audio && mix ? audio.add(mix).then(() => audio!.close()) : Promise.resolve();
    for (let i = 0; i < total; i++) {
      check();
      await render(i);
      await video.add(i / fps, 1 / fps);
      if (i % 10 === 0) {
        onProgress({ stage: `Rendering + encoding ${i + 1}/${total}`, fraction: Math.min(0.96, (i / total) * 0.96), engine: "gpu" });
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
  onProgress({ stage: "Done", fraction: 1 });
  return { blob: new Blob([buffer], { type: CONTAINER_MIME[preset.container] }), audio: !!mix };
}

async function renderAudioOnly(s: RenderSpec, seconds: number): Promise<Blob> {
  s.onProgress({ stage: "Mixing audio", fraction: 0.05 });
  const mix = await mixRange(s);
  if (s.signal.aborted) throw abortError();
  if (!mix) throw new Error("There is no audio in this range.");
  const output = new Output({ format: formatOf(s.preset.container), target: new BufferTarget() });
  const src = new AudioBufferSource({ codec: ACODEC[s.preset.audio], bitrate: s.preset.audioKbps * 1000 });
  output.addAudioTrack(src);
  await output.start();
  await src.add(mix);
  src.close();
  s.onProgress({ stage: "Finishing", fraction: 0.9 });
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer || seconds <= 0) throw new Error("The encoder produced no data");
  s.onProgress({ stage: "Done", fraction: 1 });
  return new Blob([buffer], { type: CONTAINER_MIME[s.preset.container] });
}

const toPng = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error("Frame encode failed"))), "image/png")
  );

/** A PNG sequence in a zip, or a GIF made from the same frames by ffmpeg (palette per file for clean colours). */
async function renderStills(s: RenderSpec, seconds: number, w: number, h: number, fps: number): Promise<Blob> {
  const { total, canvas, render } = await setup(s.project, seconds, 1, { doc: s.doc, size: { w, h }, fps, start: s.start, source: s.source });
  if (s.preset.container === "gif" && total > 900) throw new Error("A GIF this long would be huge. Use a shorter range or lower frame rate.");
  const frames: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    if (s.signal.aborted) throw abortError();
    await render(i);
    frames.push(await toPng(canvas));
    if (i % 5 === 0) {
      s.onProgress({ stage: `Rendering frames ${i + 1}/${total}`, fraction: Math.min(0.85, (i / total) * 0.85) });
      if (i % 30 === 0) await nextTask();
    }
  }
  const pad = (n: number) => String(n).padStart(5, "0");
  if (s.preset.container === "png-seq") {
    s.onProgress({ stage: "Packing", fraction: 0.9 });
    const zip = zipStore(frames.map((data, i) => ({ name: `frame_${pad(i)}.png`, data })));
    s.onProgress({ stage: "Done", fraction: 1 });
    return new Blob([zip.slice().buffer], { type: CONTAINER_MIME["png-seq"] });
  }

  s.onProgress({ stage: "Encoding GIF", fraction: 0.88 });
  const ffmpeg = new FFmpeg();
  const onAbort = () => ffmpeg.terminate();
  s.signal.addEventListener("abort", onAbort);
  try {
    await ffmpeg.load({ coreURL, wasmURL });
    for (let i = 0; i < frames.length; i++) await ffmpeg.writeFile(`f${pad(i)}.png`, frames[i]);
    const code = await ffmpeg.exec([
      "-framerate", String(fps), "-i", "f%05d.png",
      "-vf", "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
      "-loop", "0", "out.gif",
    ]);
    if (s.signal.aborted) throw abortError();
    if (code !== 0) throw new Error(`GIF encoding failed (ffmpeg exit ${code})`);
    const data = (await ffmpeg.readFile("out.gif")) as Uint8Array;
    s.onProgress({ stage: "Done", fraction: 1 });
    return new Blob([data.slice().buffer], { type: "image/gif" });
  } catch (e) {
    if (s.signal.aborted) throw abortError();
    throw e;
  } finally {
    s.signal.removeEventListener("abort", onAbort);
    try {
      ffmpeg.terminate();
    } catch {
      /* already terminated */
    }
  }
}
