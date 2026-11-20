import { create } from "zustand";
import type { Key } from "./engine";
import type { LaneId } from "./lanes";
import type { Clip, Timeline } from "../../model/types";

/**
 * Keyframe UI state (phase 18), not part of the project: which lanes show on the timeline and in the curve editor,
 * the selected keys, auto-key, and the keyframe clipboard.
 */

export type KeySel = { clipId: string; laneKey: string; t: number };

type KeyframeUi = {
  /** Moving, scaling or rotating a clip in the viewer writes keys (when the playhead is inside the clip). */
  autoKey: boolean;
  /** Lane keys shown on the timeline lane and in the curve editor (empty = every lane with keys). */
  shownLanes: string[];
  /** Selected keys (shift-click or marquee adds). */
  selected: KeySel[];
  /** Curve editor open under the timeline. */
  curves: boolean;
  /** Copied keys by lane key, plus the clip they came from (for effect matching). */
  clipboard: { lanes: Record<string, Key[]>; fromClipId: string; t0: number } | null;
  /** Show the motion path of the selected clip on the viewer. */
  showPath: boolean;
};

export const useKeyframeUi = create<KeyframeUi>(() => ({ autoKey: false, shownLanes: [], selected: [], curves: false, clipboard: null, showPath: true }));

export const selectKey = (s: KeySel, add = false) =>
  useKeyframeUi.setState((u) => {
    const same = (x: KeySel) => x.clipId === s.clipId && x.laneKey === s.laneKey && Math.abs(x.t - s.t) <= 0.02;
    if (!add) return { selected: [s] };
    return { selected: u.selected.some(same) ? u.selected.filter((x) => !same(x)) : [...u.selected, s] };
  });

export const isSelected = (sel: KeySel[], clipId: string, laneKey: string, t: number) => sel.some((x) => x.clipId === clipId && x.laneKey === laneKey && Math.abs(x.t - t) <= 0.02);

export const toggleLane = (key: string) => useKeyframeUi.setState((u) => ({ shownLanes: u.shownLanes.includes(key) ? u.shownLanes.filter((k) => k !== key) : [...u.shownLanes, key] }));

export type { LaneId };

/**
 * The clip the keyframe UI works on: the only selected clip, or (when a picture clip and its linked sound are
 * selected together) the picture clip. Fill clips (song, lyric background) never.
 */
export function focusClip(tl: Timeline, selected: string[]): Clip | undefined {
  const clips = selected.map((id) => tl.clips.find((c) => c.id === id)).filter((c): c is Clip => !!c && !c.fill && !!c.mediaId);
  if (!clips.length) return undefined;
  if (clips.length === 1) return clips[0];
  const link = clips[0].linkId;
  if (!link || !clips.every((c) => c.linkId === link)) return undefined;
  const video = clips.find((c) => tl.tracks.find((t) => t.id === c.trackId)?.kind === "video");
  return video ?? clips[0];
}
