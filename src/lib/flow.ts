/**
 * Motion estimation between two frames, for slow motion that moves instead of dissolving (phase 23).
 *
 * The frames are compared as small grey pictures. Each block of the first is searched for in the second (sum of
 * absolute differences, refined to a fraction of a pixel); stray vectors are cleaned with a median. The field then
 * says how to build a frame part of the way between the two: every block is taken from the first frame moved back by
 * t of its vector and from the second moved forward by 1 - t, and the two are mixed. Pure, so it runs in tests; the
 * compositor draws the blocks on a canvas.
 */

export type FlowField = {
  w: number;
  h: number;
  block: number;
  cols: number;
  rows: number;
  /** Vector per block in pixels of the analysed picture: where the block of frame A went in frame B. */
  dx: Float32Array;
  dy: Float32Array;
};

export type FlowOptions = { block?: number; range?: number };

/** Sum of absolute differences of a block of `a` at (x, y) against `b` at (x + u, y + v); Infinity when it leaves the picture. */
function sad(a: ArrayLike<number>, b: ArrayLike<number>, w: number, h: number, x: number, y: number, bw: number, bh: number, u: number, v: number, stop: number): number {
  const x2 = x + u;
  const y2 = y + v;
  if (x2 < 0 || y2 < 0 || x2 + bw > w || y2 + bh > h) return Infinity;
  let s = 0;
  for (let j = 0; j < bh; j++) {
    const ra = (y + j) * w + x;
    const rb = (y2 + j) * w + x2;
    for (let i = 0; i < bw; i++) s += Math.abs(a[ra + i] - b[rb + i]);
    if (s >= stop) return s;
  }
  return s;
}

/** Block vectors from frame `a` to frame `b` (grey pictures of the same size, w by h). */
export function estimateFlow(a: ArrayLike<number>, b: ArrayLike<number>, w: number, h: number, opt: FlowOptions = {}): FlowField {
  const block = opt.block ?? 8;
  const range = opt.range ?? 8;
  const cols = Math.max(1, Math.ceil(w / block));
  const rows = Math.max(1, Math.ceil(h / block));
  const dx = new Float32Array(cols * rows);
  const dy = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * block;
      const y = r * block;
      const bw = Math.min(block, w - x);
      const bh = Math.min(block, h - y);
      const zero = sad(a, b, w, h, x, y, bw, bh, 0, 0, Infinity);
      let best = zero;
      let bu = 0;
      let bv = 0;
      // a small pull towards no motion keeps flat areas from drifting
      const pull = bw * bh * 0.05;
      let bestCost = zero;
      for (let v = -range; v <= range; v++) {
        for (let u = -range; u <= range; u++) {
          if (!u && !v) continue;
          const s = sad(a, b, w, h, x, y, bw, bh, u, v, bestCost);
          const cost = s + pull * (Math.abs(u) + Math.abs(v)) * 0.25;
          if (cost < bestCost) (bestCost = cost), (best = s), (bu = u), (bv = v);
        }
      }
      // too little better than standing still: no motion (textureless blocks match anywhere)
      if (!(best < zero * 0.85)) {
        bu = 0;
        bv = 0;
      }
      let fx = bu;
      let fy = bv;
      if (bu || bv) {
        // parabola through the three costs either side of the best, for a fraction of a pixel
        const at = (u: number, v: number) => sad(a, b, w, h, x, y, bw, bh, u, v, Infinity);
        const s0 = at(bu, bv);
        const refine = (lo: number, hi: number) => {
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
          const d = lo - 2 * s0 + hi;
          return d > 1e-6 ? Math.max(-0.5, Math.min(0.5, (lo - hi) / (2 * d))) : 0;
        };
        fx += refine(at(bu - 1, bv), at(bu + 1, bv));
        fy += refine(at(bu, bv - 1), at(bu, bv + 1));
      }
      dx[r * cols + c] = fx;
      dy[r * cols + c] = fy;
    }
  }
  return medianField({ w, h, block, cols, rows, dx, dy });
}

/** Replace every vector by the median of the 3 by 3 around it, to remove blocks that matched the wrong place. */
export function medianField(f: FlowField): FlowField {
  const med = (src: Float32Array) => {
    const out = new Float32Array(src.length);
    const win: number[] = [];
    for (let r = 0; r < f.rows; r++) {
      for (let c = 0; c < f.cols; c++) {
        win.length = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const rr = r + j;
          const cc = c + i;
          if (rr >= 0 && cc >= 0 && rr < f.rows && cc < f.cols) win.push(src[rr * f.cols + cc]);
        }
        win.sort((p, q) => p - q);
        out[r * f.cols + c] = win[win.length >> 1];
      }
    }
    return out;
  };
  return { ...f, dx: med(f.dx), dy: med(f.dy) };
}

/** How much of the picture moves at all, 0..1; a field that is almost all still is better shown as a plain blend. */
export function flowActivity(f: FlowField): number {
  let n = 0;
  for (let i = 0; i < f.dx.length; i++) if (Math.abs(f.dx[i]) + Math.abs(f.dy[i]) > 0.25) n++;
  return f.dx.length ? n / f.dx.length : 0;
}

/** One block to draw: its place in the output, and where to read it from in each frame (all in the output's pixels). */
export type FlowDraw = { x: number; y: number; w: number; h: number; ax: number; ay: number; bx: number; by: number };

/** The blocks that make the frame at `t` (0 = frame A, 1 = frame B), for an output `outW` pixels wide. */
export function flowDraws(f: FlowField, t: number, outW: number, outH: number): FlowDraw[] {
  const sx = outW / f.w;
  const sy = outH / f.h;
  const out: FlowDraw[] = [];
  for (let r = 0; r < f.rows; r++) {
    for (let c = 0; c < f.cols; c++) {
      const i = r * f.cols + c;
      const x = c * f.block * sx;
      const y = r * f.block * sy;
      const w = Math.min(f.block * sx, outW - x) + (c < f.cols - 1 ? 0.5 : 0); // a sliver of overlap hides seams
      const h = Math.min(f.block * sy, outH - y) + (r < f.rows - 1 ? 0.5 : 0);
      const vx = f.dx[i] * sx;
      const vy = f.dy[i] * sy;
      out.push({ x, y, w, h, ax: x - t * vx, ay: y - t * vy, bx: x + (1 - t) * vx, by: y + (1 - t) * vy });
    }
  }
  return out;
}

/** Grey pixel with bilinear reading, edges held. */
const sample = (g: ArrayLike<number>, w: number, h: number, x: number, y: number) => {
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  return (g[y0 * w + x0] * (1 - fx) + g[y0 * w + x1] * fx) * (1 - fy) + (g[y1 * w + x0] * (1 - fx) + g[y1 * w + x1] * fx) * fy;
};

/** The frame at `t` between two grey pictures along the field (what the canvas drawing does, for tests and checks). */
export function interpolateGray(a: ArrayLike<number>, b: ArrayLike<number>, f: FlowField, t: number): Float32Array {
  const out = new Float32Array(f.w * f.h);
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = Math.min(f.rows - 1, Math.floor(y / f.block)) * f.cols + Math.min(f.cols - 1, Math.floor(x / f.block));
      const va = sample(a, f.w, f.h, x - t * f.dx[i], y - t * f.dy[i]);
      const vb = sample(b, f.w, f.h, x + (1 - t) * f.dx[i], y + (1 - t) * f.dy[i]);
      out[y * f.w + x] = va * (1 - t) + vb * t;
    }
  }
  return out;
}
