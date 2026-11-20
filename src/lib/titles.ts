import type { TextRun, TitleAnimator, TitleSpec } from "../model/types";

/**
 * Titles (phase 19): a text box with rich runs, fills, strokes, shadow, glow and After Effects style per-character
 * animators. `layoutTitle` is pure (it takes a `measure` function), so it is tested without a canvas; `drawTitle`
 * paints the layout with the animator applied.
 *
 * Kerning: letters are positioned from the measured width of the text before them (not letter by letter), so the
 * font's kerning pairs survive. Right-to-left: Arabic and Hebrew words are kept whole (a shaped word cannot be split
 * into letters), words run right to left on those lines, and the animator always works by word on them.
 */

export const DEFAULT_ANIMATOR: TitleAnimator = { preset: "none", unit: "char", duration: 1.2, rangeStart: 0, rangeEnd: 100, offset: 0, outDuration: 0 };

export const DEFAULT_TITLE: TitleSpec = {
  text: "Your title",
  font: "Inter",
  weight: 700,
  italic: false,
  underline: false,
  size: 0.09,
  color: "#ffffff",
  color2: "#ffd84a",
  gradient: false,
  gradientAngle: 90,
  align: "center",
  lineHeight: 1.15,
  letterSpacing: 0,
  x: 0.5,
  y: 0.5,
  width: 0.8,
  autoFit: true,
  stroke: "#000000",
  strokeWidth: 0,
  shadow: false,
  shadowColor: "#000000",
  shadowBlur: 0.012,
  glow: 0,
  glowColor: "#ffffff",
  bevel: false,
  box: null,
  runs: [],
  animator: DEFAULT_ANIMATOR,
  roll: 0,
  fallback: ["sans-serif"],
};

export const titleOf = (over: Partial<TitleSpec> = {}): TitleSpec => ({ ...structuredClone(DEFAULT_TITLE), ...over });

/* ---------- text pieces ---------- */

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿]/;
export const isRtlText = (s: string) => {
  for (const ch of s) {
    if (RTL_CHAR.test(ch)) return true;
    if (LTR_CHAR.test(ch)) return false;
  }
  return false;
};

/** Split into user-perceived letters (a flag or an accented letter stays one piece). */
export function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
  return Seg ? [...new Seg(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment) : Array.from(s);
}

export type Measure = (text: string, font: string) => number;

export type Glyph = {
  /** The letter, or the whole word for right-to-left words. */
  ch: string;
  x: number;
  /** Baseline, relative to the box centre. */
  y: number;
  w: number;
  font: string;
  px: number;
  run?: TextRun;
  line: number;
  word: number;
  /** Counted in letters of the text, spaces included. */
  index: number;
  rtl: boolean;
};

export type TitleLayout = { glyphs: Glyph[]; lines: { y: number; x0: number; x1: number; px: number }[]; width: number; height: number; scale: number; rtl: boolean };

const fontString = (spec: TitleSpec, px: number, run?: TextRun) =>
  `${(run?.italic ?? spec.italic) ? "italic " : ""}${run?.weight ?? spec.weight} ${Math.max(1, px).toFixed(2)}px ${[run?.font ?? spec.font, ...spec.fallback].map((f) => (/\s/.test(f) && !/^["']/.test(f) ? `"${f}"` : f)).join(", ")}`;

type Piece = { ch: string; index: number; run?: TextRun };

function runAt(spec: TitleSpec, index: number): TextRun | undefined {
  let found: TextRun | undefined;
  for (const r of spec.runs) if (index >= r.start && index < r.end) found = { ...found, ...r };
  return found;
}

/** Lay the text out inside the box. Coordinates are in pixels with the origin at the box centre. */
export function layoutTitle(measure: Measure, spec: TitleSpec, W: number, H: number): TitleLayout {
  let scale = 1;
  let result: TitleLayout | null = null;
  for (let iter = 0; iter < 8; iter++) {
    result = layoutOnce(measure, spec, W, H, scale);
    if (!spec.autoFit || spec.roll > 0) break;
    const maxH = H * 0.92;
    const boxW = spec.width * W;
    if (result.height <= maxH && result.width <= boxW * 1.001) break;
    scale *= Math.min(maxH / result.height, boxW / Math.max(1, result.width)) * 0.98;
  }
  return result!;
}

