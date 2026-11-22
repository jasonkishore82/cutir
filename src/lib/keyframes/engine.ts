import { EASINGS } from "../animations";
import type { Easing } from "../../store/project";

/**
 * The general keyframe engine (phase 18). One lane of keys animates one value of a clip: an effect param, a
 * placement value (x, y, scale, rotation, opacity) or the volume. Values can be numbers, colours ("#rrggbb"),
 * points ({x, y}) or angles (degrees, interpolated the short way round).
 *
 * Between two keys the earlier key's `mode` decides the shape:
 *   hold      the value jumps at the next key
 *   linear    straight line
 *   ease      a preset ease (`easing`: ease-in, ease-out, ease-in-out, back, elastic, bounce)
 *   bezier    a cubic ease curve with two handles (`out` on this key, `in` on the next), like a CSS cubic-bezier
 *
 * `t` is seconds from the clip's start, so moving the clip moves its keys. Lanes are kept sorted by time.
 */

/** A mask or shape outline: points as 0..1 of the frame. Keys of a path blend point by point (phase 22). */
export type PathValue = [number, number][];
export type KeyValue = number | string | { x: number; y: number } | PathValue;
export type KeyMode = "hold" | "linear" | "ease" | "bezier";
export type EaseName = Easing | "bounce";
export type Key = {
  t: number;
  v: KeyValue;
  mode?: KeyMode; // missing = "ease" when `easing` is set, else "linear"
  easing?: EaseName;
  /** Bezier handles as (time, value) fractions of the span to the neighbour: 0..1 time, any value. */
  out?: [number, number];
  in?: [number, number];
};
export type ValueKind = "number" | "angle" | "color" | "point" | "path";

export const EASE_NAMES: EaseName[] = ["linear", "ease-in", "ease-out", "ease-in-out", "back", "elastic", "bounce"];

const bounce = (t: number) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};
export const easeFn = (name: EaseName | undefined): ((t: number) => number) => (name === "bounce" ? bounce : EASINGS[name as Easing] ?? EASINGS.linear);

export const modeOf = (k: Key): KeyMode => k.mode ?? (k.easing && k.easing !== "linear" ? "ease" : "linear");

/* ---------- bezier: solve y for x on a cubic from (0,0) via (x1,y1),(x2,y2) to (1,1) ---------- */

function cubicBezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const sample = (a: number, b: number, t: number) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
  // Newton, then bisection, on the x polynomial
  let t = x;
  for (let i = 0; i < 8; i++) {
    const dx = sample(x1, x2, t) - x;
    const d = (3 * (1 - 3 * x2 + 3 * x1) * t + 2 * (3 * x2 - 6 * x1)) * t + 3 * x1;
    if (Math.abs(dx) < 1e-6) break;
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
  }
  if (t < 0 || t > 1 || Math.abs(sample(x1, x2, t) - x) > 1e-4) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      t = (lo + hi) / 2;
      if (sample(x1, x2, t) < x) lo = t;
      else hi = t;
    }
  }
  return sample(y1, y2, t);
}

/** Progress 0..1 between key a and the next key b at fraction f of the span. */
export function shape(a: Key, b: Key | undefined, f: number): number {
  const m = modeOf(a);
  if (m === "hold") return 0;
  if (m === "ease") return easeFn(a.easing)(f);
  if (m === "bezier") {
    const o = a.out ?? [0.33, 0.33];
    const i = b?.in ?? [0.33, 0.33];
    return cubicBezierY(Math.min(1, Math.max(0, o[0])), o[1], Math.min(1, Math.max(0, 1 - i[0])), 1 - i[1], f);
  }
  return f;
}

/* ---------- values ---------- */

export const kindOfValue = (v: KeyValue | undefined, hint?: ValueKind): ValueKind => hint ?? (typeof v === "string" ? "color" : Array.isArray(v) ? "path" : typeof v === "object" && v ? "point" : "number");

const hex = (s: string) => {
  const h = s.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
};
const toHex = (rgb: number[]) => "#" + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
// mix colours in linear light so midpoints do not go dark
const toLin = (c: number) => Math.pow(c / 255, 2.2);
const fromLin = (c: number) => Math.pow(c, 1 / 2.2) * 255;

