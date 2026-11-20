import type { EnergyCurve } from "../store/project";

/**
 * Song analysis DSP (phase 16.5): onset envelope, tempo, beat tracking, downbeats and the loudness (energy) curve.
 * Pure functions on mono samples, no Web Audio, so they run in a worker and in node tests alike. The browser fallback
 * of beat detection (beats.worker.ts) calls `analyzeSamples`; the backend does the same steps with librosa.
 */

/** Sample rate the browser decodes songs at before analysis (plenty for rhythm, a quarter of the work of 44.1k). */
export const ANALYSIS_RATE = 22050;
/** Values per second of the energy curve. */
export const ENERGY_RATE = 20;

export type SampleAnalysis = {
  tempo: number;
  firstDownbeat: number;
  beatsPerBar: number;
  beats: { time: number; downbeat: boolean; strength: number }[];
  energy: EnergyCurve;
};

type Progress = (pct: number) => void;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/* ---------- FFT ---------- */

/** In-place radix-2 FFT of length n (a power of two). */
function makeFft(n: number) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  return (re: Float64Array, im: Float64Array) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  };
}

/* ---------- onset envelope ---------- */

export type Onsets = {
  /** Spectral flux per frame (sudden rises in energy across the spectrum). */
  env: Float32Array;
  /** The same below ~200 Hz (kick and bass), used to find downbeats. */
  low: Float32Array;
  /** Frames per second. */
  fps: number;
};

const NFFT = 1024;
const HOP = 256;

/**
 * Spectral-flux onset envelope: centred Hann frames grouped into quarter-octave bands (so the few bass bins count as
 * much as the many treble ones, like a mel spectrum), log-compressed, summing only the bands that got louder since
 * the previous frame.
 */
export function onsetEnvelope(samples: Float32Array, sr: number, onProgress?: Progress): Onsets {
  const frames = Math.floor(samples.length / HOP) + 1;
  const fft = makeFft(NFFT);
  const win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
  const bins = NFFT / 2 + 1;
  // band of each bin: quarter octaves from 30 Hz; bins below 30 Hz are ignored
  const bandOf = new Int32Array(bins).fill(-1);
  let bands = 0;
  for (let k = 1; k < bins; k++) {
    const hz = (k * sr) / NFFT;
    if (hz < 30) continue;
    bandOf[k] = Math.floor(4 * Math.log2(hz / 30));
    bands = Math.max(bands, bandOf[k] + 1);
  }
  const lowBands = Math.ceil(4 * Math.log2(200 / 30));
  const count = new Float64Array(bands);
  for (let k = 0; k < bins; k++) if (bandOf[k] >= 0) count[bandOf[k]]++;
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  let prev = new Float64Array(bands);
  let cur = new Float64Array(bands);
  const env = new Float32Array(frames);
  const low = new Float32Array(frames);
  const tick = Math.max(1, Math.floor(frames / 20));
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - NFFT / 2;
    for (let i = 0; i < NFFT; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    cur.fill(0);
    for (let k = 0; k < bins; k++) if (bandOf[k] >= 0) cur[bandOf[k]] += re[k] * re[k] + im[k] * im[k];
    let flux = 0;
    let lowFlux = 0;
    for (let b = 0; b < bands; b++) {
      cur[b] = Math.log1p(10 * Math.sqrt(cur[b] / (count[b] || 1)));
      const d = cur[b] - prev[b];
      if (d > 0 && f > 0) {
        flux += d;
        if (b < lowBands) lowFlux += d;
      }
    }
    env[f] = flux;
    low[f] = lowFlux;
    const t = prev;
    prev = cur;
    cur = t;
    if (onProgress && f % tick === 0) onProgress(f / frames);
  }
  return { env, low, fps: sr / HOP };
}

/**
 * How far the flux peak of a sharp hit lands before the hit itself, in seconds: the Hann window starts hearing a hit
 * before the frame centre reaches it. Measured on click tracks; added to beat times.
 */
const ONSET_LEAD = 0.011;

/* ---------- tempo ---------- */

/** Width of the tempo preference around 120 BPM, in octaves. */
const TEMPO_SPREAD = 0.8;

/** Linear interpolation into an array at a fractional index. */
const lerpAt = (a: Float64Array, x: number) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= a.length) return 0;
  return a[i] + (a[i + 1] - a[i]) * (x - i);
};

/**
 * Tempo from the autocorrelation of the onset envelope, searched over 60..200 BPM. Each candidate period scores the
 * correlation at 1x..4x its length (a true beat repeats at every multiple, which keeps the half and double tempo from
 * winning on strong kicks or busy hi-hats), weighted by a log-normal preference centred on 120 BPM (so 80..160 wins
 * over its half or double). Returns the beat period in frames (fractional).
 */
