import type { Generator, ShapeSpec } from "../model/types";
import { drawTitle } from "./titles";

/**
 * Generators (phase 19): clips that make their own picture instead of reading a file: solid colour, gradient, shapes,
 * noise, countdown, timecode and titles. `drawGenerator` paints one at `t` seconds into the clip; the compositor draws
 * the result like any picture, so transforms, opacity, blend modes, effects, keyframes and transitions all work on it.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const GENERATOR_KINDS: { id: Generator["type"]; name: string }[] = [
  { id: "solid", name: "Solid colour" },
  { id: "gradient", name: "Gradient" },
  { id: "noise", name: "Noise" },
  { id: "countdown", name: "Countdown" },
  { id: "timecode", name: "Timecode" },
  { id: "shape", name: "Shape" },
  { id: "title", name: "Title" },
];

export const SHAPE_KINDS: { id: ShapeSpec["kind"]; name: string }[] = [
  { id: "rectangle", name: "Rectangle" },
  { id: "ellipse", name: "Ellipse" },
  { id: "line", name: "Line" },
  { id: "polygon", name: "Polygon" },
  { id: "arrow", name: "Arrow" },
];

export const shapeOf = (kind: ShapeSpec["kind"], over: Partial<ShapeSpec> = {}): ShapeSpec => ({
  kind,
  x: 0.5,
  y: 0.5,
  width: kind === "line" || kind === "arrow" ? 0.5 : 0.3,
  height: kind === "line" ? 0 : kind === "arrow" ? 0.12 : 0.3,
  fill: kind === "line" ? "" : "#ffd84a",
  stroke: kind === "line" || kind === "arrow" ? "#ffd84a" : "#000000",
  strokeWidth: kind === "line" ? 0.008 : 0,
  radius: kind === "rectangle" ? 0.08 : 0,
  sides: kind === "polygon" ? 6 : 5,
  rotation: 0,
  ...over,
});

/** A default generator of a kind, for "add" buttons. */
export function newGenerator(type: Generator["type"], over: Record<string, unknown> = {}): Generator {
  switch (type) {
    case "solid":
      return { type, color: "#1d4ed8", ...over } as Generator;
    case "gradient":
      return { type, colors: ["#6d28d9", "#ec4899"], angle: 135, noise: false, ...over } as Generator;
    case "noise":
      return { type, amount: 60, scale: 3, mono: true, speed: 24, color: "#ffffff", ...over } as Generator;
    case "countdown":
      return { type, from: 5, color: "#ffffff", ring: true, size: 0.35, font: "Inter", ...over } as Generator;
    case "timecode":
      return { type, color: "#ffffff", size: 0.07, font: "Inter", fps: 30, offset: 0, box: true, ...over } as Generator;
    case "shape":
      return { type, shape: shapeOf("rectangle"), ...over } as Generator;
    case "title":
      throw new Error("Titles are made with titleOf (src/lib/titles.ts)");
  }
}

