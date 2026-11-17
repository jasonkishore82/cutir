import type { Aspect, LyricLine, Project, TextStyle } from "../store/project";

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
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

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

/** Per-word start times for word-highlight: real timings if present, else an even split. */
function wordStarts(line: LyricLine, count: number): number[] {
  if (line.words && line.words.length === count) return line.words.map((w) => w.start);
  const dur = Math.max(0.01, line.end - line.start);
  return Array.from({ length: count }, (_, i) => line.start + (dur * i) / count);
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

  const line = activeLine(project.lines, time);
  if (line) drawLyric(ctx, project, line, time, w, h);
  ctx.restore();
}

function drawLyric(ctx: CanvasRenderingContext2D, project: Project, line: LyricLine, t: number, w: number, h: number) {
  const style: TextStyle = { ...project.style, ...line.styleOverride };
  const scale = Math.min(w, h) / REF;
  const fontPx = style.fontSize * scale;
  const lineH = fontPx * style.lineHeight;

  const raw = style.uppercase ? line.text.toUpperCase() : line.text;
  const rows = wrapText(raw, style.maxCharsPerLine);
  if (!rows.length) return;

  /* animation parameters */
  const dur = Math.max(0.001, line.end - line.start);
  const ms = Math.min(style.animationMs / 1000, dur / 2);
  const pin = ms > 0 ? clamp01((t - line.start) / ms) : 1;
  const pout = ms > 0 ? clamp01((line.end - t) / ms) : 1;
  const eIn = easeOutCubic(pin);

  let alpha = pin * pout;
  let sc = 1;
  let dy = 0;
  let dim = 0; // alpha multiplier for not-yet-revealed text (0 = hidden)
  let revealFrac: number | null = null; // typewriter
  let highlight = false;

  switch (style.animation) {
    case "fade":
      sc = 0.96 + 0.04 * eIn;
      break;
    case "pop":
      alpha = clamp01(pin * 2) * pout;
      sc = 0.6 + 0.4 * easeOutBack(pin);
      break;
    case "slide-up":
      dy = (1 - eIn) * 0.06 * h;
      break;
    case "typewriter": {
      alpha = pout;
      const total = rows.join("").length;
      const typeDur = Math.min(dur * 0.7, Math.max(0.3, total * 0.05));
      revealFrac = clamp01((t - line.start) / typeDur);
      break;
    }
    case "word-highlight":
      dim = 0.35;
      break;
  }
  if (alpha <= 0) return;

  /* block geometry */
  const blockH = rows.length * lineH;
  const cx = w / 2;
  let cy = h / 2;
  if (style.position === "top") cy = h * 0.1 + blockH / 2;
  if (style.position === "bottom") cy = h * 0.9 - blockH / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy + dy);
  ctx.scale(sc, sc);
  ctx.translate(-cx, -cy);

  ctx.font = `${fontPx}px "${style.fontFamily}", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${style.letterSpacing * scale}px`;

  /* reveal counts per row */
  const wordsByRow = rows.map((r) => r.split(" "));
  const totalWords = wordsByRow.reduce((n, ws) => n + ws.length, 0);
  highlight = style.animation === "word-highlight";
  const starts = highlight ? wordStarts(line, totalWords) : [];
  let charsLeft = revealFrac === null ? Infinity : Math.floor(revealFrac * rows.join("").length + 1e-6);

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
    if (shown) paintText(ctx, shown, x0, y, style, scale, 1);
    if (dim > 0 && reveal < row.length) {
      const rest = row.slice(reveal);
      paintText(ctx, rest, x0 + ctx.measureText(shown).width, y, style, scale, dim);
    }
  });

  ctx.restore();
}

function paintText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, s: TextStyle, scale: number, mul: number) {
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
  ctx.fillStyle = s.color;
  ctx.fillText(text, x, y);
  ctx.restore();
}
