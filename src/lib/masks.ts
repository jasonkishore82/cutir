/** Mask paths (phase 22): polygons and smooth (bezier) shapes drawn from points in 0..1 of the frame. */

export type Pt = [number, number];
export type Seg = { c1: Pt; c2: Pt; to: Pt };

/** Catmull-Rom through the points as cubic bezier segments (tension 0.5 is the classic curve; 0 gives straight corners). */
export function smoothSegments(points: Pt[], closed: boolean, tension = 0.5): { start: Pt; segs: Seg[] } | null {
  if (points.length < 2) return null;
  const n = points.length;
  const at = (i: number): Pt => (closed ? points[((i % n) + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const segs: Seg[] = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const k = tension / 3 * 2;
    segs.push({
      c1: [p1[0] + ((p2[0] - p0[0]) * k) / 2, p1[1] + ((p2[1] - p0[1]) * k) / 2],
      c2: [p2[0] - ((p3[0] - p1[0]) * k) / 2, p2[1] - ((p3[1] - p1[1]) * k) / 2],
      to: p2,
    });
  }
  return { start: points[0], segs };
}

type PathCtx = { moveTo: (x: number, y: number) => void; lineTo: (x: number, y: number) => void; bezierCurveTo: (a: number, b: number, c: number, d: number, e: number, f: number) => void; closePath: () => void };

/** Trace a mask path into a canvas context (points scaled to w x h, then shifted by an offset in frame fractions). */
export function tracePath(ctx: PathCtx, points: Pt[], smooth: boolean, w: number, h: number, offset: { x: number; y: number } = { x: 0, y: 0 }): boolean {
  if (points.length < 3) return false;
  const X = (v: number) => (v + offset.x) * w;
  const Y = (v: number) => (v + offset.y) * h;
  ctx.moveTo(X(points[0][0]), Y(points[0][1]));
  if (smooth) {
    const s = smoothSegments(points, true)!;
    for (const g of s.segs) ctx.bezierCurveTo(X(g.c1[0]), Y(g.c1[1]), X(g.c2[0]), Y(g.c2[1]), X(g.to[0]), Y(g.to[1]));
  } else for (let i = 1; i < points.length; i++) ctx.lineTo(X(points[i][0]), Y(points[i][1]));
  ctx.closePath();
  return true;
}

/** Whether a point lies inside a polygon (even-odd), for hit tests in the mask editor. */
export function insidePolygon(points: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The index of the point nearest to (x, y) within `radius`, or -1. */
export function nearestPoint(points: Pt[], x: number, y: number, radius: number): number {
  let best = -1;
  let d = radius;
  points.forEach(([px, py], i) => {
    const e = Math.hypot(px - x, py - y);
    if (e <= d) (d = e), (best = i);
  });
  return best;
}

/** A starting shape for a new path mask: a rounded diamond-ish quad around the centre. */
export const DEFAULT_PATH: Pt[] = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];

/** Shrink an alpha channel by `r` pixels (a min filter, separable); used by the keyer's edge shrink. */
export function erodeAlpha(alpha: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  if (r <= 0) return alpha;
  const tmp = new Uint8ClampedArray(alpha.length);
  const out = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let k = -r; k <= r; k++) m = Math.min(m, alpha[y * w + Math.max(0, Math.min(w - 1, x + k))]);
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 255;
      for (let k = -r; k <= r; k++) m = Math.min(m, tmp[Math.max(0, Math.min(h - 1, y + k)) * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}
