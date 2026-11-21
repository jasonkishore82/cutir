/**
 * Phase 26: delivery presets. A preset is plain data: codec, container, size, frame rate, audio and a filename pattern.
 * Nothing here touches the browser, so it can be tested in node and saved or imported as JSON.
 */

export type VideoCodecId = "avc" | "hevc" | "vp9" | "av1";
export type AudioCodecId = "aac" | "opus" | "flac" | "wav";
export type Container = "mp4" | "webm" | "wav" | "flac" | "ogg" | "gif" | "png-seq";
export type RateMode = "quality" | "bitrate";
export type QualityLevel = "low" | "medium" | "high" | "very-high";
export type SourceChoice = "original" | "proxy";
export type RangeChoice = "whole" | "inout" | "selection";

export type DeliverPreset = {
  id: string;
  name: string;
  builtin?: boolean;
  container: Container;
  video: VideoCodecId;
  audio: AudioCodecId;
  /** "quality" lets the encoder pick the bitrate for a quality level; "bitrate" targets `bitrateMbps`. */
  rateMode: RateMode;
  quality: QualityLevel;
  bitrateMbps: number;
  keyframeSeconds: number;
  /** Output width and height. 0 means the project's own size (times `scale` when 2). */
  width: number;
  height: number;
  /** 0 keeps the project's frame rate. */
  fps: number;
  audioKbps: number;
  /** Tokens: {project} {timeline} {preset} {date} {time} {n} {w} {h} {fps} */
  pattern: string;
};

export const CONTAINER_EXT: Record<Container, string> = { mp4: "mp4", webm: "webm", wav: "wav", flac: "flac", ogg: "ogg", gif: "gif", "png-seq": "zip" };
export const CONTAINER_MIME: Record<Container, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  gif: "image/gif",
  "png-seq": "application/zip",
};
export const isAudioOnly = (c: Container) => c === "wav" || c === "flac" || c === "ogg";
export const isStillOut = (c: Container) => c === "gif" || c === "png-seq";

const base: Omit<DeliverPreset, "id" | "name"> = {
  container: "mp4",
  video: "avc",
  audio: "aac",
  rateMode: "bitrate",
  quality: "high",
  bitrateMbps: 12,
  keyframeSeconds: 2,
  width: 0,
  height: 0,
  fps: 0,
  audioKbps: 192,
  pattern: "{project}-{preset}",
};

export const BUILTIN_PRESETS: DeliverPreset[] = [
  { ...base, id: "youtube-1080", name: "YouTube 1080p", width: 1920, height: 1080, bitrateMbps: 12, builtin: true },
  { ...base, id: "youtube-4k", name: "YouTube 4K", width: 3840, height: 2160, bitrateMbps: 45, audioKbps: 256, builtin: true },
  { ...base, id: "shorts-reels", name: "Shorts and Reels 9:16", width: 1080, height: 1920, bitrateMbps: 10, builtin: true },
  { ...base, id: "instagram-square", name: "Instagram square", width: 1080, height: 1080, bitrateMbps: 8, builtin: true },
  { ...base, id: "twitter", name: "Twitter / X", width: 1280, height: 720, bitrateMbps: 6, fps: 30, audioKbps: 128, builtin: true },
  {
    ...base,
    id: "archive",
    name: "High quality archive",
    video: "hevc",
    rateMode: "quality",
    quality: "very-high",
    bitrateMbps: 80,
    audio: "aac",
    audioKbps: 320,
    builtin: true,
  },
  { ...base, id: "web-vp9", name: "WebM (VP9 + Opus)", container: "webm", video: "vp9", audio: "opus", bitrateMbps: 8, audioKbps: 160, builtin: true },
  { ...base, id: "audio-wav", name: "Audio only (WAV)", container: "wav", audio: "wav", pattern: "{project}-audio", builtin: true },
  { ...base, id: "audio-flac", name: "Audio only (FLAC)", container: "flac", audio: "flac", pattern: "{project}-audio", builtin: true },
  { ...base, id: "gif", name: "GIF", container: "gif", width: 640, height: 0, fps: 15, pattern: "{project}", builtin: true },
  { ...base, id: "png-seq", name: "PNG sequence (zip)", container: "png-seq", pattern: "{project}-frames", builtin: true },
];

export const presetById = (id: string, custom: DeliverPreset[] = []) => [...BUILTIN_PRESETS, ...custom].find((p) => p.id === id);

/* ---------- sizes ---------- */

/**
 * The pixel size a preset gives a project. A preset's own width and height are a target frame: the project is fitted
 * inside it keeping its aspect (so a 9:16 preset on a 16:9 project does not stretch). Sizes are made even for H.264.
 */
export function fitSize(preset: Pick<DeliverPreset, "width" | "height">, project: { w: number; h: number }): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const { width, height } = preset;
  if (!width && !height) return { w: even(project.w), h: even(project.h) };
  const aspect = project.w / project.h;
  if (width && !height) return { w: even(width), h: even(width / aspect) };
  if (!width && height) return { w: even(height * aspect), h: even(height) };
  // both set: use the preset's frame when the aspects already agree, otherwise fit inside it
  const s = Math.min(width / project.w, height / project.h);
  if (Math.abs(width / height - aspect) < 0.01) return { w: even(width), h: even(height) };
  return { w: even(project.w * s), h: even(project.h * s) };
}

export const fpsFor = (preset: Pick<DeliverPreset, "fps">, projectFps: number) => (preset.fps > 0 ? preset.fps : projectFps);

/* ---------- filename pattern ---------- */