/** Mix two values by p (0..1) according to their kind. */
export function mix(a: KeyValue, b: KeyValue, p: number, kind: ValueKind): KeyValue {
  if (kind === "color" && typeof a === "string" && typeof b === "string") {
    const ca = hex(a).map(toLin);
    const cb = hex(b).map(toLin);
    return toHex(ca.map((x, i) => fromLin(x + (cb[i] - x) * p)));
  }
  if (kind === "path") {
    // point by point; two outlines with a different number of points cannot blend, so the first one holds until the next key
    if (!Array.isArray(a) || !Array.isArray(b)) return Array.isArray(a) ? a : Array.isArray(b) ? b : [];
    if (a.length !== b.length) return a;
    return a.map((q, i) => [q[0] + (b[i][0] - q[0]) * p, q[1] + (b[i][1] - q[1]) * p] as [number, number]);
  }
  if (kind === "point" && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b) && a && b) return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
  const na = typeof a === "number" ? a : 0;
  const nb = typeof b === "number" ? b : 0;
  if (kind === "angle") {
    let d = ((nb - na) % 360) + 0; // wrap: take the short way round
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return na + d * p;
  }
  return na + (nb - na) * p;
}

export const sortKeys = (keys: Key[]) => [...keys].sort((a, b) => a.t - b.t);

/** Value of a lane at time t (seconds into the clip); `fallback` when the lane is empty. */
export function evalLane(keys: Key[] | undefined, t: number, fallback: KeyValue, kind?: ValueKind): KeyValue {
  if (!keys?.length) return fallback;
  const k = keys.length > 1 && keys.some((x, i) => i && x.t < keys[i - 1].t) ? sortKeys(keys) : keys;
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  let i = 1;
  while (i < k.length && k[i].t <= t) i++;
  const a = k[i - 1];
  const b = k[i];
  const span = b.t - a.t;
  const p = span > 0 ? shape(a, b, (t - a.t) / span) : 1;
  return mix(a.v, b.v, p, kindOfValue(a.v, kind));
}

export const evalNumber = (keys: Key[] | undefined, t: number, fallback: number, kind: "number" | "angle" = "number"): number => {
  const v = evalLane(keys, t, fallback, kind);
  return typeof v === "number" ? v : fallback;
};

/* ---------- editing lanes (pure) ---------- */

export const SAME_T = 0.02;

/** Set a key at t (replacing one within SAME_T). Keeps the existing key's shape when replacing. */
export function setKey(keys: Key[] | undefined, t: number, v: KeyValue, defaults: Partial<Key> = { mode: "ease", easing: "ease-in-out" }): Key[] {
  const tt = Math.max(0, Math.round(t * 1000) / 1000);
  const old = (keys ?? []).find((k) => Math.abs(k.t - tt) <= SAME_T);
  return sortKeys([...(keys ?? []).filter((k) => k !== old), { ...(old ?? defaults), t: tt, v }]);
}

export const removeKeyAt = (keys: Key[], t: number) => keys.filter((k) => Math.abs(k.t - t) > SAME_T);

/** Move keys in time by dt (keeping order; keys cannot go before 0). */
export function shiftKeys(keys: Key[], which: (k: Key) => boolean, dt: number): Key[] {
  const min = Math.min(...keys.filter(which).map((k) => k.t));
  const d = Math.max(dt, -min);
  return sortKeys(keys.map((k) => (which(k) ? { ...k, t: Math.round((k.t + d) * 1000) / 1000 } : k)));
}

/** Apply an ease preset (or hold / linear / bezier) to the given keys. */
export function setShape(keys: Key[], which: (k: Key) => boolean, mode: KeyMode, easing?: EaseName): Key[] {
  return keys.map((k) => {
    if (!which(k)) return k;
    const next: Key = { ...k, mode };
    if (mode === "ease") next.easing = easing ?? "ease-in-out";
    else delete next.easing;
    if (mode === "bezier") {
      next.out = k.out ?? [0.33, 0.33];
      next.in = k.in ?? [0.33, 0.33];
    } else {
      delete next.out;
      delete next.in;
    }
    return next;
  });
}

/**
 * Keys copied from one clip to another: `t` is kept relative to each clip's start, so pasted keys land at the same
 * offsets inside the destination clip (clipped to its length when `clipDuration` is given).
 */
export function pasteKeys(into: Key[] | undefined, copied: Key[], clipDuration?: number, atOffset = 0): Key[] {
  let out = into ?? [];
  for (const k of copied) {
    const t = k.t + atOffset;
    if (clipDuration !== undefined && t > clipDuration + 1e-6) continue;
    out = setKey(out, t, k.v, k);
  }
  return out;
}

/** Older effect keys ({ t, v, easing }) read as ease keys; nothing to convert. */
export const isKey = (x: unknown): x is Key => !!x && typeof x === "object" && typeof (x as Key).t === "number" && (x as Key).v !== undefined;