function layoutOnce(measure: Measure, spec: TitleSpec, W: number, H: number, scale: number): TitleLayout {
  const boxW = spec.width * W;
  const basePx = spec.size * H * scale;
  const pieces: Piece[] = [];
  let n = 0;
  for (const ch of graphemes(spec.text)) pieces.push({ ch, index: n++, run: ch === "\n" ? undefined : runAt(spec, n - 1) });

  // paragraphs -> words
  const paragraphs: Piece[][] = [[]];
  for (const p of pieces) (p.ch === "\n" ? paragraphs.push([]) : paragraphs[paragraphs.length - 1].push(p));

  type Word = { pieces: Piece[]; rtl: boolean; w: number; xs: number[]; px: number; space: number };
  const px = (run?: TextRun) => (run?.size ? run.size * H * scale : basePx);
  const ls = (p: number) => spec.letterSpacing * p;

  const makeWord = (ps: Piece[]): Word => {
    const word = ps.map((p) => p.ch).join("");
    const rtl = RTL_CHAR.test(word);
    const sizeMax = Math.max(...ps.map((p) => px(p.run)));
    const xs: number[] = [0];
    let w = 0;
    if (rtl) {
      w = measure(word, fontString(spec, px(ps[0].run), ps[0].run));
      return { pieces: ps, rtl, w, xs: [0], px: sizeMax, space: 0 };
    }
    // segments of equal style: positions come from the width of the text before each letter (keeps kerning)
    let i = 0;
    let base = 0;
    while (i < ps.length) {
      let j = i + 1;
      const key = (p: Piece) => `${px(p.run)}|${p.run?.weight}|${p.run?.italic}|${p.run?.font}`;
      while (j < ps.length && key(ps[j]) === key(ps[i])) j++;
      const f = fontString(spec, px(ps[i].run), ps[i].run);
      for (let k = i; k < j; k++) xs[k] = base + measure(ps.slice(i, k).map((p) => p.ch).join(""), f) + ls(px(ps[k].run)) * k;
      base += measure(ps.slice(i, j).map((p) => p.ch).join(""), f) + ls(px(ps[i].run)) * (j - i);
      i = j;
    }
    w = base;
    xs.length = ps.length;
    return { pieces: ps, rtl, w, xs, px: sizeMax, space: 0 };
  };

  type Line = { words: Word[]; rtl: boolean; w: number; px: number };
  const lines: Line[] = [];
  for (const para of paragraphs) {
    const rtl = isRtlText(para.map((p) => p.ch).join(""));
    const words: Word[] = [];
    let cur: Piece[] = [];
    for (const p of para) {
      if (p.ch === " " || p.ch === "\t") {
        if (cur.length) words.push(makeWord(cur));
        cur = [];
        words.push({ pieces: [p], rtl: false, w: measure(" ", fontString(spec, px(p.run), p.run)) + ls(px(p.run)), xs: [0], px: px(p.run), space: 1 });
      } else cur.push(p);
    }
    if (cur.length) words.push(makeWord(cur));
    // wrap
    let line: Line = { words: [], rtl, w: 0, px: basePx };
    const flush = () => {
      while (line.words.length && line.words[line.words.length - 1].space) line.w -= line.words.pop()!.w;
      lines.push(line);
      line = { words: [], rtl, w: 0, px: basePx };
    };
    for (const wd of words) {
      if (!wd.space && line.words.length && line.w + wd.w > boxW) flush();
      if (wd.space && !line.words.length) continue;
      line.words.push(wd);
      line.w += wd.w;
      line.px = Math.max(line.px, wd.px);
    }
    flush();
  }

  // vertical placement
  const heights = lines.map((l) => Math.max(l.px, basePx * 0.5) * spec.lineHeight);
  const total = heights.reduce((a, b) => a + b, 0);
  const glyphs: Glyph[] = [];
  const outLines: TitleLayout["lines"] = [];
  let top = -total / 2;
  let wordNo = 0;
  let widest = 0;
  lines.forEach((l, li) => {
    const lh = heights[li];
    const baseline = top + lh * 0.5 + l.px * 0.34;
    widest = Math.max(widest, l.w);
    const left = spec.align === "left" ? -boxW / 2 : spec.align === "right" ? boxW / 2 - l.w : -l.w / 2;
    outLines.push({ y: baseline, x0: left, x1: left + l.w, px: l.px });
    // words are numbered in reading order, even when a right to left line is drawn from the right
    const numbers = new Map<Word, number>();
    for (const wd of l.words) if (!wd.space) numbers.set(wd, wordNo++);
    const ordered = l.rtl ? [...l.words].reverse() : l.words;
    let x = left;
    for (const wd of ordered) {
      const no = numbers.get(wd) ?? 0;
      if (!wd.space) {
        if (wd.rtl) {
          const p = wd.pieces[0];
          glyphs.push({ ch: wd.pieces.map((q) => q.ch).join(""), x, y: baseline, w: wd.w, font: fontString(spec, px(p.run), p.run), px: px(p.run), run: p.run, line: li, word: no, index: p.index, rtl: true });
        } else {
          wd.pieces.forEach((p, k) => {
            const nextX = k + 1 < wd.pieces.length ? wd.xs[k + 1] : wd.w;
            glyphs.push({ ch: p.ch, x: x + wd.xs[k], y: baseline, w: Math.max(0, nextX - wd.xs[k] - ls(px(p.run))), font: fontString(spec, px(p.run), p.run), px: px(p.run), run: p.run, line: li, word: no, index: p.index, rtl: false });
          });
        }
      }
      x += wd.w;
    }
    top += lh;
  });
  return { glyphs, lines: outLines, width: widest, height: total, scale, rtl: lines.some((l) => l.rtl) };
}

