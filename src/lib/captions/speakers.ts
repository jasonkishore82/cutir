/**
 * Speaker detection (phase 25): who is talking in each caption, from the sound alone.
 *
 * Each caption's stretch of audio is reduced to a voice print: the typical pitch of the voiced frames and the
 * shape of the spectrum (energy in a dozen bands, with the overall loudness taken out). Captions are then
 * grouped by k-means; the number of speakers is chosen by how well separated the groups are (silhouette), or
 * given. This is a light method, good for a few distinct voices in clean speech; it does not separate people
 * talking at once and it can confuse two voices of the same pitch and timbre.
 * Pure, so it runs in tests.
 */
import type { Cue } from "./cues";

const FRAME = 512;
const HOP = 256;
const BANDS = 12;

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Band edges in Hz, spaced evenly on a mel-like scale between 100 Hz and 6 kHz. */
function bandEdges(): number[] {
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const inv = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const lo = mel(100);
  const hi = mel(6000);
  return Array.from({ length: BANDS + 1 }, (_, i) => inv(lo + ((hi - lo) * i) / BANDS));
}

/** Pitch of a frame by normalised autocorrelation, in Hz, or 0 when the frame is not clearly voiced. */
export function framePitch(x: ArrayLike<number>, from: number, sr: number): number {
  const minLag = Math.floor(sr / 400);
  const maxLag = Math.min(Math.floor(sr / 70), FRAME - 1);
  let e0 = 0;
  for (let i = 0; i < FRAME - maxLag; i++) e0 += x[from + i] * x[from + i];
  if (e0 < 1e-9) return 0;
  let best = 0;
  let bestLag = 0;
  const r: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    let e1 = 0;
    for (let i = 0; i < FRAME - maxLag; i++) {
      c += x[from + i] * x[from + i + lag];
      e1 += x[from + i + lag] * x[from + i + lag];
    }
    const v = c / Math.sqrt(e0 * e1 + 1e-12);
    r.push(v);
    if (v > best) (best = v), (bestLag = lag);
  }
  if (best < 0.5) return 0;
  // prefer the first strong peak so a doubled lag is not taken for the pitch
  for (let i = 1; i < r.length - 1; i++) if (r[i] >= 0.9 * best && r[i] >= r[i - 1] && r[i] >= r[i + 1]) return sr / (minLag + i);
  return sr / bestLag;
}

export type VoicePrint = { pitch: number; spectrum: number[]; voiced: number };

/** The voice print of a stretch of samples (null when too little of it is voiced to say). */
export function voicePrint(x: ArrayLike<number>, sr: number, start: number, end: number): VoicePrint | null {
  const a = Math.max(0, Math.floor(start * sr));
  const b = Math.min(x.length, Math.floor(end * sr));
  if (b - a < FRAME * 2) return null;
  const edges = bandEdges();
  const win = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
  // loudness of each frame, to leave out the quiet ones
  const frames: { at: number; rms: number }[] = [];
  for (let at = a; at + FRAME <= b; at += HOP) {
    let s = 0;
    for (let i = 0; i < FRAME; i++) s += x[at + i] * x[at + i];
    frames.push({ at, rms: Math.sqrt(s / FRAME) });
  }
  const peak = Math.max(...frames.map((f) => f.rms), 1e-9);
  const pitches: number[] = [];
  const spec = new Array<number>(BANDS).fill(0);
  let n = 0;
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (const f of frames) {
    if (f.rms < peak * 0.25) continue;
    const p = framePitch(x, f.at, sr);
    if (!p) continue;
    pitches.push(p);
    for (let i = 0; i < FRAME; i++) (re[i] = x[f.at + i] * win[i]), (im[i] = 0);
    fft(re, im);
    const power = (k: number) => re[k] * re[k] + im[k] * im[k];
    for (let bnd = 0; bnd < BANDS; bnd++) {
      const k0 = Math.max(1, Math.floor((edges[bnd] * FRAME) / sr));
      const k1 = Math.max(k0 + 1, Math.floor((edges[bnd + 1] * FRAME) / sr));
      let s = 0;
      for (let k = k0; k < k1; k++) s += power(k);
      spec[bnd] += Math.log(s / (k1 - k0) + 1e-9);
    }
    n++;
  }
  if (n < 3) return null;
  const mean = spec.reduce((s, v) => s + v / n, 0) / BANDS;
  pitches.sort((p, q) => p - q);
  return { pitch: pitches[pitches.length >> 1], spectrum: spec.map((v) => v / n - mean), voiced: n };
}

/** Feature vector: log pitch (weighted, because it separates voices best) then the spectrum shape. */
const featureOf = (v: VoicePrint) => [Math.log2(v.pitch) * 2.5, ...v.spectrum.map((s) => s * 0.35)];

const dist2 = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

