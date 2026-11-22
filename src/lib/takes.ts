import type { Clip, Timeline } from "../model/types";

/**
 * Take management for voice-over (phase 21). Every recording is a take in a group; the clip on the timeline plays one
 * of them. Recording again over a selected clip adds a take to its group and swaps the clip to it, so a bad read is
 * replaced without stacking clips, and an earlier take can be brought back at any time. Pure, so it is tested in node.
 */

export type TakeInfo = { group: string; n: number; rating?: "good" | "bad" };
export type TakeItem = { id: string; name?: string; duration?: number; take?: TakeInfo };

let seq = 0;
export const newTakeGroup = () => `tk${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The takes of a group, first take first. */
export const takesInGroup = <T extends TakeItem>(items: T[], group: string): T[] => items.filter((i) => i.take?.group === group).sort((a, b) => a.take!.n - b.take!.n);

export const nextTakeNumber = (items: TakeItem[], group: string) => Math.max(0, ...takesInGroup(items, group).map((i) => i.take!.n)) + 1;

/** The take to offer first: the newest one rated good, else the newest. */
export function bestTake<T extends TakeItem>(items: T[], group: string): T | undefined {
  const list = takesInGroup(items, group);
  return [...list].reverse().find((i) => i.take?.rating === "good") ?? list[list.length - 1];
}

/**
 * Make a clip play another file: starts at the file's beginning, as long as the file is (or as long as the free space
 * after the clip allows, so it never runs over the next clip on its track). The clip keeps its place, track and look.
 */
export function swapTake(tl: Timeline, clipId: string, media: { mediaId: string; duration: number; group?: string }): Timeline {
  const c = tl.clips.find((x) => x.id === clipId);
  if (!c || !(media.duration > 0)) return tl;
  const next = tl.clips.filter((x) => x.trackId === c.trackId && x.id !== c.id && !x.fill && x.start >= c.start + 1e-6).sort((a, b) => a.start - b.start)[0];
  const room = next ? next.start - c.start : Infinity;
  const duration = Math.max(0.05, Math.min(media.duration, room));
  const swapped: Clip = { ...c, mediaId: media.mediaId, sourceIn: 0, sourceOut: duration, duration, speed: 1, ramp: undefined, reverse: undefined, ...(media.group ? { takeGroup: media.group } : {}) };
  return { ...tl, clips: tl.clips.map((x) => (x.id === clipId ? swapped : x)) };
}

/** Tag a clip with a take group (no other change). */
export const tagClip = (tl: Timeline, clipId: string, group: string): Timeline => ({ ...tl, clips: tl.clips.map((x) => (x.id === clipId ? { ...x, takeGroup: group } : x)) });
