import { PointTracker, type Gray, type TrackOptions } from "./tracker";

/**
 * The planar tracker (phase 22). A flat surface (a screen, a sign, a wall) is followed by tracking a grid of points
 * inside a region. Each frame, the way the points moved is fitted with a homography (perspective included) with
 * outliers thrown out, and from it come the centre of the region, its rotation and its scale. Pure maths on points,
 * so it runs in a worker and under node.
 */

export type Pt = [number, number];
/** A 3x3 matrix, row by row. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Rotation in degrees clockwise (the picture's y axis points down) and scale of the best similarity b = s R a + t. */
export type Similarity = { s: number; rot: number; tx: number; ty: number };

/** Least squares similarity (closed form, no reflection) taking points `a` to points `b`. */
export function fitSimilarity(a: Pt[], b: Pt[]): Similarity | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) (ax += a[i][0], (ay += a[i][1]), (bx += b[i][0]), (by += b[i][1]));
  ax /= n; ay /= n; bx /= n; by /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i][0] - ax, y = a[i][1] - ay, u = b[i][0] - bx, v = b[i][1] - by;
    num1 += x * u + y * v; // cos part
    num2 += x * v - y * u; // sin part
    den += x * x + y * y;
  }
  if (den < 1e-12) return null;
  const c = num1 / den, s = num2 / den;
  const scale = Math.hypot(c, s);
  return { s: scale, rot: (Math.atan2(s, c) * 180) / Math.PI, tx: bx - (c * ax - s * ay), ty: by - (s * ax + c * ay) };
}

export function applySimilarity(m: Similarity, p: Pt): Pt {
  const r = (m.rot * Math.PI) / 180;
  const c = Math.cos(r) * m.s, s = Math.sin(r) * m.s;
  return [c * p[0] - s * p[1] + m.tx, s * p[0] + c * p[1] + m.ty];
}