function kmeans(points: number[][], k: number): { labels: number[]; centres: number[][] } {
  // farthest-point start: the first point, then each time the point furthest from the chosen centres
  const centres = [points[0]];
  while (centres.length < k) {
    let far = 0;
    let farD = -1;
    points.forEach((p, i) => {
      const d = Math.min(...centres.map((c) => dist2(p, c)));
      if (d > farD) (farD = d), (far = i);
    });
    centres.push(points[far]);
  }
  let labels = new Array<number>(points.length).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    const next = points.map((p) => centres.reduce((best, c, i) => (dist2(p, c) < dist2(p, centres[best]) ? i : best), 0));
    const same = next.every((l, i) => l === labels[i]);
    labels = next;
    for (let c = 0; c < k; c++) {
      const mine = points.filter((_, i) => labels[i] === c);
      if (mine.length) centres[c] = mine[0].map((_, d) => mine.reduce((s, p) => s + p[d], 0) / mine.length);
    }
    if (same) break;
  }
  return { labels, centres };
}

/** Mean silhouette of a grouping, -1..1: how much closer each point is to its own group than to the next nearest. */
export function silhouette(points: number[][], labels: number[], k: number): number {
  if (k < 2) return 0;
  let total = 0;
  points.forEach((p, i) => {
    const mean = (g: number, skip: boolean) => {
      let s = 0;
      let c = 0;
      points.forEach((q, j) => {
        if (labels[j] !== g || (skip && j === i)) return;
        s += Math.sqrt(dist2(p, q));
        c++;
      });
      return c ? s / c : Infinity;
    };
    const a = mean(labels[i], true);
    let b = Infinity;
    for (let g = 0; g < k; g++) if (g !== labels[i]) b = Math.min(b, mean(g, false));
    const alone = labels.filter((l) => l === labels[i]).length === 1;
    total += alone || !Number.isFinite(a) || !Number.isFinite(b) ? 0 : (b - a) / Math.max(a, b, 1e-9);
  });
  return total / points.length;
}

export type SpeakerOptions = { /** The number of speakers when known; otherwise it is chosen. */ speakers?: number; maxSpeakers?: number; /** Least silhouette to accept more than one speaker. */ minSilhouette?: number; /** Least distance between two speakers' voice prints (an octave of pitch is 2.5). */ minSeparation?: number; /** Keep a speaker already set on a cue. */ keepNamed?: boolean };

/** Speaker index per cue (first speaker to appear is 0), or -1 where the cue could not be judged. */
export function clusterSpeakers(prints: (VoicePrint | null)[], o: SpeakerOptions = {}): { labels: number[]; speakers: number } {
  const idx = prints.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const labels = new Array<number>(prints.length).fill(-1);
  if (!idx.length) return { labels, speakers: 0 };
  const raw = idx.map((i) => featureOf(prints[i]!));
  // pitch is in octaves and the spectrum in natural-log power, both left as they are: a small spread is one voice
  const pts = raw;
  const maxK = Math.max(1, Math.min(o.maxSpeakers ?? 4, idx.length));
  let k = Math.max(1, Math.min(o.speakers ?? 0, idx.length));
  let best = { labels: new Array<number>(idx.length).fill(0), centres: [] as number[][] };
  if (o.speakers && k > 1) best = kmeans(pts, k);
  else if (!o.speakers) {
    let bestS = o.minSilhouette ?? 0.45;
    k = 1;
    for (let c = 2; c <= maxK; c++) {
      const r = kmeans(pts, c);
      const s = silhouette(pts, r.labels, c);
      // two groups must also be far apart in absolute terms, or one voice would be split by chance
      const apart = Math.min(...r.centres.flatMap((a, i) => r.centres.slice(i + 1).map((b) => Math.sqrt(dist2(a, b)))));
      if (s > bestS && apart >= (o.minSeparation ?? 1.2)) (bestS = s), (best = r), (k = c);
    }
  }
  // number the speakers in the order they first speak
  const order = new Map<number, number>();
  best.labels.forEach((l) => order.has(l) || order.set(l, order.size));
  idx.forEach((cueIndex, j) => (labels[cueIndex] = order.get(best.labels[j])!));
  // cues with too little voiced sound take the speaker of the cue before (or after, at the start)
  for (let i = 0; i < labels.length; i++) if (labels[i] < 0) labels[i] = labels[i - 1] ?? labels.find((l) => l >= 0) ?? 0;
  return { labels, speakers: order.size };
}

/** Name speakers on cues from the sound: "Speaker 1", "Speaker 2"... A cue's own name is kept when `keepNamed` is set. */
export function labelSpeakers(cues: Cue[], samples: ArrayLike<number>, sr: number, o: SpeakerOptions = {}): { cues: Cue[]; speakers: number } {
  const prints = cues.map((c) => (o.keepNamed && c.speaker ? null : voicePrint(samples, sr, c.start, c.end)));
  const { labels, speakers } = clusterSpeakers(prints, o);
  return {
    speakers,
    cues: cues.map((c, i) => (o.keepNamed && c.speaker ? c : { ...c, speaker: `Speaker ${labels[i] + 1}` })),
  };
}
