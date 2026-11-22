/**
 * Audio processors (phase 21): pure functions on Float32Array channels, shared by the export mix, the loudness
 * meter and the tests. Nothing here touches Web Audio, so it behaves the same in the browser and under node.
 */

export type Channels = Float32Array[];
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g <= 1e-9 ? -180 : 20 * Math.log10(g));

/* ---------- biquad filters (RBJ cookbook) ---------- */

export type BiquadType = "lowpass" | "highpass" | "peaking" | "lowshelf" | "highshelf" | "notch";
export type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

export function biquad(type: BiquadType, sr: number, freq: number, q = 0.707, gainDb = 0): Biquad {
  const f = Math.min(Math.max(freq, 10), sr * 0.49);
  const w = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sin / (2 * Math.max(0.05, q));
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case "lowpass": b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case "highpass": b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case "notch": b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case "peaking": b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
    case "lowshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case "highshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Run a biquad over one channel in place (direct form 2 transposed). */
export function runBiquad(x: Float32Array, c: Biquad): void {
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = c.b0 * v + z1;
    z1 = c.b1 * v - c.a1 * y + z2;
    z2 = c.b2 * v - c.a2 * y;
    x[i] = y;
  }
}

/** Magnitude of a biquad at a frequency, in dB (for drawing the EQ curve and for tests). */
export function biquadResponseDb(c: Biquad, sr: number, freq: number): number {
  const w = (2 * Math.PI * freq) / sr;
  const cr = Math.cos(w), ci = -Math.sin(w), c2r = Math.cos(2 * w), c2i = -Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cr + c.b2 * c2r, ni = c.b1 * ci + c.b2 * c2i;
  const dr = 1 + c.a1 * cr + c.a2 * c2r, di = c.a1 * ci + c.a2 * c2i;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/* ---------- processors ---------- */

export type ProcessorType = "eq" | "highpass" | "lowpass" | "compressor" | "limiter" | "gate" | "deesser" | "denoise" | "reverb" | "delay";
export type AudioProcessor = { id: string; type: ProcessorType; enabled: boolean; params: Record<string, number> };

export type ProcessorSpec = { key: string; label: string; min: number; max: number; default: number; unit?: string };
const spec = (key: string, label: string, min: number, max: number, def: number, unit?: string): ProcessorSpec => ({ key, label, min, max, default: def, unit });

export const PROCESSORS: Record<ProcessorType, { name: string; description: string; params: ProcessorSpec[]; /** Also heard live in the viewer (the rest is applied in the export and the loudness render). */ live: boolean }> = {
  eq: { name: "Parametric EQ", description: "Low shelf, two peaking bands and a high shelf", live: true, params: [
    spec("lowGain", "Low shelf gain", -18, 18, 0, "dB"), spec("lowFreq", "Low shelf freq", 30, 500, 120, "Hz"),
    spec("m1Gain", "Mid 1 gain", -18, 18, 0, "dB"), spec("m1Freq", "Mid 1 freq", 100, 3000, 500, "Hz"), spec("m1Q", "Mid 1 Q", 0.2, 8, 1),
    spec("m2Gain", "Mid 2 gain", -18, 18, 0, "dB"), spec("m2Freq", "Mid 2 freq", 500, 12000, 3000, "Hz"), spec("m2Q", "Mid 2 Q", 0.2, 8, 1),
    spec("highGain", "High shelf gain", -18, 18, 0, "dB"), spec("highFreq", "High shelf freq", 2000, 16000, 8000, "Hz") ] },
  highpass: { name: "High pass", description: "Remove rumble below a frequency", live: true, params: [spec("freq", "Frequency", 20, 1000, 80, "Hz")] },
  lowpass: { name: "Low pass", description: "Remove hiss above a frequency", live: true, params: [spec("freq", "Frequency", 1000, 20000, 12000, "Hz")] },
  compressor: { name: "Compressor", description: "Even out loud and quiet parts", live: true, params: [
    spec("threshold", "Threshold", -60, 0, -20, "dB"), spec("ratio", "Ratio", 1, 20, 3),
    spec("attack", "Attack", 1, 200, 10, "ms"), spec("release", "Release", 20, 1000, 150, "ms"),
    spec("knee", "Knee", 0, 30, 6, "dB"), spec("makeup", "Make-up gain", 0, 24, 0, "dB") ] },
  limiter: { name: "Limiter", description: "Stop peaks above a ceiling", live: true, params: [spec("ceiling", "Ceiling", -12, 0, -1, "dB"), spec("release", "Release", 10, 500, 80, "ms")] },
  gate: { name: "Noise gate", description: "Silence the track below a level", live: true, params: [
    spec("threshold", "Threshold", -80, -10, -50, "dB"), spec("range", "Reduction", 0, 80, 60, "dB"),
    spec("attack", "Attack", 1, 100, 5, "ms"), spec("release", "Release", 10, 1000, 120, "ms") ] },
  deesser: { name: "De-esser", description: "Tame harsh s sounds", live: true, params: [
    spec("freq", "Frequency", 3000, 10000, 6500, "Hz"), spec("threshold", "Threshold", -50, 0, -28, "dB"), spec("ratio", "Ratio", 1, 10, 4) ] },
  denoise: { name: "Noise reduction", description: "Lower steady background noise between words", live: true, params: [
    spec("amount", "Amount", 0, 30, 12, "dB"), spec("sensitivity", "Noise floor margin", 0, 20, 6, "dB") ] },
  reverb: { name: "Reverb", description: "Room ambience", live: true, params: [
    spec("size", "Room size", 0, 100, 50, "%"), spec("damping", "Damping", 0, 100, 50, "%"), spec("mix", "Mix", 0, 100, 25, "%") ] },
  delay: { name: "Delay", description: "Repeating echo", live: true, params: [
    spec("time", "Time", 20, 1500, 350, "ms"), spec("feedback", "Feedback", 0, 90, 35, "%"), spec("mix", "Mix", 0, 100, 25, "%") ] },
};

export const processorDefaults = (t: ProcessorType): Record<string, number> => Object.fromEntries(PROCESSORS[t].params.map((p) => [p.key, p.default]));

const pv = (p: AudioProcessor, k: string) => p.params[k] ?? PROCESSORS[p.type].params.find((s) => s.key === k)?.default ?? 0;

/** The biquads an EQ, high pass or low pass processor is made of (also used to build the live Web Audio nodes). */
export function filterBands(p: AudioProcessor, sr: number): { type: BiquadType; freq: number; q: number; gain: number; coef: Biquad }[] {
  const mk = (type: BiquadType, freq: number, q: number, gain: number) => ({ type, freq, q, gain, coef: biquad(type, sr, freq, q, gain) });
  if (p.type === "highpass") return [mk("highpass", pv(p, "freq"), 0.707, 0)];
  if (p.type === "lowpass") return [mk("lowpass", pv(p, "freq"), 0.707, 0)];
  if (p.type !== "eq") return [];
  const out = [];
  if (pv(p, "lowGain")) out.push(mk("lowshelf", pv(p, "lowFreq"), 0.707, pv(p, "lowGain")));
  if (pv(p, "m1Gain")) out.push(mk("peaking", pv(p, "m1Freq"), pv(p, "m1Q"), pv(p, "m1Gain")));
  if (pv(p, "m2Gain")) out.push(mk("peaking", pv(p, "m2Freq"), pv(p, "m2Q"), pv(p, "m2Gain")));
  if (pv(p, "highGain")) out.push(mk("highshelf", pv(p, "highFreq"), 0.707, pv(p, "highGain")));
  return out;
}

/** Static compressor curve: output level in dB for an input level in dB (soft knee). */
export function compressorCurveDb(inDb: number, threshold: number, ratio: number, knee: number): number {
  const over = inDb - threshold;
  const slope = 1 / Math.max(1, ratio) - 1;
  if (knee > 0 && Math.abs(over) <= knee / 2) return inDb + (slope * (over + knee / 2) ** 2) / (2 * knee);
  return over > 0 ? inDb + slope * over : inDb;
}

const coef = (ms: number, sr: number) => Math.exp(-1 / Math.max(1, (ms / 1000) * sr));

/** Linked-stereo dynamics: a gain computer driven by the louder channel's level (optionally from a sidechain). */
function dynamics(ch: Channels, sr: number, gainDbAt: (levelDb: number) => number, attackMs: number, releaseMs: number, side?: Channels): void {
  const n = ch[0].length;
  const src = side ?? ch;
  const a = coef(attackMs, sr);
  const r = coef(releaseMs, sr);
  const hold = coef(10, sr); // the level detector falls over about 10 ms, so a sine's zero crossings do not read as silence
  let env = 0; // smoothed gain change in dB (<= 0)
  let det = 0;
  for (let i = 0; i < n; i++) {
    let inst = 0;
    for (const c of src) inst = Math.max(inst, Math.abs(c[i]));
    det = Math.max(inst, det * hold);
    const lvl = det;
    const target = gainDbAt(gainToDb(lvl));
    env = target < env ? a * env + (1 - a) * target : r * env + (1 - r) * target;
    const g = dbToGain(env);
    for (const c of ch) c[i] *= g;
  }
}

/** Compressor (in place). */
export function compress(ch: Channels, sr: number, o: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }): void {
  dynamics(ch, sr, (l) => compressorCurveDb(l, o.threshold, o.ratio, o.knee) - l, o.attack, o.release);
  const m = dbToGain(o.makeup);
  if (m !== 1) for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= m;
}