/** How long a credits roll takes to carry the whole block from below the frame to above it. */
export function rollDuration(spec: TitleSpec, layout: TitleLayout, H: number): number {
  return spec.roll > 0 ? (H * (1 - spec.y) + layout.height / 2 + (spec.y * H + layout.height / 2)) / (spec.roll * H) : 0;
}

/* ---------- animators ---------- */

export type UnitFx = { opacity: number; dx: number; dy: number; scale: number; rotation: number; blur: number; fill: number };
const REST: UnitFx = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0, fill: 0 };

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
};
const backOut = (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);

export const ANIMATOR_PRESETS: { id: TitleAnimator["preset"]; name: string; unit: TitleAnimator["unit"]; duration: number }[] = [
  { id: "none", name: "None", unit: "char", duration: 1 },
  { id: "typewriter", name: "Typewriter", unit: "char", duration: 1.5 },
  { id: "word-pop", name: "Word pop", unit: "word", duration: 1.2 },
  { id: "line-slide", name: "Line slide", unit: "line", duration: 1 },
  { id: "wave", name: "Wave", unit: "char", duration: 2 },
  { id: "blur-in", name: "Blur in", unit: "char", duration: 1.2 },
  { id: "karaoke-fill", name: "Karaoke fill", unit: "word", duration: 2 },
  { id: "roll", name: "Credits roll", unit: "line", duration: 1 },
];

/** The animator's effect on unit `i` of `n` at `t` seconds into the clip. Sizes are in text heights. */
export function unitFx(a: TitleAnimator, i: number, n: number, t: number, clipDur: number): UnitFx {
  const fx = { ...REST };
  if (a.outDuration > 0 && clipDur > 0) fx.opacity *= Math.min(1, Math.max(0, (clipDur - t) / a.outDuration));
  if (a.preset === "none" || a.preset === "roll") return fx;
  const p = Math.min(1, Math.max(0, t / Math.max(0.01, a.duration)));
  // range selector: the part of the text (0..100) the animation sweeps; units outside it stay at rest
  const u = ((i + 0.5) / n) * 100 - a.offset;
  const inRange = u >= a.rangeStart && u <= a.rangeEnd;
  if (a.preset === "wave") {
    const amount = inRange ? 1 : 0;
    fx.dy = Math.sin(t * 5 - i * 0.55) * 0.14 * amount;
    return fx;
  }
  if (!inRange) return fx;
  const span = Math.max(1, a.rangeEnd - a.rangeStart);
  const pos = (u - a.rangeStart) / span; // 0..1 along the selected part
  const feather = a.preset === "typewriter" ? 0.0001 : 0.35;
  const front = p * (1 + feather); // the edge of the sweep; units past it have not arrived yet
  const c = smoothstep(front - feather, front, pos); // 1 = still hidden, 0 = arrived
  const arrive = 1 - c;
  switch (a.preset) {
    case "typewriter":
      fx.opacity *= c > 0.5 ? 0 : 1;
      break;
    case "word-pop":
      fx.opacity *= Math.min(1, arrive * 3);
      fx.scale = 0.35 + 0.65 * backOut(arrive);
      break;
    case "line-slide":
      fx.opacity *= Math.min(1, arrive * 2);
      fx.dy = (1 - arrive) * 0.9;
      break;
    case "blur-in":
      fx.opacity *= Math.min(1, arrive * 2);
      fx.blur = c * 0.35;
      break;
    case "karaoke-fill":
      fx.fill = arrive;
      break;
  }
  return fx;
}