export function estimatePeriod(env: Float32Array, fps: number): number {
  const n = env.length;
  // smooth a little so sharp peaks still correlate at fractional lags
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) e[i] = 0.25 * (env[i - 1] ?? env[i]) + 0.5 * env[i] + 0.25 * (env[i + 1] ?? env[i]);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += e[i];
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) e[i] -= mean;
  const minLag = Math.max(1, Math.floor((fps * 60) / 200));
  const maxLag = Math.ceil((fps * 60) / 60);
  const H = 4;
  const top = Math.min(n - 2, H * maxLag + 2);
  if (top <= minLag + 2) return (fps * 60) / 120;
  const ac = new Float64Array(top + 1);
  for (let lag = 1; lag <= top; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
    ac[lag] = s / (n - lag);
  }
  // candidate periods in quarter frames
  const score = (L: number) => {
    let s = 0;
    for (let h = 1; h <= H; h++) s += lerpAt(ac, h * L);
    const bpm = (fps * 60) / L;
    return (s / H) * Math.exp(-0.5 * (Math.log2(bpm / 120) / TEMPO_SPREAD) ** 2);
  };
  let best = (fps * 60) / 120;
  let bestScore = -Infinity;
  for (let L = minLag; L <= Math.min(maxLag, top / H); L += 0.25) {
    const sc = score(L);
    if (sc > bestScore) (bestScore = sc), (best = L);
  }
  // refine to a hundredth of a frame
  for (let L = best - 0.25; L <= best + 0.25; L += 0.01) {
    const sc = score(L);
    if (sc > bestScore) (bestScore = sc), (best = L);
  }
  return best;
}

/* ---------- beat tracking ---------- */

/**
 * Dynamic-programming beat tracker (Ellis 2007): every frame's best score is its own onset strength plus the best
 * earlier beat one period back, penalised by how far the gap strays from the period. Backtracking from the strongest
 * late beat gives a steady but flexible beat sequence. Returns beat frames, weak beats trimmed at both ends.
 */
export function trackBeats(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  if (n < 4 || !(period > 1)) return [];
  // normalise by the standard deviation and smooth with a narrow Gaussian (as librosa does)
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (env[i] - mean) ** 2;
  const sd = Math.sqrt(v / n) || 1;
  const half = Math.max(1, Math.round(period / 16));
  const kern: number[] = [];
  for (let k = -half; k <= half; k++) kern.push(Math.exp(-0.5 * ((k * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += (env[j] / sd) * kern[k + half];
    }
    local[i] = s;
  }

  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(2 * period);
  const hi = Math.max(1, Math.round(period / 2));
  // transition penalties by gap length, computed once
  const pen = new Float64Array(lo + 1);
  for (let g = hi; g <= lo; g++) pen[g] = -tightness * Math.log(g / period) ** 2;
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let g = hi; g <= lo && t - g >= 0; g++) {
      const s = score[t - g] + pen[g];
      if (s > best) (best = s), (arg = t - g);
    }
    // a beat with no worthwhile beat before it starts a new sequence (the first hit after silence)
    if (arg >= 0 && best > 0) {
      score[t] = local[t] + best;
      back[t] = arg;
    } else score[t] = local[t];
  }

  // the last beat: the latest local maximum of the score that is at least half the median of those maxima
  const peaks: number[] = [];
  for (let t = 1; t < n - 1; t++) if (score[t] > score[t - 1] && score[t] >= score[t + 1]) peaks.push(t);
  if (!peaks.length) return [];
  const sorted = peaks.map((p) => score[p]).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let last = peaks[peaks.length - 1];
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (score[peaks[i]] >= 0.5 * med) {
      last = peaks[i];
      break;
    }
  }
  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();

  // trim weak beats (silence, or only a noise floor) at the start and end
  if (beats.length) {
    const floor = [...local].sort((a, b) => a - b)[Math.floor(n / 2)];
    const over = (b: number) => local[b] - floor;
    let ms = 0;
    for (const b of beats) ms += Math.max(0, over(b)) ** 2;
    const thr = 0.2 * Math.sqrt(ms / beats.length);
    let s = 0;
    let e = beats.length;
    while (s < e && over(beats[s]) < thr) s++;
    while (e > s && over(beats[e - 1]) < thr) e--;
    const kept = beats.slice(s, e);
    // the tracker can end a sequence one beat early; take a clear hit one period beyond either end
    const near = (c: number) => {
      const w = Math.max(1, Math.round(period / 8));
      let best = -1;
      for (let t = Math.round(c) - w; t <= Math.round(c) + w; t++) if (t >= 0 && t < n && over(t) >= thr && (best < 0 || local[t] > local[best])) best = t;
      return best;
    };
    for (let t; kept.length && (t = near(kept[0] - period)) >= 0 && t < kept[0] - period / 2; ) kept.unshift(t);
    for (let t; kept.length && (t = near(kept[kept.length - 1] + period)) >= 0 && t > kept[kept.length - 1] + period / 2; ) kept.push(t);
    return kept;
  }
  return beats;
}

