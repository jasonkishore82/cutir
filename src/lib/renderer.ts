import {
  EASINGS, EFFECTS, IDENTITY, LOOPS, TRANSITIONS, beatFxAt, combineFx, energyAt, energyClock, energyFactor, presenceIn, presenceOut,
  scaleLoop, toFx, unitPresence, type Fx, type Info,
} from "./animations";
import { evalKeyframes } from "./keyframes";
import {
  DEFAULT_EMPHASIS, effectiveStyle, lineWords, linesOfLayer, mergeStyle, resolveStyle,
  type Aspect, type LyricLine, type Project, type TextStyle, type TransitionType,
} from "../store/project";

/**
 * Single draw function shared by the live preview and the exporter.
 * It is deterministic: the same (project, time, size, assets) always yields the same pixels.
 */

export type MediaSource = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

export type RenderAssets = {
  /** Decoded background image/video frame source. Caller is responsible for seeking videos. */
  bg?: MediaSource;
};

export const ASPECT_SIZES: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

export const ASPECT_RATIO: Record<Aspect, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 };

const REF = 1080; // font sizes and offsets are authored against a 1080px short side

/* ---------- Background ---------- */

let noiseCanvas: HTMLCanvasElement | null = null;

/** Soft cloud blobs + fine grain, tileable. Generated once with a seeded PRNG so it is stable across frames. */
function getNoise(): HTMLCanvasElement {
  if (noiseCanvas) return noiseCanvas;
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#808080";
  g.fillRect(0, 0, S, S);

  let seed = 1234567;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

  for (let i = 0; i < 45; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 50 + rnd() * 150;
    const light = rnd() > 0.5;
    const a = 0.1 + rnd() * 0.15;
    for (const dx of [-S, 0, S]) {
      for (const dy of [-S, 0, S]) {
        const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        const col = light ? "255,255,255" : "0,0,0";
        grad.addColorStop(0, `rgba(${col},${a})`);
        grad.addColorStop(1, `rgba(${col},0)`);
        g.fillStyle = grad;
        g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
  }

  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return (noiseCanvas = c);
}

function mediaSize(m: MediaSource): { w: number; h: number } {
  if (m instanceof HTMLVideoElement) return { w: m.videoWidth, h: m.videoHeight };
  if (m instanceof HTMLImageElement) return { w: m.naturalWidth, h: m.naturalHeight };
  return { w: m.width, h: m.height };
}

function drawBackground(ctx: CanvasRenderingContext2D, p: Project, w: number, h: number, assets: RenderAssets) {
  const bg = p.background;

  if (bg.type === "asset" && assets.bg) {
    const { w: mw, h: mh } = mediaSize(assets.bg);
    if (mw > 0 && mh > 0) {
      // object-fit: cover
      const k = Math.max(w / mw, h / mh);
      const dw = mw * k;
      const dh = mh * k;
      ctx.drawImage(assets.bg, (w - dw) / 2, (h - dh) / 2, dw, dh);
      return;
    }
  }

  const colors = bg.type === "gradient" && bg.colors.length ? bg.colors : ["#1e2a6b", "#5b3a8c", "#d4687a", "#f0a070"];
  const angle = bg.type === "gradient" ? bg.angle : 135;
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2;
  const cy = h / 2;
  const grad = ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  colors.forEach((c, i) => grad.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (bg.type === "gradient" && bg.noise) {
    const pattern = ctx.createPattern(getNoise(), "repeat");
    if (pattern) {
      pattern.setTransform(new DOMMatrix().scale(Math.min(w, h) / 540));
      ctx.save();
      ctx.globalCompositeOperation = "soft-light";
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }
}

/* ---------- Text layout ---------- */

/** Wrap on word boundaries into at most 2 balanced lines. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const joined = words.join(" ");
  if (joined.length <= maxChars || words.length === 1) return [joined];

  let best = { cost: Infinity, a: joined, b: "" };
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const cost = Math.max(a.length, b.length);
    if (cost < best.cost) best = { cost, a, b };
  }
  return [best.a, best.b];
}

function activeLine(lines: LyricLine[], t: number): LyricLine | undefined {
  let found: LyricLine | undefined;
  for (const l of lines) {
    if (t >= l.start && t < l.end && (!found || l.start >= found.start)) found = l;
  }
  return found;
}

/** A transition in progress on one layer: the outgoing line, the incoming one and the progress 0..1. */
export type Handover = { from: LyricLine; to: LyricLine; p: number; type: Exclude<TransitionType, "none"> };

/**
 * The transition running at time t between two consecutive lines of a layer, if any. The transition window is centred
 * on the gap between the lines, so the outgoing line's tail and the incoming line's head overlap by its length.
 * Lines further apart than the transition length simply cut.
 */
export function handoverAt(project: Project, lines: LyricLine[], t: number): Handover | null {
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    const tr = from.transition ?? project.transition;
    if (!tr || tr.type === "none" || tr.ms <= 0) continue;
    const gap = to.start - from.end;
    let d = tr.ms / 1000;
    if (gap < -1e-6 || gap > d) continue;
    d = Math.min(d, gap + (from.end - from.start), gap + (to.end - to.start)); // never longer than the lines themselves
    const mid = (from.end + to.start) / 2;
    const a = mid - d / 2;
    if (t >= a && t < a + d) return { from, to, p: (t - a) / d, type: tr.type };
  }
  return null;
}

/** Per-word start times for word-highlight: real timings if present, else an even split. */
function wordStarts(line: LyricLine, count: number): number[] {
  if (line.words && line.words.length === count) return line.words.map((w) => w.start);
  const dur = Math.max(0.01, line.end - line.start);
  return Array.from({ length: count }, (_, i) => line.start + (dur * i) / count);
}

/* ---------- Layout shared by drawing, hit-testing and the selection overlay ---------- */

type Layout = {
  style: TextStyle; scale: number; fontPx: number; lineH: number; rows: string[]; blockH: number; textW: number; cx: number; cy: number;
  /** Each word placed on its own (canvas pixels, before animation). Present when the line has word overrides. */
  words?: WordBox[];
};

/* ---------- words as objects (phase 16.5) ---------- */

/** True when any word of the line has its own style, transform, keyframes or emphasis: the line is drawn word by word. */
export function hasWordOverrides(line: LyricLine): boolean {
  const wo = line.wordOverrides;
  if (!wo) return false;
  for (const o of Object.values(wo)) if (o && (o.style || o.transform || o.keyframes?.length || o.emphasis)) return true;
  return false;
}

/** A word's style: the line's resolved style with the word's own style override on top (emphasis not applied). */
export function resolveWordStyle(project: Project, line: LyricLine, index: number, lineStyle: TextStyle = resolveStyle(project, line)): TextStyle {
  const o = line.wordOverrides?.[index]?.style;
  return o ? mergeStyle(lineStyle, o) : lineStyle;
}

/**
 * How a word is drawn: its resolved style with its emphasis level applied (`style.fontSize` already multiplied, the
 * level's colour unless the word sets its own colour), the bolder weight, and the text as shown (uppercased if styled).
 */
export type WordLook = { style: TextStyle; text: string; bold: boolean; level: number };

export function wordLook(project: Project, line: LyricLine, index: number, lineStyle: TextStyle = resolveStyle(project, line)): WordLook {
  const wo = line.wordOverrides?.[index];
  const base = resolveWordStyle(project, line, index, lineStyle);
  const raw = lineWords(line.text)[index] ?? "";
  const level = wo?.emphasis ?? 0;
  const e = level > 0 ? (base.emphasis ?? DEFAULT_EMPHASIS)[level - 1] : undefined;
  const style = e ? { ...base, fontSize: base.fontSize * (e.scale || 1), color: wo?.style?.color ?? e.color ?? base.color } : base;
  return { style, text: base.uppercase ? raw.toUpperCase() : raw, bold: !!e?.bold, level };
}

/**
 * Wrap words into at most 2 balanced rows like `wrapText`, but a word counts `weights[i]` times its length (bigger
 * emphasised words take more room). Returns the number of words on each row. With all weights 1 it matches `wrapText`.
 */
export function wrapWords(words: string[], weights: number[], maxChars: number): number[] {
  const n = words.length;
  if (!n) return [];
  const len = (a: number, b: number) => {
    let s = Math.max(0, b - a - 1);
    for (let i = a; i < b; i++) s += words[i].length * (weights[i] ?? 1);
    return s;
  };
  if (len(0, n) <= maxChars || n === 1) return [n];
  let best = { cost: Infinity, i: 1 };
  for (let i = 1; i < n; i++) {
    const cost = Math.max(len(0, i), len(i, n));
    if (cost < best.cost) best = { cost, i };
  }
  return [best.i, n - best.i];
}

/** One word placed in a block centred on (0, 0): `x` is its left edge, `y` its row's centre, `h` its row's height. */
export type PlacedWord = { row: number; x: number; y: number; w: number; h: number };

/**
 * Place measured words in rows (`rowCounts` words per row, in order). Each row is centred on its real width (words
 * plus `spaceW` gaps); a row is as tall as its biggest word (`fontPx * lineHeight`). Pure, for the renderer and tests.
 */
export function placeWords(
  items: { w: number; fontPx: number }[],
  rowCounts: number[],
  spaceW: number,
  lineHeight: number
): { words: PlacedWord[]; width: number; height: number } {
  const rows: { from: number; to: number; h: number; w: number }[] = [];
  let k = 0;
  for (const c of rowCounts) {
    const part = items.slice(k, k + c);
    rows.push({
      from: k,
      to: k + c,
      h: Math.max(0, ...part.map((it) => it.fontPx * lineHeight)),
      w: part.reduce((sum, it) => sum + it.w, 0) + spaceW * Math.max(0, c - 1),
    });
    k += c;
  }
  const height = rows.reduce((sum, r) => sum + r.h, 0);
  const width = Math.max(0, ...rows.map((r) => r.w));
  const words: PlacedWord[] = [];
  let y = -height / 2;
  rows.forEach((r, ri) => {
    let x = -r.w / 2;
    for (let i = r.from; i < r.to; i++) {
      words.push({ row: ri, x, y: y + r.h / 2, w: items[i].w, h: r.h });
      x += items[i].w + spaceW;
    }
    y += r.h;
  });
  return { words, width, height };
}

/** A word laid out for drawing: placement in canvas pixels (before animation, block centre at the layout's cx, cy). */
type WordBox = PlacedWord & { index: number; text: string; style: TextStyle; bold: boolean; font: string; fontPx: number };

const fontOf = (px: number, family: string, bold = false) => `${bold ? "bold " : ""}${px}px "${family}", sans-serif`;
const setSpacing = (ctx: CanvasRenderingContext2D, px: number) => {
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px`;
};

/** Measure and place every word of a line (relative to the block centre). */
function layoutWordBoxes(ctx: CanvasRenderingContext2D, project: Project, line: LyricLine, style: TextStyle, scale: number) {
  const words = lineWords(line.text);
  if (!words.length) return null;
  const looks = words.map((_, i) => wordLook(project, line, i, style));
  const rowCounts = wrapWords(
    looks.map((l) => l.text),
    looks.map((l) => l.style.fontSize / style.fontSize),
    style.maxCharsPerLine
  );
  ctx.save();
  const items = looks.map((l) => {
    const fontPx = l.style.fontSize * scale;
    ctx.font = fontOf(fontPx, l.style.fontFamily, l.bold);
    setSpacing(ctx, l.style.letterSpacing * scale);
    return { w: ctx.measureText(l.text).width, fontPx };
  });
  ctx.font = fontOf(style.fontSize * scale, style.fontFamily);
  setSpacing(ctx, style.letterSpacing * scale);
  const spaceW = ctx.measureText(" ").width;
  ctx.restore();
  const placed = placeWords(items, rowCounts, spaceW, style.lineHeight);
  const boxes: WordBox[] = placed.words.map((p, i) => ({
    ...p,
    index: i,
    text: looks[i].text,
    style: looks[i].style,
    bold: looks[i].bold,
    fontPx: items[i].fontPx,
    font: fontOf(items[i].fontPx, looks[i].style.fontFamily, looks[i].bold),
  }));
  return { boxes, width: placed.width, height: placed.height };
}

let measureCtx: CanvasRenderingContext2D | null = null;
const getMeasureCtx = () => (measureCtx ??= document.createElement("canvas").getContext("2d")!);

/** Where a line's text block sits and how big it is at canvas size w x h, before animation. */
function layoutLine(
  ctx: CanvasRenderingContext2D,
  project: Project,
  line: LyricLine,
  w: number,
  h: number,
  withWords = hasWordOverrides(line)
): Layout | null {
  const style = effectiveStyle(project, line);
  const scale = Math.min(w, h) / REF;
  const fontPx = style.fontSize * scale;
  const lineH = fontPx * style.lineHeight;
  const raw = style.uppercase ? line.text.toUpperCase() : line.text;
  const rows = wrapText(raw, style.maxCharsPerLine);
  if (!rows.length) return null;

  ctx.save();
  ctx.font = `${fontPx}px "${style.fontFamily}", sans-serif`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${style.letterSpacing * scale}px`;
  let textW = Math.max(...rows.map((r) => ctx.measureText(r).width));
  ctx.restore();

  let blockH = rows.length * lineH;
  const wl = withWords ? layoutWordBoxes(ctx, project, line, style, scale) : null;
  if (wl) {
    textW = wl.width;
    blockH = wl.height;
  }
  const tf = style.transform;
  let cx = w / 2;
  let cy = h / 2;
  if (style.position === "top") cy = h * 0.1 + blockH / 2;
  if (style.position === "bottom") cy = h * 0.9 - blockH / 2;
  if (tf?.x !== undefined) cx = tf.x * w;
  if (tf?.y !== undefined) cy = tf.y * h;
  const words = wl?.boxes.map((b) => ({ ...b, x: b.x + cx, y: b.y + cy }));
  return { style, scale, fontPx, lineH, rows, blockH, textW, cx, cy, words };
}

/** A line's box on the canvas: centre, half sizes (scale applied) and rotation in degrees. */
export type LineBounds = { cx: number; cy: number; halfW: number; halfH: number; rotation: number };

/** Lines showing at time t, one per visible layer, bottom layer first. */
export function activeLinesAt(project: Project, t: number): { line: LyricLine; layerId: string; locked: boolean }[] {
  const out: { line: LyricLine; layerId: string; locked: boolean }[] = [];
  for (const layer of project.layers) {
    if (!layer.visible) continue;
    const line = activeLine(linesOfLayer(project, layer.id), t);
    if (line) out.push({ line, layerId: layer.id, locked: layer.locked });
  }
  return out;
}

/**
 * The rotated box of a line. In/out/loop offsets are ignored so handles stay steady; keyframes are included when a
 * time is given (seconds, absolute), so the box follows keyframed motion.
 */
export function getLineBounds(project: Project, line: LyricLine, w: number, h: number, t?: number): LineBounds | null {
  const L = layoutLine(getMeasureCtx(), project, line, w, h);
  if (!L) return null;
  const tf = L.style.transform ?? { scale: 1, rotation: 0 };
  const k = t === undefined ? undefined : evalKeyframes(line.keyframes, t - line.start);
  const s = tf.scale * (k?.scale ?? 1);
  const padX = L.fontPx * 0.2;
  const padY = L.fontPx * 0.12;
  return {
    cx: L.cx + (k?.x ?? 0) * w,
    cy: L.cy + (k?.y ?? 0) * h,
    halfW: (L.textW / 2 + padX) * s,
    halfH: (L.blockH / 2 + padY) * s,
    rotation: tf.rotation + (k?.rotation ?? 0),
  };
}

/** The top-most unlocked line under a point (canvas pixels) at time t. */
export function hitTestLine(project: Project, t: number, w: number, h: number, px: number, py: number): LyricLine | null {
  const lines = activeLinesAt(project, t);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].locked) continue;
    const b = getLineBounds(project, lines[i].line, w, h, t);
    if (!b) continue;
    const a = (-b.rotation * Math.PI) / 180;
    const dx = px - b.cx;
    const dy = py - b.cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= b.halfW && Math.abs(ly) <= b.halfH) return lines[i].line;
  }
  return null;
}