/** Solve A x = b for a small dense system (Gaussian elimination with pivoting). Null when singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Normalising transform (centre at the origin, mean distance sqrt 2) for stable fits. */
function normaliser(p: Pt[]): { T: Mat3; pts: Pt[] } {
  const n = p.length;
  const cx = p.reduce((s, q) => s + q[0], 0) / n;
  const cy = p.reduce((s, q) => s + q[1], 0) / n;
  const d = p.reduce((s, q) => s + Math.hypot(q[0] - cx, q[1] - cy), 0) / n || 1;
  const k = Math.SQRT2 / d;
  return { T: [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1], pts: p.map((q) => [(q[0] - cx) * k, (q[1] - cy) * k] as Pt) };
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o as Mat3;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Homography taking points `a` to points `b` (direct linear transform on normalised points). Needs four or more points. */
export function fitHomography(a: Pt[], b: Pt[]): Mat3 | null {
  const n = Math.min(a.length, b.length);
  if (n < 4) return null;
  const na = normaliser(a.slice(0, n));
  const nb = normaliser(b.slice(0, n));
  // h33 = 1: eight unknowns, least squares through the normal equations
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < n; i++) {
    const [x, y] = na.pts[i];
    const [u, v] = nb.pts[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const Hn: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const inv = invert3(nb.T);
  if (!inv) return null;
  const H = mul3(mul3(inv, Hn), na.T);
  const k = H[8] || 1;
  return H.map((v) => v / k) as Mat3;
}

export function applyHomography(H: Mat3, p: Pt): Pt {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

/** Rotation (degrees clockwise) and scale of a homography at a point: the local linear part, read like a similarity. */
export function localMotion(H: Mat3, at: Pt): { rot: number; scale: number } {
  const e = 0.5;
  const p0 = applyHomography(H, [at[0] - e, at[1]]);
  const p1 = applyHomography(H, [at[0] + e, at[1]]);
  const q0 = applyHomography(H, [at[0], at[1] - e]);
  const q1 = applyHomography(H, [at[0], at[1] + e]);
  const ax = (p1[0] - p0[0]) / (2 * e), ay = (p1[1] - p0[1]) / (2 * e);
  const bx = (q1[0] - q0[0]) / (2 * e), by = (q1[1] - q0[1]) / (2 * e);
  // the average of the x axis and the y axis as seen after the move (the y axis is the x axis turned a quarter)
  const c = (ax + by) / 2, s = (ay - bx) / 2;
  return { rot: (Math.atan2(s, c) * 180) / Math.PI, scale: Math.hypot(c, s) };
}

export type PlanarFit = { /** The model that was kept. */ kind: "homography" | "similarity"; map: (p: Pt) => Pt; rot: number; scale: number; /** Points that agreed with the fit. */ inliers: boolean[]; /** Mean error of the inliers, pixels. */ error: number };

/**
 * Fit how a set of points moved, rejecting outliers: fit, drop the points whose error is far above the median, fit again.
 * With four or more good points a homography is used, with two or three a similarity.
 */
export function fitMotion(ref: Pt[], now: Pt[], center: Pt): PlanarFit | null {
  const n = Math.min(ref.length, now.length);
  if (n < 2) return null;
  let use = Array.from({ length: n }, (_, i) => i);
  let fit: PlanarFit | null = null;
  for (let pass = 0; pass < 3; pass++) {
    const a = use.map((i) => ref[i]);
    const b = use.map((i) => now[i]);
    let map: ((p: Pt) => Pt) | null = null;
    let kind: PlanarFit["kind"] = "similarity";
    let rot = 0, scale = 1;
    const H = use.length >= 4 ? fitHomography(a, b) : null;
    if (H && H.every(Number.isFinite)) {
      map = (p) => applyHomography(H, p);
      kind = "homography";
      const m = localMotion(H, center);
      rot = m.rot;
      scale = m.scale;
    } else {
      const sim = fitSimilarity(a, b);
      if (!sim) return fit;
      map = (p) => applySimilarity(sim, p);
      rot = sim.rot;
      scale = sim.s;
    }
    const errs = Array.from({ length: n }, (_, i) => {
      const q = map!(ref[i]);
      return Math.hypot(q[0] - now[i][0], q[1] - now[i][1]);
    });
    const sorted = use.map((i) => errs[i]).sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)];
    const limit = Math.max(1.5, med * 2.5);
    const inliers = errs.map((e) => e <= limit);
    const kept = use.filter((i) => inliers[i]);
    const error = kept.length ? kept.reduce((s, i) => s + errs[i], 0) / kept.length : Infinity;
    fit = { kind, map, rot, scale, inliers: Array.from({ length: n }, (_, i) => use.includes(i) && inliers[i]), error };
    if (kept.length === use.length || kept.length < 2) break;
    use = kept;
  }
  return fit;
}

/* ---------- following a region through frames ---------- */

export type PlanarOptions = TrackOptions & { /** Points per side of the grid (2 to 6). */ grid?: number };

export type PlanarResult = { /** Centre of the region in pixels. */ x: number; y: number; /** Degrees clockwise since the start. */ rot: number; /** Size relative to the start (1 = unchanged). */ scale: number; /** 0..1: how many points still agree. */ c: number; model: PlanarFit["kind"] };

/** A planar tracker fed frames in order, like `PointTracker`. `region` is in pixels. */
export class PlanarTracker {
  private pts: PointTracker[];
  private ref: Pt[];
  private alive: boolean[];
  private centre: Pt;
  private minPoints: number;
  constructor(first: Gray, region: { x: number; y: number; w: number; h: number }, o: PlanarOptions = {}) {
    const g = Math.max(2, Math.min(6, Math.round(o.grid ?? 3)));
    this.ref = [];
    for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) this.ref.push([region.x + (region.w * (i + 0.5)) / g, region.y + (region.h * (j + 0.5)) / g]);
    this.centre = [region.x + region.w / 2, region.y + region.h / 2];
    const r = o.radius ?? Math.max(5, Math.round(Math.min(region.w, region.h) / (g * 2.5)));
    this.pts = this.ref.map(([x, y]) => new PointTracker(first, x, y, { ...o, normalised: true, radius: r, search: o.search ?? Math.max(8, Math.round(first.w * 0.04)) }));
    this.alive = this.ref.map(() => true);
    this.minPoints = 2;
  }
  get points() {
    return this.pts.map((p, i) => ({ x: p.pos.x, y: p.pos.y, alive: this.alive[i] }));
  }
  /** Follow the region into the next frame; null when fewer than two points can still be followed. */
  next(frame: Gray): PlanarResult | null {
    const now: Pt[] = [];
    const ref: Pt[] = [];
    this.pts.forEach((t, i) => {
      if (!this.alive[i]) return;
      const m = t.next(frame);
      if (!m) {
        this.alive[i] = false;
        return;
      }
      now.push([m.x, m.y]);
      ref.push(this.ref[i]);
    });
    if (now.length < this.minPoints) return null;
    const fit = fitMotion(ref, now, this.centre);
    if (!fit) return null;
    const inl = fit.inliers.filter(Boolean).length;
    // points the fit threw out are not followed any more (a hand crossing the surface, a reflection)
    let k = 0;
    this.pts.forEach((_, i) => {
      if (!this.alive[i]) return;
      if (!fit.inliers[k++]) this.alive[i] = false;
    });
    if (inl < this.minPoints) return null;
    const c = fit.map(this.centre);
    return { x: c[0], y: c[1], rot: fit.rot, scale: fit.scale, c: Math.max(0, Math.min(1, inl / this.ref.length)) * Math.max(0, 1 - fit.error / 8), model: fit.kind };
  }
}
