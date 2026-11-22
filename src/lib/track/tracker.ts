/**
 * Point tracking and stabilisation (phase 22). Pure functions on grayscale frames: a block matcher follows a patch
 * from frame to frame, and the stabiliser turns the recorded path into a smoothed correction. The editor feeds it
 * frames one at a time (see TrackingCard), so no frame list is ever held in memory.
 */

export type Gray = { w: number; h: number; data: Uint8Array };
export type TrackSample = { /** Seconds from the start of the clip. */ t: number; /** Position as 0..1 of the frame. */ x: number; y: number; /** Match quality 0..1 (1 = identical patch). */ c: number; /** Planar trackers: degrees clockwise since the start, and size relative to the start. */ rot?: number; scale?: number };
export type Tracker = { id: string; name: string; /** Where the point started, 0..1 of the frame, and when (clip seconds). */ x: number; y: number; t0: number; samples: TrackSample[]; radius?: number; /** A planar tracker follows a region (0..1 of the frame) and also gives rotation and scale. Missing = a point tracker. */ kind?: "point" | "planar"; region?: { x: number; y: number; w: number; h: number } };

/** RGBA bytes to gray (Rec. 709 luma). */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = (rgba[i * 4] * 54 + rgba[i * 4 + 1] * 183 + rgba[i * 4 + 2] * 19) >> 8;
  return { w, h, data };
}

const px = (g: Gray, x: number, y: number) => g.data[Math.max(0, Math.min(g.h - 1, y)) * g.w + Math.max(0, Math.min(g.w - 1, x))];

/** The (2r+1)^2 patch of a frame around a pixel. */
export function patchAt(g: Gray, cx: number, cy: number, r: number): Uint8Array {
  const n = 2 * r + 1;
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = px(g, cx - r + x, cy - r + y);
  return out;
}

/**
 * Find a patch in a frame near a position: sum of absolute differences over a search window, then a parabola fit
 * through the best pixel and its neighbours for sub-pixel position. `c` is how well the best match fits (1 = exact).
 */
export function matchPatch(tpl: Uint8Array, r: number, frame: Gray, cx: number, cy: number, search: number): { x: number; y: number; c: number } {
  const n = 2 * r + 1;
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      let sad = 0;
      for (let y = 0; y < n && sad < best; y++) {
        const row = cy + dy - r + y;
        for (let x = 0; x < n; x++) sad += Math.abs(tpl[y * n + x] - px(frame, cx + dx - r + x, row));
      }
      if (sad < best) (best = sad, (bx = dx), (by = dy));
    }
  }
  // sub-pixel refinement: measure the neighbours in full (the search above stops a position early once it cannot win)
  const at = (dx: number, dy: number) => {
    let sad = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) sad += Math.abs(tpl[y * n + x] - px(frame, cx + dx - r + x, cy + dy - r + y));
    return sad;
  };
  const para = (m: number, c0: number, p: number) => {
    const d = m - 2 * c0 + p;
    return d > 1e-9 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * d))) : 0;
  };
  const fx = para(at(bx - 1, by), best, at(bx + 1, by));
  const fy = para(at(bx, by - 1), best, at(bx, by + 1));
  return { x: cx + bx + fx, y: cy + by + fy, c: Math.max(0, 1 - best / (n * n * 128)) };
}

export type TrackOptions = { /** Judge a match against the patch's own contrast, so a flat frame is a lost point rather than a poor match (planar tracking uses it). */ normalised?: boolean; /** Patch half-size in pixels. */ radius?: number; /** Search half-size in pixels. */ search?: number; /** Stop when the match falls under this quality. */ minConfidence?: number; /** How much of the first patch is kept in the template (0..1) to stop drift. */ anchor?: number };

/**
 * A tracker that is fed frames in order. Call `start` with the first frame, then `next` with each following frame;
 * it returns the new point (in pixels) or null when the match is lost.
 */