/* ---------- Main entry ---------- */

/**
 * Draw one frame of the lyric project. `between` draws whatever sits above the background and below the text: the
 * compositor passes the timeline's video and image tracks here (phase 15), so preview and export share this path.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  time: number,
  w: number,
  h: number,
  assets: RenderAssets = {},
  between?: (ctx: CanvasRenderingContext2D) => void
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawBackground(ctx, project, w, h, assets);
  if (between) {
    ctx.save();
    between(ctx);
    ctx.restore();
  }

  // layers are drawn bottom to top; each visible layer shows its own active line, or two during a transition
  for (const layer of project.layers) {
    if (!layer.visible) continue;
    const lines = linesOfLayer(project, layer.id);
    const ho = handoverAt(project, lines, time);
    if (ho) {
      const def = TRANSITIONS[ho.type];
      drawLyric(ctx, project, ho.from, time, w, h, { side: "out", fx: toFx(def.out(ho.p)) });
      drawLyric(ctx, project, ho.to, time, w, h, { side: "in", fx: toFx(def.in(ho.p)) });
      continue;
    }
    const line = activeLine(lines, time);
    if (line) drawLyric(ctx, project, line, time, w, h);
  }
  ctx.restore();
}

/** `trans` replaces the line's own out (or in) slot while a transition hands it over to (or from) its neighbour. */
function drawLyric(ctx: CanvasRenderingContext2D, project: Project, line: LyricLine, t: number, w: number, h: number, trans?: { side: "in" | "out"; fx: Fx }) {
  const L = layoutLine(ctx, project, line, w, h);
  if (!L) return;
  const { style, scale, fontPx, lineH, rows, blockH, cx, cy } = L;
  const tf = style.transform ?? { scale: 1, rotation: 0 };
  const anim = style.animation;

  /* animation: in, out and loop are composed from the effect definitions */
  const dur = Math.max(0.001, line.end - line.start);
  const info: Info = { chars: rows.join("").length, words: rows.reduce((n, r) => n + r.split(" ").length, 0), dur };
  const inDef = EFFECTS[anim.in.name];
  const outDef = EFFECTS[anim.out.name];
  const loopDef = LOOPS[anim.loop.name];
  const tIn = trans?.side === "in";
  const tOut = trans?.side === "out";
  const pIn = tIn ? 1 : presenceIn(anim.in, t - line.start, info);
  const pOut = tOut ? 1 : presenceOut(anim.out, line.end - t, info);

  // word and letter effects act on each unit; every other effect acts on the whole block
  const staggerIn = !tIn && (inDef.mode === "word" || inDef.mode === "letter");
  const staggerOut = !tOut && (outDef.mode === "word" || outDef.mode === "letter");
  const t0 = t - line.start;
  // energy: the song's loudness speeds up and strengthens loops and beat hits (amount 0 = exactly as before)
  const energy = style.energy ?? 0;
  const ef = energy > 0 ? energyFactor(energy, energyAt(project.energy, t)) : 1;
  const loopT = energy > 0 ? energyClock(project.energy, energy, line.start, t) : t0;
  const loop = scaleLoop(loopDef.fx(loopT, anim.loop.speed), ef);
  const letterWise = !!loopDef.letterDy;
  let fx = combineFx(staggerIn ? IDENTITY : toFx(inDef.fx(pIn, "in")), staggerOut ? IDENTITY : toFx(outDef.fx(pOut, "out")));
  fx = combineFx(fx, toFx(loop));
  if (trans) fx = combineFx(fx, trans.fx);
  // beat reaction: a short decaying hit on each beat of the song
  if (anim.beat && anim.beat.name !== "none" && project.beats?.length) fx = combineFx(fx, toFx(beatFxAt(project.beats, anim.beat, t, project.energy, energy)));
  // keyframes ride on top of everything above (same code path for preview and export)
  const kf = evalKeyframes(line.keyframes, t0);
  fx = { ...fx, opacity: fx.opacity * kf.opacity };
  if (fx.opacity <= 0) return;

  const highlight = inDef.mode === "highlight";
  const dim = highlight ? 0.35 : 0; // alpha multiplier for not-yet-revealed text (0 = hidden)
  const reveals = inDef.mode === "reveal" || outDef.mode === "reveal";
  const revealFrac: number | null = reveals ? fx.reveal : null;
  const glow = loop.glow ?? 0;
  const tone: Tone | undefined = fx.flash > 0 || fx.swap > 0 ? { flash: fx.flash, swap: fx.swap, accent: accentOf(style) } : undefined;
  const blockRot = tf.rotation + fx.rotation + kf.rotation;
  const blockScale = fx.scale * tf.scale * kf.scale;

  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, fx.opacity));
  ctx.translate(cx + fx.dx * h + kf.x * w, cy + fx.dy * h + kf.y * h);
  ctx.rotate((blockRot * Math.PI) / 180);
  ctx.scale(blockScale, blockScale);
  ctx.translate(-cx, -cy);
  if (fx.blur > 0.05 && "filter" in ctx) (ctx as CanvasRenderingContext2D).filter = `blur(${fx.blur * scale}px)`;

  ctx.font = `${fontPx}px "${style.fontFamily}", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${style.letterSpacing * scale}px`;

  /* words as objects: each word with its own style, emphasis, transform, keyframes and slots */
  if (L.words) {
    drawWords(ctx, {
      project, line, L, t, t0, w, h, info, pIn, pOut, staggerIn, staggerOut, tIn, tOut, loopT, ef, revealFrac, highlight, dim, glow,
      tone, blockRot, blockScale,
    });
    ctx.restore();
    return;
  }

  /* per-word and per-letter drawing */
  if (staggerIn || staggerOut || letterWise) {
    type Unit = { text: string; row: number; start: number };
    const mode = staggerIn ? inDef.mode : staggerOut ? outDef.mode : "letter";
    const units: Unit[] = [];
    rows.forEach((row, ri) => {
      if (mode === "word") {
        let pos = 0;
        for (const word of row.split(" ")) {
          if (word) units.push({ text: word, row: ri, start: pos });
          pos += word.length + 1;
        }
      } else {
        [...row].forEach((ch, i) => ch !== " " && units.push({ text: ch, row: ri, start: i }));
      }
    });
    const n = units.length;
    const revealCount = revealFrac === null ? Infinity : Math.floor(revealFrac * info.chars + 1e-6);
    let before = 0;
    let lastRow = -1;
    units.forEach((u, i) => {
      if (u.row !== lastRow) {
        lastRow = u.row;
        before = rows.slice(0, u.row).join("").length;
      }
      if (before + u.start >= revealCount) return;
      let ufx = IDENTITY;
      if (staggerIn) ufx = combineFx(ufx, toFx(inDef.fx(unitPresence(pIn, i, n, inDef.spread ?? 0.7), "in")));
      if (staggerOut) ufx = combineFx(ufx, toFx(outDef.fx(unitPresence(pOut, i, n, outDef.spread ?? 0.7), "out")));
      const ldy = loopDef.letterDy ? loopDef.letterDy(loopT, anim.loop.speed, i) * ef : 0;
      if (ufx.opacity <= 0) return;

      const row = rows[u.row];
      const y = cy - blockH / 2 + lineH * (u.row + 0.5);
      const x0 = cx - ctx.measureText(row).width / 2;
      const ux = x0 + ctx.measureText(row.slice(0, u.start)).width;
      const uw = ctx.measureText(u.text).width;
      ctx.save();
      ctx.globalAlpha *= Math.min(1, Math.max(0, ufx.opacity));
      ctx.translate(ux + uw / 2 + ufx.dx * h, y + (ufx.dy + ldy) * h);
      ctx.rotate((ufx.rotation * Math.PI) / 180);
      ctx.scale(ufx.scale, ufx.scale);
      ctx.translate(-(ux + uw / 2), -y);
      paintText(ctx, u.text, ux, y, style, scale, 1, glow, tone);
      ctx.restore();
    });
    ctx.restore();
    return;
  }

  /* reveal counts per row */
  const wordsByRow = rows.map((r) => r.split(" "));
  const totalWords = wordsByRow.reduce((n, ws) => n + ws.length, 0);
  const starts = highlight ? wordStarts(line, totalWords) : [];
  let charsLeft = revealFrac === null ? Infinity : Math.floor(revealFrac * rows.join("").length + 1e-6);

  /* karaoke: each word drawn on its own, sung words tinted, the word being sung scaled up */
  const hl = style.highlight;
  if (highlight && revealFrac === null && (hl?.tint || (hl?.activeScale ?? 1) !== 1)) {
    let wi = 0;
    rows.forEach((row, ri) => {
      const y = cy - blockH / 2 + lineH * (ri + 0.5);
      const x0 = cx - ctx.measureText(row).width / 2;
      let pos = 0;
      for (const word of wordsByRow[ri]) {
        const start = starts[wi];
        const next = wi + 1 < starts.length ? starts[wi + 1] : line.end;
        wi++;
        const x = x0 + ctx.measureText(row.slice(0, pos)).width;
        pos += word.length + 1;
        if (!word) continue;
        const sung = t >= start;
        const look = sung && hl.tint ? { ...style, color: hl.color } : style;
        const active = sung && t < next;
        // the active word pops up quickly, then settles back as the next word starts
        const grow = active ? 1 + (hl.activeScale - 1) * EASINGS["ease-out"](Math.min(1, (t - start) / 0.12)) : 1;
        const ww = ctx.measureText(word).width;
        ctx.save();
        if (grow !== 1) {
          ctx.translate(x + ww / 2, y);
          ctx.scale(grow, grow);
          ctx.translate(-(x + ww / 2), -y);
        }
        paintText(ctx, word, x, y, look, scale, sung ? 1 : dim, glow, tone);
        ctx.restore();
      }
    });
    ctx.restore();
    return;
  }

  let wordIdx = 0;
  rows.forEach((row, ri) => {
    const y = cy - blockH / 2 + lineH * (ri + 0.5);
    const fullW = ctx.measureText(row).width;
    const x0 = cx - fullW / 2;

    let reveal = row.length;
    if (revealFrac !== null) {
      reveal = Math.min(row.length, charsLeft);
      charsLeft = Math.max(0, charsLeft - row.length);
    } else if (highlight) {
      reveal = 0;
      let pos = 0;
      wordsByRow[ri].forEach((word) => {
        pos += word.length;
        if (t >= starts[wordIdx]) reveal = pos;
        pos += 1; // space
        wordIdx++;
      });
      reveal = Math.min(reveal, row.length);
    }

    const shown = row.slice(0, reveal);
    if (shown) paintText(ctx, shown, x0, y, style, scale, 1, glow, tone);
    if (dim > 0 && reveal < row.length) {
      const rest = row.slice(reveal);
      paintText(ctx, rest, x0 + ctx.measureText(shown).width, y, style, scale, dim, glow, tone);
    }
  });

  ctx.restore();
}

