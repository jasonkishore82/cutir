import type { Clip } from "../../model/types";

/**
 * Scene detection (phase 28). The browser side samples a clip's picture and measures how much each sample differs from
 * the one before (0..1); the pure part here picks the cuts from those differences and turns them into timeline times.
 */

export type SceneOptions = {
  /** 0..1: higher finds more cuts. Default 0.5. */
  sensitivity?: number;
  /** Shortest scene, seconds. */
  minGap?: number;
};

/**
 * Indices of the samples where the picture jumps: a difference well above the usual movement around it and above a
 * floor, and the largest within `minGap`. `diffs[i]` is the change from sample i-1 to sample i.
 */
export function detectCuts(diffs: number[], step: number, o: SceneOptions = {}): number[] {
  const sens = Math.min(1, Math.max(0, o.sensitivity ?? 0.5));
  const floor = 0.3 - 0.22 * sens; // 0.19 at the default
  const k = 5 - 3 * sens; // how many "usual movements" above the surroundings
  const gap = Math.max(1, Math.round((o.minGap ?? 0.6) / step));
  const picked: number[] = [];
  const R = Math.max(2, Math.round(1 / step));
  for (let i = 1; i < diffs.length; i++) {
    const d = diffs[i];
    if (d < floor) continue;
    let sum = 0;
    let n = 0;
    for (let j = Math.max(1, i - R); j <= Math.min(diffs.length - 1, i + R); j++) {
      if (j === i) continue;
      sum += diffs[j];
      n++;
    }
    const mean = n ? sum / n : 0;
    if (d < mean * k) continue;
    const last = picked[picked.length - 1];
    if (last !== undefined && i - last < gap) {
      if (d > diffs[last]) picked[picked.length - 1] = i;
      continue;
    }
    picked.push(i);
  }
  return picked;
}

/** Timeline times of cuts found at source seconds in `clip`, inside the part of the clip that is used. */
export function sceneTimes(clip: Clip, sourceTimes: number[]): number[] {
  const speed = clip.speed || 1;
  return sourceTimes
    .filter((s) => s > clip.sourceIn + 0.05 && s < clip.sourceOut - 0.05)
    .map((s) => Math.round((clip.start + (s - clip.sourceIn) / speed) * 1000) / 1000);
}

/** Mean absolute luma difference of two RGBA images of the same size, 0..1. */
export function frameDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const n = Math.min(a.length, b.length) / 4;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const la = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const lb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    sum += Math.abs(la - lb);
  }
  return sum / n / 255;
}

/** Sample a video file every `step` seconds between `from` and `to` (source seconds) and return the differences. Browser only. */
export async function sampleDiffs(url: string, from: number, to: number, step: number, signal?: AbortSignal): Promise<number[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((res, rej) => {
    video.onloadedmetadata = () => res();
    video.onerror = () => rej(new Error("The video could not be opened."));
  });
  const W = 64;
  const H = 36;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  const seek = (t: number) =>
    new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("Seeking the video took too long.")), 8000);
      video.onseeked = () => (clearTimeout(timer), res());
      video.currentTime = t;
    });
  const diffs: number[] = [];
  let prev: Uint8ClampedArray | null = null;
  try {
    for (let t = from; t < to; t += step) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      await seek(Math.min(t, Math.max(0, (video.duration || to) - 0.01)));
      ctx.drawImage(video, 0, 0, W, H);
      const cur = ctx.getImageData(0, 0, W, H).data;
      diffs.push(prev ? frameDiff(prev, cur) : 0);
      prev = cur;
    }
  } finally {
    video.removeAttribute("src");
    video.load();
  }
  return diffs;
}