/** Limiter: instant attack, smooth release, so no sample passes the ceiling. */
export function limit(ch: Channels, sr: number, ceilingDb: number, releaseMs = 80): void {
  const ceil = dbToGain(ceilingDb);
  const n = ch[0].length;
  const r = coef(releaseMs, sr);
  let g = 1;
  for (let i = 0; i < n; i++) {
    let lvl = 0;
    for (const c of ch) lvl = Math.max(lvl, Math.abs(c[i]));
    const need = lvl > ceil ? ceil / lvl : 1;
    g = r * g + (1 - r) * need;
    if (g > need) g = need;
    for (const c of ch) c[i] *= g;
  }
}

/** Gate: reduce the track by `range` dB while it is below the threshold. */
export function gate(ch: Channels, sr: number, o: { threshold: number; range: number; attack: number; release: number }): void {
  dynamics(ch, sr, (l) => (l < o.threshold ? -o.range : 0), o.attack, o.release);
}

/** De-esser: reduce gain only while the band above `freq` is loud, using that band as the sidechain. */
export function deess(ch: Channels, sr: number, o: { freq: number; threshold: number; ratio: number }): void {
  const side = ch.map((c) => Float32Array.from(c));
  const hp = biquad("highpass", sr, o.freq, 0.9);
  for (const s of side) runBiquad(s, hp);
  dynamics(ch, sr, (l) => (l > o.threshold ? (o.threshold - l) * (1 - 1 / Math.max(1, o.ratio)) : 0), 1, 60, side);
}

