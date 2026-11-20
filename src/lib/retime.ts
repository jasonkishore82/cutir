/**
 * Retiming (phase 23): the mapping between time on the timeline and time in the source. Pure functions, used by the
 * compositor, the audio mix, the editing engine and the tests.
 *
 *   constant speed:  source = in + rel * speed
 *   speed ramp:      source = in + the integral of the speed curve from 0 to rel
 *   reverse:         the same, counted back from the clip's source out point
 */

export const MIN_SPEED = 0.01;
export const MAX_SPEED = 100;
export const clampSpeed = (s: number) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number.isFinite(s) ? s : 1));

/** Speed at points of the clip (rel seconds from its start); between points the speed is interpolated. */
export type RampKey = { t: number; speed: number };
export type Ramp = { keys: RampKey[]; /** Smooth in and out between keys instead of straight lines. */ ease: boolean };

type Retimed = { sourceIn: number; sourceOut: number; speed: number; duration: number; reverse?: boolean; ramp?: Ramp };

const smooth = (x: number) => x * x * (3 - 2 * x);

const sorted = (r: Ramp) => [...r.keys].sort((a, b) => a.t - b.t);

/** The speed of a ramp at rel seconds into the clip (held before the first and after the last key). */
export function speedAt(r: Ramp, rel: number): number {
  const k = sorted(r);
  if (!k.length) return 1;
  if (rel <= k[0].t) return k[0].speed;
  if (rel >= k[k.length - 1].t) return k[k.length - 1].speed;
  for (let i = 1; i < k.length; i++) {
    if (rel <= k[i].t) {
      const f = (rel - k[i - 1].t) / (k[i].t - k[i - 1].t || 1);
      return k[i - 1].speed + (k[i].speed - k[i - 1].speed) * (r.ease ? smooth(f) : f);
    }
  }
  return k[k.length - 1].speed;
}

/** Seconds of source passed after rel seconds of a ramped clip: the integral of the speed. */
export function rampIntegral(r: Ramp, rel: number): number {
  if (rel <= 0) return 0;
  const k = sorted(r);
  if (!k.length) return rel;
  // integrate piece by piece: before the first key, between keys, after the last key
  const edges = [0, ...k.map((x) => x.t).filter((t) => t > 0 && t < rel), rel];
  let sum = 0;
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1];
    const b = edges[i];
    // Simpson's rule over each piece (exact for straight segments, very close for the eased ones)
    const n = 16;
    const h = (b - a) / n;
    let s = speedAt(r, a) + speedAt(r, b);
    for (let j = 1; j < n; j++) s += speedAt(r, a + j * h) * (j % 2 ? 4 : 2);
    sum += (s * h) / 3;
  }
  return sum;
}

/** Source time shown rel seconds into a clip. */
export function sourceAtRel(c: Retimed, rel: number): number {
  const travelled = c.ramp?.keys.length ? rampIntegral(c.ramp, rel) : rel * c.speed;
  return c.reverse ? c.sourceOut - travelled : c.sourceIn + travelled;
}

/** The source time the clip ends on, when its source range is set by its duration (after the speed changed). */
export const rampSourceSpan = (r: Ramp, duration: number) => rampIntegral(r, duration);

/** Instantaneous speed of a clip at rel (what the audio plays at). */
export const speedOf = (c: Pick<Retimed, "speed" | "ramp">, rel: number) => (c.ramp?.keys.length ? speedAt(c.ramp, rel) : c.speed);

/** Preset ramps for a clip of `duration` seconds. */
export const RAMP_PRESETS: { id: string; name: string; make: (duration: number, base: number) => Ramp }[] = [
  { id: "ease-in", name: "Slow, then normal", make: (d, b) => ({ ease: true, keys: [{ t: 0, speed: 0.25 * b }, { t: d, speed: b }] }) },
  { id: "ease-out", name: "Normal, then slow", make: (d, b) => ({ ease: true, keys: [{ t: 0, speed: b }, { t: d, speed: 0.25 * b }] }) },
  { id: "speed-up", name: "Speed up", make: (d, b) => ({ ease: true, keys: [{ t: 0, speed: b }, { t: d, speed: 4 * b }] }) },
  { id: "pulse", name: "Slow in the middle", make: (d, b) => ({ ease: true, keys: [{ t: 0, speed: b }, { t: d * 0.4, speed: 0.2 * b }, { t: d * 0.6, speed: 0.2 * b }, { t: d, speed: b }] }) },
];

