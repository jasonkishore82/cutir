import type { Layer, Params } from "./types";

/** Read a number param (falls back when missing or not a number). */
export const num = (p: Params, k: string, d = 0) => (typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : d);
export const str = (p: Params, k: string, d = "") => (typeof p[k] === "string" ? (p[k] as string) : d);
export const bool = (p: Params, k: string, d = false) => (typeof p[k] === "boolean" ? (p[k] as boolean) : d);
export const pt = (p: Params, k: string, d = { x: 0.5, y: 0.5 }) => {
  const v = p[k] as { x?: number; y?: number } | undefined;
  return { x: typeof v?.x === "number" ? v.x : d.x, y: typeof v?.y === "number" ? v.y : d.y };
};

/** Draw src into dst unchanged. */
export function copy(src: Layer, dst: Layer) {
  dst.ctx.drawImage(src.canvas, 0, 0);
}

/** Draw src into dst through a canvas filter string (blur, invert, ...). */
export function filtered(src: Layer, dst: Layer, filter: string) {
  dst.ctx.save();
  dst.ctx.filter = filter;
  dst.ctx.drawImage(src.canvas, 0, 0);
  dst.ctx.restore();
}

/** Sizes in params are in 1080p pixels; scale them to the frame. */
export const px = (v: number, l: { w: number; h: number }) => (v * Math.min(l.w, l.h)) / 1080;

/** "#rrggbb" -> [r, g, b] in 0..255. */
export function rgb255(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}