/** Beat colour terms for paintText: `flash` brightens toward white with a halo, `swap` mixes the fill toward `accent`. */
type Tone = { flash: number; swap: number; accent: string };

/** The colour a colour-swap beat turns text into: the karaoke highlight colour, else emphasis level 3's colour. */
const accentOf = (s: TextStyle) => s.highlight?.color ?? s.emphasis?.[2]?.color ?? "#ffd84a";

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim());
  if (!m) return null;
  let x = m[1];
  if (x.length === 3) x = x.split("").map((ch) => ch + ch).join("");
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}

/** Mix two colours (hex) by k (0 = a, 1 = b). Colours that are not hex switch over at k = 0.5. */
export function mixColor(a: string, b: string, k: number): string {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const A = parseHex(a);
  const B = parseHex(b);
  if (!A || !B) return k < 0.5 ? a : b;
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function paintText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, s: TextStyle, scale: number, mul: number, glow = 0, tone?: Tone) {
  ctx.save();
  ctx.globalAlpha *= mul;
  const sh = s.shadow;
  if (sh.opacity > 0 && (sh.blur > 0 || sh.offsetX || sh.offsetY)) {
    ctx.shadowColor = `rgba(0,0,0,${sh.opacity})`;
    ctx.shadowBlur = sh.blur * scale;
    ctx.shadowOffsetX = sh.offsetX * scale;
    ctx.shadowOffsetY = sh.offsetY * scale;
  }
  if (s.outline.width > 0) {
    ctx.strokeStyle = s.outline.color;
    ctx.lineWidth = s.outline.width * scale * 2; // stroke is centred; x2 so width reads as visible outline
    ctx.strokeText(text, x, y);
    ctx.shadowColor = "transparent"; // avoid double shadow under the fill
  }
  let fill = s.color;
  const flash = tone?.flash ?? 0;
  if (tone && tone.swap > 0) fill = mixColor(fill, tone.accent, tone.swap);
  if (flash > 0) fill = mixColor(fill, "#ffffff", flash * 0.85);
  if (glow > 0 && glow >= flash) {
    // a soft halo in the text colour, brightest at glow = 1
    ctx.shadowColor = fill;
    ctx.shadowBlur = (sh.blur + 36 * glow) * scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  } else if (flash > 0) {
    // a beat flash: a white halo that fades with the hit
    ctx.shadowColor = `rgba(255,255,255,${Math.min(1, 0.4 + 0.6 * flash)})`;
    ctx.shadowBlur = (sh.blur + 44 * flash) * scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/* ---------- drawing a line word by word (phase 16.5) ---------- */

type WordsArgs = {
  project: Project; line: LyricLine; L: Layout; t: number; t0: number; w: number; h: number; info: Info;
  pIn: number; pOut: number; staggerIn: boolean; staggerOut: boolean; tIn: boolean; tOut: boolean;
  loopT: number; ef: number; revealFrac: number | null; highlight: boolean; dim: number; glow: number; tone?: Tone;
  blockRot: number; blockScale: number;
};

/**
 * Draws a line with word overrides, one word at a time, inside the line's block transform (already on `ctx`).
 * Per word: the line's word or letter stagger (unless the word has its own in/out slot), the word's own in/out/beat
 * slots, its keyframes and transform (x, y are canvas offsets, so a word moves with the mouse whatever the line's
 * rotation), karaoke sung/active state, the typewriter reveal and letter loops.
 */
function drawWords(ctx: CanvasRenderingContext2D, a: WordsArgs) {
  const { project, line, L, t, t0, w, h, info } = a;
  const words = L.words!;
  const style = L.style;
  const anim = style.animation;
  const inDef = EFFECTS[anim.in.name];
  const outDef = EFFECTS[anim.out.name];
  const loopDef = LOOPS[anim.loop.name];
  const letterIn = a.staggerIn && inDef.mode === "letter";
  const letterOut = a.staggerOut && outDef.mode === "letter";
  const wordIn = a.staggerIn && inDef.mode === "word";
  const wordOut = a.staggerOut && outDef.mode === "word";
  const letterWise = letterIn || letterOut || !!loopDef.letterDy;
  const nW = words.length;
  const nLetters = words.reduce((n, b) => n + b.text.length, 0);
  const revealCount = a.revealFrac === null ? Infinity : Math.floor(a.revealFrac * info.chars + 1e-6);
  const starts = a.highlight ? wordStarts(line, nW) : [];
  const hl = style.highlight;
  const rad = (-a.blockRot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const S = Math.abs(a.blockScale) > 1e-6 ? a.blockScale : 1e-6;

  let charOff = 0; // characters before this word, counted like the typewriter does (spaces inside a row count)
  let letterBase = 0;
  let lastRow = 0;
  words.forEach((b, i) => {
    if (b.row !== lastRow) {
      lastRow = b.row;
      charOff = Math.max(0, charOff - 1); // no space across a row break
    }
    const myOff = charOff;
    const myLetters = letterBase;
    charOff += b.text.length + 1;
    letterBase += b.text.length;

    const wo = line.wordOverrides?.[i];
    const own = wo?.style?.animation;
    const ws = b.style;
    let ufx = IDENTITY;
    if (own?.in && !a.tIn) ufx = combineFx(ufx, toFx(EFFECTS[ws.animation.in.name].fx(presenceIn(ws.animation.in, t0, info), "in")));
    else if (wordIn) ufx = combineFx(ufx, toFx(inDef.fx(unitPresence(a.pIn, i, nW, inDef.spread ?? 0.7), "in")));
    if (own?.out && !a.tOut) ufx = combineFx(ufx, toFx(EFFECTS[ws.animation.out.name].fx(presenceOut(ws.animation.out, line.end - t, info), "out")));
    else if (wordOut) ufx = combineFx(ufx, toFx(outDef.fx(unitPresence(a.pOut, i, nW, outDef.spread ?? 0.7), "out")));
    if (own?.beat && project.beats?.length) ufx = combineFx(ufx, toFx(beatFxAt(project.beats, ws.animation.beat, t, project.energy, ws.energy ?? 0)));
    const wk = evalKeyframes(wo?.keyframes, t0);
    const opacity = ufx.opacity * wk.opacity;
    if (opacity <= 0) return;

    // typewriter: only the characters revealed so far; a word's own reveal slot reveals within the word
    let text = b.text;
    if (myOff >= revealCount) return;
    if (revealCount - myOff < text.length) text = text.slice(0, revealCount - myOff);
    if (ufx.reveal < 1) text = text.slice(0, Math.floor(ufx.reveal * b.text.length + 1e-6));
    if (!text) return;

    // karaoke: sung words lit (and tinted), the word being sung grows
    let look = ws;
    let mul = 1;
    let grow = 1;
    if (a.highlight) {
      const start = starts[i];
      const next = i + 1 < starts.length ? starts[i + 1] : line.end;
      const sung = t >= start;
      if (!sung) mul = a.dim;
      if (sung && hl?.tint) look = { ...ws, color: hl.color };
      if (sung && t < next && hl) grow = 1 + (hl.activeScale - 1) * EASINGS["ease-out"](Math.min(1, (t - start) / 0.12));
    }
    if (mul <= 0) return;

    // canvas-space offsets (word transform and keyframes) brought into the block's rotated, scaled space
    const wt = wo?.transform;
    const ox = ((wt?.x ?? 0) + wk.x) * w;
    const oy = ((wt?.y ?? 0) + wk.y) * h;
    const lx = (ox * cos - oy * sin) / S;
    const ly = (ox * sin + oy * cos) / S;
    const flash = Math.max(a.tone?.flash ?? 0, ufx.flash);
    const swap = Math.max(a.tone?.swap ?? 0, ufx.swap);
    const tone: Tone | undefined = flash > 0 || swap > 0 ? { flash, swap, accent: accentOf(ws) } : undefined;

    ctx.save();
    ctx.globalAlpha *= Math.min(1, Math.max(0, opacity));
    ctx.translate(b.x + b.w / 2 + lx + ufx.dx * h, b.y + ly + ufx.dy * h);
    ctx.rotate((((wt?.rotation ?? 0) + wk.rotation + ufx.rotation) * Math.PI) / 180);
    const k = (wt?.scale ?? 1) * wk.scale * ufx.scale * grow;
    ctx.scale(k, k);
    ctx.font = b.font;
    setSpacing(ctx, ws.letterSpacing * L.scale);
    const left = -b.w / 2;
    if (!letterWise) {
      paintText(ctx, text, left, 0, look, L.scale, mul, a.glow, tone);
    } else {
      [...text].forEach((ch, ci) => {
        const li = myLetters + ci;
        let lfx = IDENTITY;
        if (letterIn && !own?.in) lfx = combineFx(lfx, toFx(inDef.fx(unitPresence(a.pIn, li, nLetters, inDef.spread ?? 0.7), "in")));
        if (letterOut && !own?.out) lfx = combineFx(lfx, toFx(outDef.fx(unitPresence(a.pOut, li, nLetters, outDef.spread ?? 0.7), "out")));
        if (lfx.opacity <= 0) return;
        const ldy = loopDef.letterDy ? loopDef.letterDy(a.loopT, anim.loop.speed, li) * a.ef : 0;
        const x = left + ctx.measureText(text.slice(0, ci)).width;
        const cw = ctx.measureText(ch).width;
        ctx.save();
        ctx.globalAlpha *= Math.min(1, Math.max(0, lfx.opacity));
        ctx.translate(x + cw / 2 + lfx.dx * h, (lfx.dy + ldy) * h);
        ctx.rotate((lfx.rotation * Math.PI) / 180);
        ctx.scale(lfx.scale, lfx.scale);
        ctx.translate(-(x + cw / 2), 0);
        paintText(ctx, ch, x, 0, look, L.scale, mul, a.glow, tone);
        ctx.restore();
      });
    }
    ctx.restore();
  });
}

/* ---------- words (phase 16.5) ---------- */

/** The box of one word of a line, in canvas pixels, rotated by `rotation` degrees about its centre. */
export type WordBounds = LineBounds & { index: number; text: string };

/**
 * Boxes of every word of a line at time t (absolute seconds), in the order of `lineWords(line.text)`, including the
 * word's emphasis, own transform and keyframes, and the line's transform and keyframes. Like getLineBounds, in/out,
 * loop and beat motion is ignored so the boxes stay steady. Used by the preview overlay to pick and move words.
 */
export function getWordBounds(project: Project, line: LyricLine, w: number, h: number, t?: number): WordBounds[] {
  const L = layoutLine(getMeasureCtx(), project, line, w, h, true);
  if (!L?.words) return [];
  const tf = L.style.transform ?? { scale: 1, rotation: 0 };
  const k = t === undefined ? undefined : evalKeyframes(line.keyframes, t - line.start);
  const rot = tf.rotation + (k?.rotation ?? 0);
  const s = tf.scale * (k?.scale ?? 1);
  const ox = L.cx + (k?.x ?? 0) * w;
  const oy = L.cy + (k?.y ?? 0) * h;
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return L.words.map((b) => {
    const wo = line.wordOverrides?.[b.index];
    const wk = t === undefined ? undefined : evalKeyframes(wo?.keyframes, t - line.start);
    const wt = wo?.transform;
    const rx = (b.x + b.w / 2 - L.cx) * s;
    const ry = (b.y - L.cy) * s;
    const ws = s * (wt?.scale ?? 1) * (wk?.scale ?? 1);
    return {
      index: b.index,
      text: b.text,
      cx: ox + rx * cos - ry * sin + ((wt?.x ?? 0) + (wk?.x ?? 0)) * w,
      cy: oy + rx * sin + ry * cos + ((wt?.y ?? 0) + (wk?.y ?? 0)) * h,
      halfW: (b.w / 2 + b.fontPx * 0.08) * Math.abs(ws),
      halfH: b.fontPx * 0.6 * Math.abs(ws),
      rotation: rot + (wt?.rotation ?? 0) + (wk?.rotation ?? 0),
    };
  });
}

/** The word under a point (canvas pixels) of a given line at time t, or null. */
export function hitTestWord(project: Project, line: LyricLine, t: number, w: number, h: number, px: number, py: number): WordBounds | null {
  for (const b of getWordBounds(project, line, w, h, t)) {
    const a = (-b.rotation * Math.PI) / 180;
    const dx = px - b.cx;
    const dy = py - b.cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= b.halfW && Math.abs(ly) <= b.halfH) return b;
  }
  return null;
}
