/**
 * Syncing recordings (phase 24). `findLag` lines two recordings of the same event up by cross-correlation (an FFT, so a
 * long clip takes a fraction of a second at the low sample rate it works at). Pure; the worker in sync.worker.ts runs it
 * off the main thread. Marker and timecode syncing are plain arithmetic.
 */

export const SYNC_RATE = 4000;

/** Average blocks of samples down to about `to` Hz, and remove the mean (so a loud DC offset cannot win). */
export function downsampleMono(ch: Float32Array[], from: number, to = SYNC_RATE): Float32Array {
  const n = ch[0]?.length ?? 0;
  const f = Math.max(1, Math.floor(from / to));
  const out = new Float32Array(Math.floor(n / f));
  let mean = 0;
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) for (const c of ch) s += c[i * f + k];
    out[i] = s / (f * ch.length);
    mean += out[i];
  }
  mean /= out.length || 1;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

/** In-place radix-2 FFT (length must be a power of two). `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
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
    const ang = ((inverse ? -2 : 2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

const pow2 = (n: number) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

export type Lag = { /** Seconds into `a` where `b` starts (negative: b starts before a). */ lag: number; /** Peak over the typical level of the correlation: a few units is a guess, 8 or more is a clear match. */ confidence: number };

/**
 * Where recording `b` starts inside recording `a`, both mono at `sr`. Searches lags up to `maxSeconds` either way
 * (the whole overlap when not given).
 */
export function findLag(a: Float32Array, b: Float32Array, sr: number, maxSeconds?: number): Lag {
  const size = pow2(a.length + b.length);
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(a);
  br.set(b);
  fft(ar, ai);
  fft(br, bi);
  // correlation: IFFT( A * conj(B) )
  for (let i = 0; i < size; i++) {
    const re = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = re;
    ai[i] = im;
  }
  fft(ar, ai, true);
  // index k >= 0 is lag k; index size - k is lag -k
  const maxLag = Math.min(maxSeconds !== undefined ? Math.round(maxSeconds * sr) : Infinity, Math.max(a.length, b.length) - 1);
  let best = -Infinity;
  let bestLag = 0;
  let sum = 0;
  let count = 0;
  for (let k = -Math.min(maxLag, b.length - 1); k <= Math.min(maxLag, a.length - 1); k++) {
    const v = ar[(k + size) % size];
    sum += Math.abs(v);
    count++;
    if (v > best) (best = v), (bestLag = k);
  }
  const typical = count ? sum / count : 0;
  // sub-sample refinement with a parabola through the peak and its neighbours
  const y0 = ar[(bestLag - 1 + size) % size], y1 = ar[(bestLag + size) % size], y2 = ar[(bestLag + 1 + size) % size];
  const d = y0 - 2 * y1 + y2;
  const frac = d < -1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : 0;
  return { lag: (bestLag + frac) / sr, confidence: typical > 1e-12 ? best / typical : 0 };
}

/** Timecode syncing: the offset that puts clip `b` (starting at timecode tcB) where it belongs relative to clip `a` (tcA), in seconds. */
export const lagFromTimecode = (tcA: number, tcB: number) => tcB - tcA;

/** Marker syncing: both clips' markers (seconds into each clip) line up, so b starts at markerA - markerB into a. */
export const lagFromMarkers = (markerA: number, markerB: number) => markerA - markerB;

/** "01:02:03:04" or "1:02:03" to seconds, at `fps` for the frames field; null when it is not a timecode. */
export function parseTimecode(s: string, fps = 30): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[:;.](\d{1,3}))?$/);
  if (!m) return null;
  const frac = m[4] === undefined ? 0 : m[4].length > 2 && !s.includes(":") ? Number(`0.${m[4]}`) : Number(m[4]) / fps;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

export function formatTimecode(sec: number, fps = 30): string {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.round((t - Math.floor(t)) * fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(Math.min(f, Math.ceil(fps) - 1))}`;
}