export type NameCtx = { project: string; timeline?: string; preset: string; date?: Date; n?: number; w?: number; h?: number; fps?: number };

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim() || "untitled";
const two = (n: number) => String(n).padStart(2, "0");

/** Fill a filename pattern. Unknown tokens are left alone so a typo is visible; the result is safe on every file system. */
export function fileName(pattern: string, ctx: NameCtx, container: Container): string {
  const d = ctx.date ?? new Date();
  const vals: Record<string, string> = {
    project: ctx.project,
    timeline: ctx.timeline ?? ctx.project,
    preset: ctx.preset,
    date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    time: `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`,
    n: String(ctx.n ?? 1).padStart(2, "0"),
    w: String(ctx.w ?? ""),
    h: String(ctx.h ?? ""),
    fps: String(ctx.fps ?? ""),
  };
  const stem = safe((pattern.trim() || "{project}").replace(/\{(\w+)\}/g, (m, k: string) => (k in vals ? vals[k] : m)));
  return `${stem}.${CONTAINER_EXT[container]}`;
}

/* ---------- validation, save and import ---------- */

const VIDEO: VideoCodecId[] = ["avc", "hevc", "vp9", "av1"];
const AUDIO: AudioCodecId[] = ["aac", "opus", "flac", "wav"];
const CONTAINERS = Object.keys(CONTAINER_EXT) as Container[];
const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Which audio codecs a container can hold, first is the default. */
export function audioCodecsFor(c: Container): AudioCodecId[] {
  switch (c) {
    case "mp4":
      return ["aac", "flac", "opus"];
    case "webm":
      return ["opus"];
    case "wav":
      return ["wav"];
    case "flac":
      return ["flac"];
    case "ogg":
      return ["opus"];
    default:
      return [];
  }
}

/** Which video codecs a container can hold. */
export function videoCodecsFor(c: Container): VideoCodecId[] {
  if (c === "mp4") return ["avc", "hevc", "vp9", "av1"];
  if (c === "webm") return ["vp9", "av1"];
  return [];
}

/** Make any parsed value into a valid preset, or null when it is not one. Fixes codec and container mismatches. */
export function sanitizePreset(raw: unknown, idHint?: string): DeliverPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  const container = CONTAINERS.includes(r.container as Container) ? (r.container as Container) : "mp4";
  let video = VIDEO.includes(r.video as VideoCodecId) ? (r.video as VideoCodecId) : "avc";
  let audio = AUDIO.includes(r.audio as AudioCodecId) ? (r.audio as AudioCodecId) : "aac";
  const vOk = videoCodecsFor(container);
  if (vOk.length && !vOk.includes(video)) video = vOk[0];
  const aOk = audioCodecsFor(container);
  if (aOk.length && !aOk.includes(audio)) audio = aOk[0];
  return {
    id: typeof r.id === "string" && r.id ? r.id : idHint ?? `custom-${Date.now().toString(36)}`,
    name: r.name.trim().slice(0, 60),
    container,
    video,
    audio,
    rateMode: r.rateMode === "quality" ? "quality" : "bitrate",
    quality: (["low", "medium", "high", "very-high"] as const).includes(r.quality as QualityLevel) ? (r.quality as QualityLevel) : "high",
    bitrateMbps: num(r.bitrateMbps, 12, 0.1, 400),
    keyframeSeconds: num(r.keyframeSeconds, 2, 0.1, 30),
    width: Math.round(num(r.width, 0, 0, 16384)),
    height: Math.round(num(r.height, 0, 0, 16384)),
    fps: num(r.fps, 0, 0, 240),
    audioKbps: Math.round(num(r.audioKbps, 192, 32, 512)),
    pattern: typeof r.pattern === "string" ? r.pattern.slice(0, 120) : "{project}-{preset}",
  };
}

export const presetsToJson = (list: DeliverPreset[]) =>
  JSON.stringify({ cutirPresets: 1, presets: list.map(({ builtin: _b, ...p }) => p) }, null, 2);

/** Presets from a file: accepts the export format, a bare array or one preset. Imported presets always get fresh ids. */
export function presetsFromJson(text: string, taken: Set<string>): { presets: DeliverPreset[]; skipped: number } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { presets: [], skipped: 1 };
  }
  const arr = Array.isArray(j) ? j : Array.isArray((j as { presets?: unknown })?.presets) ? (j as { presets: unknown[] }).presets : [j];
  const out: DeliverPreset[] = [];
  let skipped = 0;
  const used = new Set(taken);
  for (const item of arr) {
    const p = sanitizePreset(item, undefined);
    if (!p) {
      skipped++;
      continue;
    }
    let id = `custom-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset"}`;
    for (let i = 2; used.has(id); i++) id = `${id.replace(/-\d+$/, "")}-${i}`;
    used.add(id);
    out.push({ ...p, id });
  }
  return { presets: out, skipped };
}

/* ---------- rate ---------- */

/** A rough size estimate in bytes, to warn before a long render. */
export function estimateBytes(p: DeliverPreset, seconds: number): number {
  if (p.container === "wav") return Math.round(seconds * 48000 * 2 * 2);
  if (p.container === "flac") return Math.round(seconds * 48000 * 2 * 2 * 0.6);
  if (p.container === "ogg") return Math.round((seconds * p.audioKbps * 1000) / 8);
  if (isStillOut(p.container)) return 0;
  const rate = p.rateMode === "bitrate" ? p.bitrateMbps : { low: 3, medium: 6, high: 12, "very-high": 25 }[p.quality];
  return Math.round(((rate * 1e6 + p.audioKbps * 1000) * seconds) / 8);
}
