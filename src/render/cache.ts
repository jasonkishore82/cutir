import { create } from "zustand";
import { activeTimeline } from "../model/convert";
import type { Clip, ProjectDoc, Timeline } from "../model/types";

/**
 * Render cache (phase 16): finished frames of the viewer, kept so heavy parts play smoothly the second time.
 *
 * - Frames are stored by frame number at the viewer's current size, inside a memory budget (oldest out first).
 * - When the project changes, `affectedRanges` works out which times can look different and only those frames
 *   are dropped. Edits that change every frame (aspect, lyric style, background...) clear everything.
 * - Export never uses the cache: it always renders from the media (originals by default).
 */

export type Range = [number, number];

type Bitmap = { width: number; height: number; close: () => void };

export class FrameCache<B extends Bitmap = ImageBitmap> {
  private frames = new Map<number, { bmp: B; bytes: number }>(); // insertion order = age
  bytes = 0;
  constructor(public limitBytes: number) {}

  get(i: number): B | undefined {
    const e = this.frames.get(i);
    if (!e) return undefined;
    this.frames.delete(i);
    this.frames.set(i, e); // most recently used
    return e.bmp;
  }

  has = (i: number) => this.frames.has(i);

  put(i: number, bmp: B) {
    const old = this.frames.get(i);
    if (old) {
      old.bmp.close();
      this.bytes -= old.bytes;
      this.frames.delete(i);
    }
    const bytes = bmp.width * bmp.height * 4;
    if (bytes > this.limitBytes) {
      bmp.close();
      return;
    }
    this.frames.set(i, { bmp, bytes });
    this.bytes += bytes;
    this.trim();
  }

  setLimit(bytes: number) {
    this.limitBytes = bytes;
    this.trim();
  }

  private trim() {
    for (const [k, e] of this.frames) {
      if (this.bytes <= this.limitBytes) break;
      e.bmp.close();
      this.bytes -= e.bytes;
      this.frames.delete(k);
    }
  }

  /** Drop the frames whose times fall in any of the ranges (seconds, inclusive). */
  invalidate(ranges: Range[] | "all", fps: number) {
    if (ranges === "all") return this.clear();
    for (const [i, e] of this.frames) {
      const t = i / fps;
      if (ranges.some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6)) {
        e.bmp.close();
        this.bytes -= e.bytes;
        this.frames.delete(i);
      }
    }
  }

  clear() {
    for (const e of this.frames.values()) e.bmp.close();
    this.frames.clear();
    this.bytes = 0;
  }

  /** Cached frames as time ranges, for the ruler. */
  ranges(fps: number): Range[] {
    const idx = [...this.frames.keys()].sort((a, b) => a - b);
    const out: Range[] = [];
    for (const i of idx) {
      const last = out[out.length - 1];
      if (last && i / fps - last[1] <= 1.5 / fps) last[1] = (i + 1) / fps;
      else out.push([i / fps, (i + 1) / fps]);
    }
    return out;
  }

  get size() {
    return this.frames.size;
  }
}

/* ---------- what an edit changes ---------- */

const json = (v: unknown) => JSON.stringify(v ?? null);
/** Lyric lines can show up to this long outside their own time (transitions, held keyframes): a safe margin. */
const TEXT_MARGIN = 2;

const clipRange = (c: Clip, margin = 0): Range => [Math.max(0, c.start - margin), c.start + c.duration + margin];

/** Track fields that change pictures (not height, name, target, lock, mute or solo). */
const trackLook = (tl: Timeline) => tl.tracks.map((t) => ({ id: t.id, kind: t.kind, hidden: t.hidden, style: t.style }));

/** Merge overlapping ranges. */
export function mergeRanges(r: Range[]): Range[] {
  const s = [...r].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

/**
 * Times whose picture can differ between two versions of the document: only the old and new spans of changed
 * clips (and of clips whose media changed). Changes that touch every frame return "all".
 */
export function affectedRanges(prev: ProjectDoc, next: ProjectDoc): Range[] | "all" {
  if (prev === next) return [];
  const a = activeTimeline(prev);
  const b = activeTimeline(next);
  if (a.id !== b.id) return "all";
  const s1 = prev.settings;
  const s2 = next.settings;
  if (s1.aspect !== s2.aspect || s1.width !== s2.width || s1.height !== s2.height || s1.fps !== s2.fps || json(s1.proxy) !== json(s2.proxy)) return "all";
  if (json(a.textStyle) !== json(b.textStyle) || json(a.transition) !== json(b.transition)) return "all";
  if (json(trackLook(a)) !== json(trackLook(b))) return "all";

  const ranges: Range[] = [];
  const before = new Map(a.clips.map((c) => [c.id, c]));
  const after = new Map(b.clips.map((c) => [c.id, c]));
  const changedMedia = new Set(next.media.filter((m) => json(prev.media.find((x) => x.id === m.id)) !== json(m)).map((m) => m.id));
  for (const m of prev.media) if (!next.media.some((x) => x.id === m.id)) changedMedia.add(m.id);

  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const c1 = before.get(id);
    const c2 = after.get(id);
    const same = c1 && c2 && c1 === c2;
    const mediaChanged = (c1?.mediaId && changedMedia.has(c1.mediaId)) || (c2?.mediaId && changedMedia.has(c2.mediaId));
    if (same && !mediaChanged) continue;
    if (!same && json(c1) === json(c2) && !mediaChanged) continue;
    if (c1?.fill || c2?.fill) {
      // the song never changes a picture; the lyric background is every frame
      const isAudio = (c: Clip | undefined, tl: Timeline) => !!c && tl.tracks.find((t) => t.id === c.trackId)?.kind === "audio";
      if (isAudio(c1, a) || isAudio(c2, b)) continue;
      return "all";
    }
    const audioOnly = (c: Clip | undefined, tl: Timeline) => !c || tl.tracks.find((t) => t.id === c.trackId)?.kind === "audio";
    if (audioOnly(c1, a) && audioOnly(c2, b)) continue; // sound does not change pictures
    const margin = c1?.text || c2?.text ? TEXT_MARGIN : 0;
    if (c1) ranges.push(clipRange(c1, margin));
    if (c2) ranges.push(clipRange(c2, margin));
  }
  return mergeRanges(ranges);
}

/* ---------- shared state for the ruler and settings ---------- */

export const useCacheInfo = create<{ ranges: Range[]; frames: number; mb: number }>(() => ({ ranges: [], frames: 0, mb: 0 }));