/** Split a ramp at `rel`: keys for the left part and the right part (the right one re-based to start at 0). */
export function splitRamp(r: Ramp, rel: number): [Ramp, Ramp] {
  const mid = speedAt(r, rel);
  const k = sorted(r);
  const left = [...k.filter((x) => x.t < rel), { t: rel, speed: mid }];
  const right = [{ t: 0, speed: mid }, ...k.filter((x) => x.t > rel).map((x) => ({ t: x.t - rel, speed: x.speed }))];
  return [{ ...r, keys: left }, { ...r, keys: right }];
}

/** Shift a ramp so it starts `d` seconds later in the clip (the head was trimmed by d). */
export function trimRampHead(r: Ramp, d: number): Ramp {
  const start = speedAt(r, d);
  return { ...r, keys: [{ t: 0, speed: start }, ...sorted(r).filter((x) => x.t > d).map((x) => ({ t: x.t - d, speed: x.speed }))] };
}

/* ---------- frame blending ---------- */

/** The two source frames around a source time and the weight of the later one, for blended slow motion. */
export function blendFrames(st: number, fps: number): { a: number; b: number; w: number } {
  if (!(fps > 0)) return { a: st, b: st, w: 0 };
  const f = st * fps;
  const i = Math.floor(f + 1e-6);
  const w = Math.max(0, Math.min(1, f - i));
  return { a: i / fps, b: (i + 1) / fps, w: w < 0.02 ? 0 : w };
}

/* ---------- pitch-preserving time stretch ---------- */

/**
 * Change the length of audio without changing its pitch (waveform-similarity overlap-add). `ratio` is the new
 * length over the old: 2 makes it twice as long (half speed), 0.5 half as long (double speed).
 */
export function timeStretch(ch: Float32Array[], ratio: number, sr: number): Float32Array[] {
  const n = ch[0]?.length ?? 0;
  if (!n || Math.abs(ratio - 1) < 1e-3) return ch.map((c) => Float32Array.from(c));
  const win = Math.max(256, Math.round(sr * 0.04) & ~1); // 40 ms windows
  const hopOut = win / 2;
  const hopIn = hopOut / ratio;
  const seek = Math.round(win / 4);
  const outLen = Math.max(1, Math.round(n * ratio));
  const out = ch.map(() => new Float32Array(outLen + win));
  const norm = new Float32Array(outLen + win);
  const hann = Float32Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
  const mono = (i: number) => {
    let s = 0;
    for (const c of ch) s += c[i] ?? 0;
    return s / ch.length;
  };
  let prevStart = 0;
  for (let o = 0, k = 0; o < outLen; o += hopOut, k++) {
    const ideal = Math.round(k * hopIn);
    let start = Math.min(Math.max(0, ideal), Math.max(0, n - 1));
    if (k > 0) {
      // pick the offset near `ideal` where the window best continues the previous one (the natural next block of the last window)
      const want = prevStart + hopOut;
      let best = -Infinity;
      for (let d = -seek; d <= seek; d += 4) {
        const s = ideal + d;
        if (s < 0 || s + win > n) continue;
        let corr = 0;
        for (let i = 0; i < win; i += 8) corr += mono(want + i) * mono(s + i);
        if (corr > best) (best = corr), (start = s);
      }
    }
    prevStart = start;
    for (let c = 0; c < ch.length; c++) for (let i = 0; i < win; i++) out[c][o + i] += (ch[c][start + i] ?? 0) * hann[i];
    for (let i = 0; i < win; i++) norm[o + i] += hann[i];
  }
  return out.map((c) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? c[i] / norm[i] : 0;
    return r;
  });
}