/** Noise reduction: a downward expander whose threshold follows the estimated noise floor (the quietest 10% of 20 ms blocks). */
export function denoise(ch: Channels, sr: number, o: { amount: number; sensitivity: number }): void {
  const block = Math.max(64, Math.floor(sr * 0.02));
  const levels: number[] = [];
  for (let s = 0; s + block <= ch[0].length; s += block) {
    let e = 0;
    for (const c of ch) for (let i = s; i < s + block; i++) e += c[i] * c[i];
    levels.push(gainToDb(Math.sqrt(e / (block * ch.length))));
  }
  if (!levels.length) return;
  const sorted = [...levels].sort((a, b) => a - b);
  const thr = sorted[Math.floor(sorted.length * 0.1)] + o.sensitivity;
  dynamics(ch, sr, (l) => (l < thr ? -o.amount : 0), 10, 120);
}

/** Feedback delay; `mix` is 0..1 wet. */
export function delay(ch: Channels, sr: number, o: { time: number; feedback: number; mix: number }): void {
  const d = Math.max(1, Math.round((o.time / 1000) * sr));
  for (const c of ch) {
    const line = new Float32Array(d);
    let w = 0;
    for (let i = 0; i < c.length; i++) {
      const dry = c[i];
      const wet = line[w];
      line[w] = dry + wet * o.feedback;
      w = (w + 1) % d;
      c[i] = dry * (1 - o.mix * 0.5) + wet * o.mix;
    }
  }
}

/** Reverb: Schroeder comb filters into all-passes, slightly detuned per channel. `size`, `damping` and `mix` are 0..1. */
export function reverb(ch: Channels, sr: number, o: { size: number; damping: number; mix: number }): void {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491];
  const aps = [556, 441, 341];
  ch.forEach((c, ci) => {
    const scale = (sr / 44100) * (0.5 + o.size) * (ci ? 1.03 : 1);
    const fb = 0.7 + o.size * 0.25;
    const damp = 0.05 + o.damping * 0.7;
    const lines = combs.map((d) => ({ buf: new Float32Array(Math.max(1, Math.round(d * scale))), i: 0, lp: 0 }));
    const apl = aps.map((d) => ({ buf: new Float32Array(Math.max(1, Math.round(d * scale))), i: 0 }));
    for (let n = 0; n < c.length; n++) {
      const x = c[n];
      let wet = 0;
      for (const l of lines) {
        const y = l.buf[l.i];
        l.lp = y * (1 - damp) + l.lp * damp;
        l.buf[l.i] = x * 0.15 + l.lp * fb;
        l.i = (l.i + 1) % l.buf.length;
        wet += y;
      }
      for (const a of apl) {
        const y = a.buf[a.i];
        a.buf[a.i] = wet + y * 0.5;
        wet = y - wet * 0.5;
        a.i = (a.i + 1) % a.buf.length;
      }
      c[n] = x * (1 - o.mix * 0.5) + wet * o.mix;
    }
  });
}