/** Units the animator works on: indices into the glyph list grouped by letter, word or line (right-to-left: by word). */
export function unitsOf(layout: TitleLayout, unit: TitleAnimator["unit"]): number[][] {
  const mode = layout.rtl && unit === "char" ? "word" : unit;
  const groups = new Map<number, number[]>();
  layout.glyphs.forEach((g, i) => {
    const key = mode === "char" ? i : mode === "word" ? g.word : g.line;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

/* ---------- drawing ---------- */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function measurer(ctx: Ctx): Measure {
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

const layouts = new Map<string, TitleLayout>();
function layoutFor(ctx: Ctx, spec: TitleSpec, w: number, h: number): TitleLayout {
  const key = JSON.stringify([spec.text, spec.font, spec.fallback, spec.weight, spec.italic, spec.size, spec.align, spec.lineHeight, spec.letterSpacing, spec.width, spec.autoFit, spec.runs, spec.roll, w, h]);
  let l = layouts.get(key);
  if (!l) {
    if (layouts.size > 24) layouts.clear();
    l = layoutTitle(measurer(ctx), spec, w, h);
    layouts.set(key, l);
  }
  return l;
}

const images = new Map<string, HTMLImageElement | null>();
function fillImage(src: string): HTMLImageElement | null {
  if (images.has(src)) {
    const im = images.get(src);
    return im && im.complete && im.naturalWidth ? im : null;
  }
  if (typeof Image === "undefined") return null;
  const im = new Image();
  im.src = src;
  images.set(src, im);
  return null;
}

/** Draw a title at `t` seconds into its clip. */
export function drawTitle(ctx: Ctx, spec: TitleSpec, t: number, clipDur: number, w: number, h: number) {
  ctx.save();
  const layout = layoutFor(ctx, spec, w, h);
  const cx = spec.x * w;
  let cy = spec.y * h;
  if (spec.roll > 0) cy += h * (1 - spec.y) + layout.height / 2 - spec.roll * h * t;
  ctx.translate(cx, cy);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  if (spec.box && layout.glyphs.length) {
    const pad = spec.box.padding * h;
    const bx = Math.min(...layout.lines.map((l) => l.x0)) - pad;
    const bw = Math.max(...layout.lines.map((l) => l.x1)) - Math.min(...layout.lines.map((l) => l.x0)) + pad * 2;
    const by = -layout.height / 2 - pad;
    const bh = layout.height + pad * 2;
    const r = Math.min(spec.box.radius * h, bw / 2, bh / 2);
    ctx.save();
    ctx.globalAlpha *= spec.box.opacity * unitFx(spec.animator, 0, 1, t, clipDur).opacity;
    ctx.fillStyle = spec.box.color;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
    ctx.arcTo(bx, by + bh, bx, by, r);
    ctx.arcTo(bx, by, bx + bw, by, r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const units = unitsOf(layout, spec.animator.unit);
  const fill = (): string | CanvasGradient | CanvasPattern => {
    if (spec.fillImage) {
      const im = fillImage(spec.fillImage);
      if (im) return ctx.createPattern(im, "repeat") ?? spec.color;
    }
    if (spec.gradient) {
      const a = (spec.gradientAngle * Math.PI) / 180;
      const hw = Math.max(1, layout.width / 2);
      const hh = Math.max(1, layout.height / 2);
      const g = ctx.createLinearGradient(-Math.cos(a) * hw, -Math.sin(a) * hh, Math.cos(a) * hw, Math.sin(a) * hh);
      g.addColorStop(0, spec.color);
      g.addColorStop(1, spec.color2);
      return g;
    }
    return spec.color;
  };
  const baseFill = fill();

  units.forEach((idxs, ui) => {
    const fx = unitFx(spec.animator, ui, units.length, t, clipDur);
    if (fx.opacity <= 0.001) return;
    const gl = idxs.map((i) => layout.glyphs[i]);
    const x0 = Math.min(...gl.map((g) => g.x));
    const x1 = Math.max(...gl.map((g) => g.x + g.w));
    const ucx = (x0 + x1) / 2;
    const ucy = gl[0].y - gl[0].px * 0.34;
    ctx.save();
    ctx.globalAlpha *= fx.opacity;
    ctx.translate(ucx + fx.dx * gl[0].px, ucy + fx.dy * gl[0].px);
    if (fx.rotation) ctx.rotate((fx.rotation * Math.PI) / 180);
    if (fx.scale !== 1) ctx.scale(fx.scale, fx.scale);
    ctx.translate(-ucx, -ucy);
    if (fx.blur > 0) (ctx as CanvasRenderingContext2D).filter = `blur(${(fx.blur * gl[0].px).toFixed(1)}px)`;

    const paint = (drawFill: string | CanvasGradient | CanvasPattern, clipFrac?: number) => {
      for (const g of gl) {
        if (g.ch.trim() === "") continue;
        ctx.font = g.font;
        (ctx as CanvasRenderingContext2D).direction = g.rtl ? "rtl" : "ltr";
        const color = g.run?.color;
        ctx.save();
        if (clipFrac !== undefined) {
          ctx.beginPath();
          const left = x0;
          ctx.rect(g.rtl ? x1 - (x1 - x0) * clipFrac : left, -h, (x1 - x0) * clipFrac, h * 2);
          ctx.clip();
        }
        const atX = g.rtl ? g.x + g.w : g.x;
        ctx.textAlign = g.rtl ? "right" : "left";
        const px = g.px;
        if (spec.glow > 0 && clipFrac === undefined) {
          ctx.shadowColor = spec.glowColor;
          ctx.shadowBlur = spec.glow * h;
          ctx.fillStyle = spec.glowColor;
          ctx.fillText(g.ch, atX, g.y);
          ctx.fillText(g.ch, atX, g.y);
          ctx.shadowBlur = 0;
        }
        if (spec.shadow && clipFrac === undefined) {
          ctx.save();
          ctx.shadowColor = spec.shadowColor;
          ctx.shadowBlur = spec.shadowBlur * h;
          ctx.shadowOffsetY = spec.shadowBlur * h * 0.5;
          ctx.fillStyle = spec.shadowColor;
          ctx.fillText(g.ch, atX, g.y);
          ctx.restore();
        }
        if (spec.bevel && clipFrac === undefined) {
          // layered strokes: a dark outer edge, a light inner one
          ctx.lineJoin = "round";
          ctx.lineWidth = px * 0.1;
          ctx.strokeStyle = "rgba(0,0,0,0.55)";
          ctx.strokeText(g.ch, atX, g.y + px * 0.012);
          ctx.lineWidth = px * 0.035;
          ctx.strokeStyle = "rgba(255,255,255,0.7)";
          ctx.strokeText(g.ch, atX, g.y - px * 0.01);
        }
        if (spec.strokeWidth > 0 && clipFrac === undefined) {
          ctx.lineJoin = "round";
          ctx.lineWidth = spec.strokeWidth * h * 2;
          ctx.strokeStyle = spec.stroke;
          ctx.strokeText(g.ch, atX, g.y);
        }
        ctx.fillStyle = clipFrac !== undefined ? drawFill : color ?? drawFill;
        ctx.fillText(g.ch, atX, g.y);
        if (g.run?.underline ?? spec.underline) {
          ctx.fillRect(g.x, g.y + px * 0.1, g.w, Math.max(1, px * 0.06));
        }
        ctx.restore();
      }
    };
    paint(baseFill);
    if (fx.fill > 0) paint(spec.color2, Math.min(1, fx.fill));
    ctx.restore();
  });
  ctx.restore();
}