export class PointTracker {
  private tpl: Uint8Array;
  private first: Uint8Array;
  private r: number;
  private search: number;
  private anchor: number;
  private minC: number;
  private spread: number | null;
  pos: { x: number; y: number };
  constructor(first: Gray, x: number, y: number, o: TrackOptions = {}) {
    this.r = o.radius ?? 10;
    this.search = o.search ?? Math.max(8, Math.round(first.w * 0.04));
    this.anchor = o.anchor ?? 0.5;
    this.minC = o.minConfidence ?? (o.normalised ? 0.35 : 0.45);
    this.pos = { x, y };
    this.first = patchAt(first, Math.round(x), Math.round(y), this.r);
    this.tpl = this.first;
    // mean distance of the patch from its own average: how much there is to match against
    const mean = this.first.reduce((s, v) => s + v, 0) / this.first.length;
    this.spread = o.normalised ? Math.max(6, this.first.reduce((s, v) => s + Math.abs(v - mean), 0) / this.first.length) : null;
  }
  /** Follow the point into the next frame. */
  next(frame: Gray): { x: number; y: number; c: number } | null {
    const m = matchPatch(this.tpl, this.r, frame, Math.round(this.pos.x), Math.round(this.pos.y), this.search);
    if (this.spread !== null) m.c = Math.max(0, 1 - ((1 - m.c) * 128) / this.spread);
    if (m.c < this.minC) return null;
    this.pos = { x: m.x, y: m.y };
    // the template follows the picture (so lighting and rotation changes are tolerated) but is pulled back toward the first patch
    const cur = patchAt(frame, Math.round(m.x), Math.round(m.y), this.r);
    this.tpl = Uint8Array.from(cur, (v, i) => Math.round(v * (1 - this.anchor) + this.first[i] * this.anchor));
    return m;
  }
}

/* ---------- reading a path ---------- */

/** Where a tracker is at clip time t (linear between samples, held outside). */
export function trackerAt(tr: Tracker, t: number): { x: number; y: number } {
  const s = tr.samples;
  if (!s.length) return { x: tr.x, y: tr.y };
  if (t <= s[0].t) return { x: s[0].x, y: s[0].y };
  if (t >= s[s.length - 1].t) return { x: s[s.length - 1].x, y: s[s.length - 1].y };
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const k = (t - s[lo].t) / (s[hi].t - s[lo].t || 1);
  return { x: s[lo].x + (s[hi].x - s[lo].x) * k, y: s[lo].y + (s[hi].y - s[lo].y) * k };
}

/** How far the tracked point has moved since the clip's start position, in 0..1 frame units: what a pinned title or mask adds to its position. */
export function trackerOffset(tr: Tracker, t: number): { x: number; y: number } {
  const p = trackerAt(tr, t);
  const o = trackerAt(tr, tr.t0);
  return { x: p.x - o.x, y: p.y - o.y };
}

/** A path smoothed with a centred moving average of `seconds` (0 = unchanged). */
export function smoothPath(samples: TrackSample[], seconds: number): { t: number; x: number; y: number }[] {
  if (seconds <= 0 || samples.length < 3) return samples.map(({ t, x, y }) => ({ t, x, y }));
  const out: { t: number; x: number; y: number }[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].t;
    while (samples[lo].t < t - seconds / 2) lo++;
    while (hi < samples.length - 1 && samples[hi + 1].t <= t + seconds / 2) hi++;
    let sx = 0;
    let sy = 0;
    for (let k = lo; k <= hi; k++) (sx += samples[k].x, (sy += samples[k].y));
    out.push({ t, x: sx / (hi - lo + 1), y: sy / (hi - lo + 1) });
  }
  return out;
}

/**
 * The shift that stabilises a clip at time t: the smoothed path minus the real path (so the picture is pushed back to
 * where a steady camera would have put it), and the zoom that hides the borders that shift uncovers.
 */
export function stabiliseOffset(tr: Tracker, t: number, smoothing: number): { x: number; y: number } {
  const sm = smoothPath(tr.samples, smoothing);
  if (!sm.length) return { x: 0, y: 0 };
  let lo = 0;
  let hi = sm.length - 1;
  if (t <= sm[0].t) lo = hi = 0;
  else if (t >= sm[hi].t) lo = hi;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sm[mid].t <= t) lo = mid;
      else hi = mid;
    }
  }
  const k = lo === hi ? 0 : (t - sm[lo].t) / (sm[hi].t - sm[lo].t || 1);
  const sx = sm[lo].x + (sm[hi].x - sm[lo].x) * k;
  const sy = sm[lo].y + (sm[hi].y - sm[lo].y) * k;
  const real = trackerAt(tr, t);
  return { x: sx - real.x, y: sy - real.y };
}