/** HH:MM:SS:FF for a time in seconds. */
export function timecode(seconds: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const total = Math.max(0, Math.floor(seconds * f + 1e-6));
  const frames = total % f;
  const s = Math.floor(total / f) % 60;
  const m = Math.floor(total / (f * 60)) % 60;
  const h = Math.floor(total / (f * 3600));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)}:${two(frames)}`;
}

/** The number a countdown shows at t (counts down to 1, then holds 1). */
export const countdownAt = (from: number, t: number) => Math.max(1, Math.ceil(Math.max(1, from) - t - 1e-9));

/** The corner points of a regular polygon (for drawing and tests): unit radius, first corner straight up. */
export function polygonPoints(sides: number, cx: number, cy: number, rx: number, ry: number): [number, number][] {
  const n = Math.min(12, Math.max(3, Math.round(sides)));
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as [number, number];
  });
}

/** Arrow outline: a shaft and a head, pointing right, in a width x height box centred on the origin. */
export function arrowPoints(w: number, h: number): [number, number][] {
  const head = Math.min(w * 0.4, h * 1.2);
  const shaft = h * 0.4;
  return [[-w / 2, -shaft / 2], [w / 2 - head, -shaft / 2], [w / 2 - head, -h / 2], [w / 2, 0], [w / 2 - head, h / 2], [w / 2 - head, shaft / 2], [-w / 2, shaft / 2]];
}

function drawShape(ctx: Ctx, s: ShapeSpec, w: number, h: number) {
  ctx.save();
  ctx.translate(s.x * w, s.y * h);
  ctx.rotate((s.rotation * Math.PI) / 180);
  const bw = s.width * h;
  const bh = s.height * h;
  ctx.beginPath();
  if (s.kind === "rectangle") {
    const r = Math.min(s.radius * Math.min(bw, bh), bw / 2, bh / 2);
    ctx.moveTo(-bw / 2 + r, -bh / 2);
    ctx.arcTo(bw / 2, -bh / 2, bw / 2, bh / 2, r);
    ctx.arcTo(bw / 2, bh / 2, -bw / 2, bh / 2, r);
    ctx.arcTo(-bw / 2, bh / 2, -bw / 2, -bh / 2, r);
    ctx.arcTo(-bw / 2, -bh / 2, bw / 2, -bh / 2, r);
    ctx.closePath();
  } else if (s.kind === "ellipse") ctx.ellipse(0, 0, Math.max(0.5, bw / 2), Math.max(0.5, bh / 2), 0, 0, Math.PI * 2);
  else if (s.kind === "line") {
    ctx.moveTo(-bw / 2, 0);
    ctx.lineTo(bw / 2, 0);
  } else {
    const pts = s.kind === "polygon" ? polygonPoints(s.sides, 0, 0, bw / 2, bh / 2) : arrowPoints(bw, bh);
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
  if (s.fill && s.kind !== "line") {
    ctx.fillStyle = s.fill;
    ctx.fill();
  }
  const lw = s.strokeWidth * h;
  if (lw > 0 || s.kind === "line") {
    ctx.lineWidth = Math.max(1, lw);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.kind === "line" ? s.stroke || s.fill || "#fff" : s.stroke;
    ctx.stroke();
  }
  ctx.restore();
}

let noiseCanvas: { c: OffscreenCanvas | HTMLCanvasElement; x: Ctx } | null = null;
function noiseTile(w: number, h: number) {
  if (!noiseCanvas || noiseCanvas.c.width !== w || noiseCanvas.c.height !== h) {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    noiseCanvas = { c, x: c.getContext("2d") as Ctx };
  }
  return noiseCanvas;
}

/** Noise bytes for one frame: a seeded generator, so the same time always gives the same picture (viewer = export). */
export function noiseBytes(w: number, h: number, seed: number, amount: number, mono: boolean, tint: [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = (Math.floor(seed) * 9301 + 49297) % 2147483647 || 1;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const a = Math.min(1, Math.max(0, amount / 100));
  for (let i = 0; i < d.length; i += 4) {
    const v = rnd();
    const g = mono ? v : rnd();
    const b = mono ? v : rnd();
    d[i] = v * tint[0];
    d[i + 1] = g * tint[1];
    d[i + 2] = b * tint[2];
    d[i + 3] = 255 * a;
  }
  return d;
}

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
};

/** Paint a generator at `t` seconds into its clip. `dur` is the clip's length. */
export function drawGenerator(ctx: Ctx, gen: Generator, t: number, dur: number, w: number, h: number) {
  switch (gen.type) {
    case "solid":
      ctx.fillStyle = gen.color;
      ctx.fillRect(0, 0, w, h);
      return;
    case "gradient": {
      const a = (gen.angle * Math.PI) / 180;
      const r = Math.hypot(w, h) / 2;
      const g = ctx.createLinearGradient(w / 2 - Math.sin(a) * r, h / 2 + Math.cos(a) * r * -1, w / 2 + Math.sin(a) * r, h / 2 + Math.cos(a) * r);
      gen.colors.forEach((c, i) => g.addColorStop(gen.colors.length > 1 ? i / (gen.colors.length - 1) : 0, c));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    case "shape":
      drawShape(ctx, gen.shape, w, h);
      return;
    case "noise": {
      const k = Math.max(1, Math.round(gen.scale));
      const tw = Math.max(1, Math.ceil(w / k));
      const th = Math.max(1, Math.ceil(h / k));
      const tile = noiseTile(tw, th);
      const img = (tile.x as CanvasRenderingContext2D).createImageData(tw, th);
      img.data.set(noiseBytes(tw, th, Math.floor(t * Math.max(0, gen.speed)), gen.amount, gen.mono, hexRgb(gen.color)));
      (tile.x as CanvasRenderingContext2D).putImageData(img, 0, 0);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(tile.c as CanvasImageSource, 0, 0, w, h);
      ctx.restore();
      return;
    }
    case "countdown": {
      const n = countdownAt(gen.from, t);
      const px = gen.size * h;
      ctx.save();
      ctx.fillStyle = gen.color;
      ctx.strokeStyle = gen.color;
      ctx.font = `700 ${px}px ${gen.font}, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(n), w / 2, h / 2 + px * 0.04);
      if (gen.ring) {
        const frac = 1 - (((t % 1) + 1) % 1);
        ctx.lineWidth = Math.max(2, px * 0.04);
        ctx.globalAlpha *= 0.9;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, px * 0.78, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    case "timecode": {
      const px = gen.size * h;
      const text = timecode(t + gen.offset, gen.fps);
      ctx.save();
      ctx.font = `600 ${px}px ${gen.font}, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (gen.box) {
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(w / 2 - tw / 2 - px * 0.4, h / 2 - px * 0.75, tw + px * 0.8, px * 1.5);
      }
      ctx.fillStyle = gen.color;
      ctx.fillText(text, w / 2, h / 2);
      ctx.restore();
      return;
    }
    case "title":
      drawTitle(ctx, gen.title, t, dur, w, h);
      return;
  }
}
