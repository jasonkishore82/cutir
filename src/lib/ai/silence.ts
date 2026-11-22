import type { Timeline } from "../../model/types";
import { mergeRanges, type Range } from "../captions/transcript";

/**
 * Silence finding (phase 28): "remove all pauses longer than half a second" without needing a transcript.
 * Pure: loudness per window in dB, the loudness of the whole timeline's sound, runs of quiet, and the ranges to cut.
 * The browser side (decoding the files) lives in audioLevels.ts.
 */

/** Windows per second of the loudness curves. */
export const LEVEL_RATE = 50;

/** RMS loudness in dB (0 = full scale, -Infinity = digital silence) of each window of `samples`. */
export function levelsOf(samples: Float32Array, sampleRate: number, rate = LEVEL_RATE): number[] {
  const win = Math.max(1, Math.round(sampleRate / rate));
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += win) {
    const end = Math.min(samples.length, i + win);
    let sum = 0;
    for (let k = i; k < end; k++) sum += samples[k] * samples[k];
    const rms = Math.sqrt(sum / Math.max(1, end - i));
    out.push(rms > 1e-7 ? 20 * Math.log10(rms) : -Infinity);
  }
  return out;
}

/** A file's loudness curve, `rate` windows a second, indexed by source seconds. */
export type Levels = { rate: number; db: number[] };

/**
 * Loudness of the mix over the timeline: at each window the loudest of the sound clips playing there. Windows where
 * no sound plays are -Infinity. Muted, hidden and disabled sound does not count.
 */
export function timelineLevels(tl: Timeline, levels: Record<string, Levels>, length: number, rate = LEVEL_RATE): number[] {
  const n = Math.ceil(length * rate);
  const out: number[] = new Array(n).fill(-Infinity);
  const live = new Set(tl.tracks.filter((t) => t.kind === "audio" && !t.muted && !t.hidden).map((t) => t.id));
  for (const c of tl.clips) {
    if (!live.has(c.trackId) || !c.enabled || !c.mediaId || (c.volume ?? 1) <= 0) continue;
    const lv = levels[c.mediaId];
    if (!lv) continue;
    const a = Math.max(0, Math.floor(c.start * rate));
    const b = Math.min(n, Math.ceil((c.start + c.duration) * rate));
    for (let i = a; i < b; i++) {
      const src = c.sourceIn + (i / rate - c.start) * (c.speed || 1);
      const db = lv.db[Math.floor(src * lv.rate)];
      if (db !== undefined && db > out[i]) out[i] = db;
    }
  }
  return out;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

/** A threshold between the room noise and the speech: a fifth of the way from the quiet end to the loud end. */
export function autoThreshold(db: number[]): number {
  const real = db.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (real.length < 10) return -45;
  const floor = pct(real, 0.1);
  const peak = pct(real, 0.95);
  return Math.min(-25, Math.max(-60, floor + 0.2 * (peak - floor)));
}

export type SilenceOptions = {
  /** Shortest pause to cut, seconds. */
  minLen?: number;
  /** Below this many dB counts as quiet; automatic when missing. */
  threshold?: number;
  /** Silence left behind in each pause, seconds, so words are not clipped. */
  keep?: number;
};

/** The pauses to cut: runs of quiet at least `minLen` long, each shortened by `keep`. */
export function findSilences(db: number[], o: SilenceOptions = {}, rate = LEVEL_RATE): Range[] {
  const minLen = o.minLen ?? 0.5;
  const keep = o.keep ?? 0.1;
  const thr = o.threshold ?? autoThreshold(db);
  const out: Range[] = [];
  let from = -1;
  const close = (end: number) => {
    if (from < 0) return;
    const a = from / rate;
    const b = end / rate;
    from = -1;
    if (b - a < minLen) return;
    const s = a + keep / 2;
    const e = b - keep / 2;
    if (e - s >= 0.05) out.push({ start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 });
  };
  db.forEach((v, i) => {
    if (v < thr) {
      if (from < 0) from = i;
    } else close(i);
  });
  close(db.length);
  return mergeRanges(out, 0);
}

/** Ranges to cut for the timeline: pauses in the mix, never past the end of the last clip. */
export function planSilenceCuts(tl: Timeline, levels: Record<string, Levels>, o: SilenceOptions = {}): { ranges: Range[]; threshold: number } {
  const length = tl.clips.reduce((m, c) => (c.fill ? m : Math.max(m, c.start + c.duration)), 0);
  const db = timelineLevels(tl, levels, length);
  const threshold = o.threshold ?? autoThreshold(db);
  return { ranges: findSilences(db, { ...o, threshold }), threshold };
}