/** The scale that covers the borders for a clip's largest stabilising shift (a fraction of the frame), plus a user margin in percent. */
export function stabiliseZoom(tr: Tracker, smoothing: number, extraPercent = 0): number {
  let worst = 0;
  for (const s of tr.samples) {
    const o = stabiliseOffset(tr, s.t, smoothing);
    worst = Math.max(worst, Math.abs(o.x), Math.abs(o.y));
  }
  return 1 + worst * 2 + extraPercent / 100;
}

/* ---------- rotation and scale (planar trackers) ---------- */

/** Linear read of a numeric field of the samples at t (held outside); 0 when no sample has it. */
function fieldAt(s: TrackSample[], t: number, pick: (x: TrackSample) => number | undefined, fallback: number): number {
  const has = s.filter((x) => pick(x) !== undefined);
  if (!has.length) return fallback;
  if (t <= has[0].t) return pick(has[0])!;
  if (t >= has[has.length - 1].t) return pick(has[has.length - 1])!;
  let lo = 0;
  let hi = has.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (has[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const k = (t - has[lo].t) / (has[hi].t - has[lo].t || 1);
  return pick(has[lo])! + (pick(has[hi])! - pick(has[lo])!) * k;
}

/** Whether a tracker knows how the surface turned and grew (a planar tracker), not just where it went. */
export const hasMotion = (tr: Tracker) => tr.samples.some((s) => s.rot !== undefined);

/** Rotation (degrees clockwise) and scale of the tracked surface at clip time t, relative to the tracker's start time. */
export function trackerMotion(tr: Tracker, t: number): { rot: number; scale: number } {
  const rot = (x: number) => fieldAt(tr.samples, x, (s) => s.rot, 0);
  const sc = (x: number) => fieldAt(tr.samples, x, (s) => s.scale, 1);
  return { rot: rot(t) - rot(tr.t0), scale: sc(t) / (sc(tr.t0) || 1) };
}

/** A smoothed copy of one field of the samples (centred moving average, like smoothPath). */
function smoothField(samples: TrackSample[], seconds: number, pick: (s: TrackSample) => number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].t;
    if (seconds > 0) {
      while (samples[lo].t < t - seconds / 2) lo++;
      while (hi < samples.length - 1 && samples[hi + 1].t <= t + seconds / 2) hi++;
    } else lo = hi = i;
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += pick(samples[k]);
    out.push({ t, v: sum / (hi - lo + 1) });
  }
  return out;
}

/** The turn that steadies a clip at t: the smoothed rotation minus the real one, in degrees. 0 for a point tracker. */
export function stabiliseRotation(tr: Tracker, t: number, smoothing: number): number {
  if (!hasMotion(tr) || tr.samples.length < 2) return 0;
  const sm = smoothField(tr.samples, smoothing, (s) => s.rot ?? 0);
  const k = fieldAt(tr.samples, t, (s) => s.rot, 0);
  let lo = 0;
  let hi = sm.length - 1;
  if (t <= sm[0].t) return sm[0].v - k;
  if (t >= sm[hi].t) return sm[hi].v - k;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sm[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - sm[lo].t) / (sm[hi].t - sm[lo].t || 1);
  return sm[lo].v + (sm[hi].v - sm[lo].v) * f - k;
}

/** Extra zoom that hides the corners a turned frame uncovers: the worst correction over the clip, for a frame of this aspect (width / height). */
export function rotationZoom(tr: Tracker, smoothing: number, aspect = 16 / 9): number {
  let worst = 0;
  for (const s of tr.samples) worst = Math.max(worst, Math.abs(stabiliseRotation(tr, s.t, smoothing)));
  const a = (Math.min(worst, 45) * Math.PI) / 180;
  return Math.cos(a) + Math.sin(a) * Math.max(aspect, 1 / aspect);
}