/** A beat frame moved to the onset peak within one frame, with sub-frame (parabolic) precision. */
function refine(env: Float32Array, b: number): number {
  let p = b;
  for (let k = -1; k <= 1; k++) if (b + k >= 0 && b + k < env.length && env[b + k] > env[p]) p = b + k;
  if (p <= 0 || p >= env.length - 1) return p;
  const a = env[p - 1];
  const c = env[p + 1];
  const den = a - 2 * env[p] + c;
  const off = den < 0 ? (0.5 * (a - c)) / den : 0;
  return p + Math.max(-0.5, Math.min(0.5, off));
}

/**
 * Which beat of the bar is the downbeat: the phase (0..beatsPerBar-1) whose beats carry the most onset strength,
 * counting kick / bass hits twice since they usually mark the start of a bar.
 */
export function downbeatPhase(strengths: number[], lowStrengths: number[], beatsPerBar: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < beatsPerBar; k++) {
    let s = 0;
    let c = 0;
    for (let i = k; i < strengths.length; i += beatsPerBar) (s += strengths[i] + 2 * (lowStrengths[i] ?? 0)), c++;
    const score = c ? s / c : 0;
    if (score > bestScore + 1e-9) (bestScore = score), (best = k);
  }
  return best;
}

/** Scale values to 0..1 by their 95th percentile (one huge hit does not flatten the rest). */
function normalise(vals: number[], pct = 0.95): number[] {
  if (!vals.length) return [];
  const sorted = [...vals].sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(pct * (sorted.length - 1)))] || sorted[sorted.length - 1] || 1;
  return vals.map((v) => round3(Math.max(0, Math.min(1, v / ref))));
}

/** Tempo in BPM from beat times: least-squares slope of time against beat number. */
export function tempoOf(times: number[]): number {
  const n = times.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = times.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) (num += (i - mx) * (times[i] - my)), (den += (i - mx) ** 2);
  const slope = num / den;
  return slope > 0 ? 60 / slope : 0;
}

/* ---------- energy ---------- */

/** RMS loudness at `rate` values per second (windows twice the step, centred), normalised 0..1. */
export function energyCurve(samples: Float32Array, sr: number, rate = ENERGY_RATE): EnergyCurve {
  const step = sr / rate;
  const count = Math.max(1, Math.ceil(samples.length / step));
  const raw: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = i * step;
    const a = Math.max(0, Math.floor(c - step));
    const b = Math.min(samples.length, Math.floor(c + step));
    let s = 0;
    for (let j = a; j < b; j++) s += samples[j] * samples[j];
    raw.push(b > a ? Math.sqrt(s / (b - a)) : 0);
  }
  return { rate, values: normalise(raw, 0.99) };
}

/** The energy at time `t` (seconds), linearly interpolated; 0 outside the curve or without one. */
export function energyAt(curve: EnergyCurve | undefined, t: number): number {
  if (!curve || !curve.values.length || !(t >= 0)) return 0;
  const x = t * curve.rate;
  const i = Math.floor(x);
  if (i >= curve.values.length - 1) return i === curve.values.length - 1 ? curve.values[i] : 0;
  const f = x - i;
  return curve.values[i] * (1 - f) + curve.values[i + 1] * f;
}

/* ---------- all together ---------- */

/** Full analysis of a mono song: beats with downbeats and strength, tempo, and the energy curve. */
export function analyzeSamples(samples: Float32Array, sr: number, onProgress?: Progress, beatsPerBar = 4): SampleAnalysis {
  const { env, low, fps } = onsetEnvelope(samples, sr, onProgress && ((p) => onProgress(p * 0.8)));
  const period = estimatePeriod(env, fps);
  onProgress?.(0.85);
  const frames = trackBeats(env, period);
  onProgress?.(0.92);
  const at = (arr: Float32Array, f: number) => Math.max(arr[f] ?? 0, arr[f - 1] ?? 0, arr[f + 1] ?? 0);
  const strengths = normalise(frames.map((f) => at(env, f)));
  const lows = normalise(frames.map((f) => at(low, f)));
  const phase = downbeatPhase(strengths, lows, beatsPerBar);
  const beats = frames.map((f, i) => ({
    time: round3(Math.max(0, refine(env, f) / fps + ONSET_LEAD)),
    downbeat: (i - phase) % beatsPerBar === 0,
    strength: strengths[i],
  }));
  const tempo = beats.length >= 2 ? tempoOf(beats.map((b) => b.time)) : (60 * fps) / period;
  const energy = energyCurve(samples, sr);
  onProgress?.(1);
  return {
    tempo: Math.round(tempo * 100) / 100,
    firstDownbeat: beats.find((b) => b.downbeat)?.time ?? 0,
    beatsPerBar,
    beats,
    energy,
  };
}
