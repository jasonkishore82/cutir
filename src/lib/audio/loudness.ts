import { biquad, runBiquad, type Channels } from "./dsp";

/** Loudness measurement after ITU-R BS.1770 / EBU R128 (phase 21). Pure functions on channels. */

/** The K-weighting filter: a high shelf (+4 dB around 1.7 kHz) then a 38 Hz high pass, designed for any sample rate. */
function kWeight(ch: Channels, sr: number): Channels {
  const shelf = biquad("highshelf", sr, 1681.97, 0.7072, 3.9998);
  const hp = biquad("highpass", sr, 38.1355, 0.5003);
  return ch.map((c) => {
    const x = Float32Array.from(c);
    runBiquad(x, shelf);
    runBiquad(x, hp);
    return x;
  });
}

const lufs = (meanSquare: number) => (meanSquare <= 0 ? -Infinity : -0.691 + 10 * Math.log10(meanSquare));

export type Loudness = { integrated: number; shortTermMax: number; momentaryMax: number; range: number; truePeak: number; samplePeak: number };

/** True peak in dBTP: samples 4x oversampled with a cubic (Catmull-Rom) interpolation between neighbours. */
export function truePeakDb(ch: Channels): number {
  let peak = 0;
  for (const c of ch) {
    for (const v of c) peak = Math.max(peak, Math.abs(v));
    for (let i = 1; i < c.length - 2; i++) {
      const p0 = c[i - 1], p1 = c[i], p2 = c[i + 1], p3 = c[i + 2];
      for (let f = 1; f < 4; f++) {
        const t = f / 4;
        const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
        peak = Math.max(peak, Math.abs(v));
      }
    }
  }
  return 20 * Math.log10(Math.max(1e-9, peak));
}

/** Integrated loudness (gated), short-term and momentary maxima, loudness range and true peak, in LUFS / dB. */
export function measureLoudness(ch: Channels, sr: number): Loudness {
  const n = ch[0]?.length ?? 0;
  if (!n) return { integrated: -Infinity, shortTermMax: -Infinity, momentaryMax: -Infinity, range: 0, truePeak: -Infinity, samplePeak: -Infinity };
  const k = kWeight(ch, sr);
  // mean square per 100 ms step (channels summed); momentary = 4 steps (400 ms), short-term = 30 steps (3 s)
  const step = Math.floor(sr * 0.1);
  const steps = Math.floor(n / step);
  const ms: number[] = [];
  for (let s = 0; s < steps; s++) {
    let e = 0;
    for (const c of k) for (let i = s * step; i < (s + 1) * step; i++) e += c[i] * c[i];
    ms.push(e / step);
  }
  const windows = (len: number) => {
    const out: number[] = [];
    for (let i = 0; i + len <= ms.length; i++) out.push(ms.slice(i, i + len).reduce((a, b) => a + b, 0) / len);
    return out;
  };
  const mom = windows(4);
  const short = windows(30);
  // integrated: absolute gate at -70 LUFS, then a relative gate 10 LU under the mean of what passed
  let integrated = -Infinity;
  const abs = mom.filter((m) => lufs(m) > -70);
  if (abs.length) {
    const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const kept = abs.filter((m) => lufs(m) > rel);
    if (kept.length) integrated = lufs(kept.reduce((a, b) => a + b, 0) / kept.length);
  }
  // loudness range: 10th to 95th percentile of short-term values, with a relative gate 20 LU under their mean
  let range = 0;
  const sAbs = short.filter((m) => lufs(m) > -70);
  if (sAbs.length) {
    const mean = lufs(sAbs.reduce((a, b) => a + b, 0) / sAbs.length);
    const g = sAbs.map(lufs).filter((v) => v > mean - 20).sort((a, b) => a - b);
    if (g.length) range = g[Math.floor((g.length - 1) * 0.95)] - g[Math.floor((g.length - 1) * 0.1)];
  }
  let samplePeak = 0;
  for (const c of ch) for (const v of c) samplePeak = Math.max(samplePeak, Math.abs(v));
  return {
    integrated,
    shortTermMax: short.length ? lufs(Math.max(...short)) : integrated,
    momentaryMax: mom.length ? lufs(Math.max(...mom)) : integrated,
    range,
    truePeak: truePeakDb(ch),
    samplePeak: 20 * Math.log10(Math.max(1e-9, samplePeak)),
  };
}

/** Targets for delivery: integrated loudness and the true-peak ceiling. */
export const LOUDNESS_TARGETS = [
  { id: "youtube", name: "YouTube (-14 LUFS)", lufs: -14, truePeak: -1 },
  { id: "podcast", name: "Podcast (-16 LUFS)", lufs: -16, truePeak: -1 },
  { id: "broadcast", name: "Broadcast EBU R128 (-23 LUFS)", lufs: -23, truePeak: -1 },
] as const;

/** The master gain (dB) that moves a measured loudness to a target. `limited` says the true-peak ceiling will be held by a limiter on the master. */
export function matchGain(m: Loudness, target: { lufs: number; truePeak: number }): { gainDb: number; limited: boolean } {
  if (!isFinite(m.integrated)) return { gainDb: 0, limited: false };
  const gainDb = target.lufs - m.integrated;
  return { gainDb, limited: m.truePeak + gainDb > target.truePeak };
}
