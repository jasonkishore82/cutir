/** Video scopes (phase 20): measurements of a frame's pixels. Pure functions on RGBA bytes, drawn by ScopesCard. */

/** The canvas the viewer draws into; the scopes read it (set by Preview). */
export const scopeSource: { canvas: HTMLCanvasElement | null } = { canvas: null };

export type Histogram = { r: Uint32Array; g: Uint32Array; b: Uint32Array; luma: Uint32Array };

export function histogram(d: Uint8ClampedArray): Histogram {
  const h: Histogram = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), luma: new Uint32Array(256) };
  for (let i = 0; i < d.length; i += 4) {
    h.r[d[i]]++;
    h.g[d[i + 1]]++;
    h.b[d[i + 2]]++;
    h.luma[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
  }
  return h;
}

/** Per column of the picture, how many pixels sit at each level (256 rows per column), for luma or one channel. */
export function waveform(d: Uint8ClampedArray, w: number, h: number, channel: "luma" | "r" | "g" | "b" = "luma"): Uint32Array {
  const out = new Uint32Array(w * 256);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = channel === "luma" ? Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) : d[i + (channel === "r" ? 0 : channel === "g" ? 1 : 2)];
      out[x * 256 + v]++;
    }
  return out;
}

/** Chroma density on a size x size plane (Cb across, Cr up), centred on grey. */
export function vectorscope(d: Uint8ClampedArray, size = 128): Uint32Array {
  const out = new Uint32Array(size * size);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255;
    const g = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const cb = (b - y) / 1.8556; // -0.5..0.5
    const cr = (r - y) / 1.5748;
    const x = Math.min(size - 1, Math.max(0, Math.round((cb + 0.5) * (size - 1))));
    const yy = Math.min(size - 1, Math.max(0, Math.round((0.5 - cr) * (size - 1))));
    out[yy * size + x]++;
  }
  return out;
}

/** Where a pure colour lands on the vectorscope (for the graticule): fractions 0..1 across and down. */
export function vectorPosition(r: number, g: number, b: number): [number, number] {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [(b - y) / 1.8556 + 0.5, 0.5 - (r - y) / 1.5748];
}
