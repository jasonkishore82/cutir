import { EASINGS, EFFECTS, IDENTITY, LOOPS, TRANSITIONS, combineFx, presenceIn, presenceOut, toFx, unitPresence, type Fx, type Info } from "./animations";
import { evalKeyframes } from "./keyframes";
import { effectiveStyle, linesOfLayer, type Aspect, type LyricLine, type Project, type TextStyle, type TransitionType } from "../store/project";

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

type Layout = { style: TextStyle; scale: number; fontPx: number; lineH: number; rows: string[]; blockH: number; textW: number; cx: number; cy: number };

let measureCtx: CanvasRenderingContext2D | null = null;
const getMeasureCtx = () => (measureCtx ??= document.createElement("canvas").getContext("2d")!);

/** Where a line's text block sits and how big it is at canvas size w x h, before animation. */
function layoutLine(ctx: CanvasRenderingContext2D, project: Project, line: LyricLine, w: number, h: number): Layout | null {
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
  const textW = Math.max(...rows.map((r) => ctx.measureText(r).width));
  ctx.restore();

  const blockH = rows.length * lineH;
  const tf = style.transform;
  let cx = w / 2;
  let cy = h / 2;
  if (style.position === "top") cy = h * 0.1 + blockH / 2;
  if (style.position === "bottom") cy = h * 0.9 - blockH / 2;
  if (tf?.x !== undefined) cx = tf.x * w;
  if (tf?.y !== undefined) cy = tf.y * h;
  return { style, scale, fontPx, lineH, rows, blockH, textW, cx, cy };
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

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  time: number,
  w: number,
  h: number,
  assets: RenderAssets = {}
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawBackground(ctx, project, w, h, assets);

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
  const loop = loopDef.fx(t0, anim.loop.speed);
  const letterWise = !!loopDef.letterDy;
  let fx = combineFx(staggerIn ? IDENTITY : toFx(inDef.fx(pIn, "in")), staggerOut ? IDENTITY : toFx(outDef.fx(pOut, "out")));
  fx = combineFx(fx, toFx(loop));
  if (trans) fx = combineFx(fx, trans.fx);
  // keyframes ride on top of everything above (same code path for preview and export)
  const kf = evalKeyframes(line.keyframes, t0);
  fx = { ...fx, opacity: fx.opacity * kf.opacity };
  if (fx.opacity <= 0) return;

  const highlight = inDef.mode === "highlight";
  const dim = highlight ? 0.35 : 0; // alpha multiplier for not-yet-revealed text (0 = hidden)
  const reveals = inDef.mode === "reveal" || outDef.mode === "reveal";
  const revealFrac: number | null = reveals ? fx.reveal : null;
  const glow = loop.glow ?? 0;

  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, fx.opacity));
  ctx.translate(cx + fx.dx * h + kf.x * w, cy + fx.dy * h + kf.y * h);
  ctx.rotate(((tf.rotation + fx.rotation + kf.rotation) * Math.PI) / 180);
  ctx.scale(fx.scale * tf.scale * kf.scale, fx.scale * tf.scale * kf.scale);
  ctx.translate(-cx, -cy);
  if (fx.blur > 0.05 && "filter" in ctx) (ctx as CanvasRenderingContext2D).filter = `blur(${fx.blur * scale}px)`;

  ctx.font = `${fontPx}px "${style.fontFamily}", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${style.letterSpacing * scale}px`;

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
      const ldy = loopDef.letterDy ? loopDef.letterDy(t0, anim.loop.speed, i) : 0;
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
      paintText(ctx, u.text, ux, y, style, scale, 1, glow);
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
        paintText(ctx, word, x, y, look, scale, sung ? 1 : dim, glow);
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
    if (shown) paintText(ctx, shown, x0, y, style, scale, 1, glow);
    if (dim > 0 && reveal < row.length) {
      const rest = row.slice(reveal);
      paintText(ctx, rest, x0 + ctx.measureText(shown).width, y, style, scale, dim, glow);
    }
  });

  ctx.restore();
}

function paintText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, s: TextStyle, scale: number, mul: number, glow = 0) {
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
  if (glow > 0) {
    // a soft halo in the text colour, brightest at glow = 1
    ctx.shadowColor = s.color;
    ctx.shadowBlur = (sh.blur + 36 * glow) * scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.fillStyle = s.color;
  ctx.fillText(text, x, y);
  ctx.restore();
}