/** Apply one processor to channels in place. Disabled processors do nothing. */
export function applyProcessor(ch: Channels, sr: number, p: AudioProcessor): void {
  if (!p.enabled || !ch.length || !ch[0].length) return;
  const v = (k: string) => pv(p, k);
  switch (p.type) {
    case "eq": case "highpass": case "lowpass":
      for (const b of filterBands(p, sr)) for (const c of ch) runBiquad(c, b.coef);
      break;
    case "compressor": compress(ch, sr, { threshold: v("threshold"), ratio: v("ratio"), attack: v("attack"), release: v("release"), knee: v("knee"), makeup: v("makeup") }); break;
    case "limiter": limit(ch, sr, v("ceiling"), v("release")); break;
    case "gate": gate(ch, sr, { threshold: v("threshold"), range: v("range"), attack: v("attack"), release: v("release") }); break;
    case "deesser": deess(ch, sr, { freq: v("freq"), threshold: v("threshold"), ratio: v("ratio") }); break;
    case "denoise": denoise(ch, sr, { amount: v("amount"), sensitivity: v("sensitivity") }); break;
    case "reverb": reverb(ch, sr, { size: v("size") / 100, damping: v("damping") / 100, mix: v("mix") / 100 }); break;
    case "delay": delay(ch, sr, { time: v("time"), feedback: v("feedback") / 100, mix: v("mix") / 100 }); break;
  }
}

export const applyChain = (ch: Channels, sr: number, chain: AudioProcessor[] | undefined) => {
  for (const p of chain ?? []) applyProcessor(ch, sr, p);
};

/* ---------- clip editing helpers ---------- */

export const peakOf = (ch: Channels): number => {
  let m = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  return m;
};

/** Gain (linear) that brings the peak to `targetDb`. */
export const normalizeGain = (ch: Channels, targetDb = -1): number => {
  const p = peakOf(ch);
  return p <= 1e-6 ? 1 : dbToGain(targetDb) / p;
};

export const reverseChannels = (ch: Channels): void => {
  for (const c of ch) c.reverse();
};

/** Fade-in and fade-out ramps over a clip's own samples (seconds each, equal power). */
export function applyFades(ch: Channels, sr: number, fadeIn: number, fadeOut: number): void {
  for (const c of ch) {
    const a = Math.min(c.length, Math.round(fadeIn * sr));
    const b = Math.min(c.length, Math.round(fadeOut * sr));
    for (let i = 0; i < a; i++) c[i] *= Math.sin((i / a) * (Math.PI / 2));
    for (let i = 0; i < b; i++) c[c.length - 1 - i] *= Math.sin((i / b) * (Math.PI / 2));
  }
}

/** Stretches of silence as [start, end] seconds: at least `minDuration` long, below `thresholdDb` (20 ms RMS windows). */
export function detectSilence(mono: Float32Array, sr: number, thresholdDb = -45, minDuration = 0.4): [number, number][] {
  const win = Math.max(32, Math.floor(sr * 0.02));
  const total = Math.floor(mono.length / win);
  const out: [number, number][] = [];
  let from = -1;
  for (let w = 0; w <= total; w++) {
    let quiet = false;
    if (w < total) {
      let e = 0;
      for (let i = w * win; i < (w + 1) * win; i++) e += mono[i] * mono[i];
      quiet = gainToDb(Math.sqrt(e / win)) < thresholdDb;
    }
    if (quiet && from < 0) from = w;
    if (!quiet && from >= 0) {
      const s = (from * win) / sr;
      const e = (w * win) / sr;
      if (e - s >= minDuration) out.push([s, e]);
      from = -1;
    }
  }
  return out;
}

/** The ranges to keep when removing `silences` from [0, length], leaving `pad` seconds of room at each cut. */
export function keepRanges(silences: [number, number][], length: number, pad = 0.08): [number, number][] {
  const keep: [number, number][] = [];
  let at = 0;
  for (const [s, e] of silences) {
    const cutS = s + pad;
    const cutE = e - pad;
    if (cutE <= cutS) continue;
    if (cutS > at) keep.push([at, cutS]);
    at = cutE;
  }
  if (at < length) keep.push([at, length]);
  return keep;
}
