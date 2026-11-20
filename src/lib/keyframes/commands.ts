import { useProject } from "../../store/project";
import { getTime } from "../transport";
import { editTimeline, tlNow, useTimelineUi } from "../../timeline/ui";
import { copySelectedKeys, parseLaneKey, pasteLanes, pasteOffset, removeLaneKey } from "./lanes";
import { focusClip, useKeyframeUi } from "./ui";

/**
 * Keyboard commands for selected keyframes (phase 18): Ctrl+C copies them, Ctrl+V pastes onto the focused clip,
 * Delete removes them, Escape clears the key selection. Copied times are relative to the source clip's start, so a
 * paste lands at the same offset into the destination clip, or at the playhead when it is inside that clip.
 */

const target = () => focusClip(tlNow(), useTimelineUi.getState().selected);

/** Ctrl+V should paste keyframes (not a lyric line): a keyframe clipboard and a clip to paste on. */
export const keyframePasteApplies = () => !!useKeyframeUi.getState().clipboard && !!target() && !useProject.getState().selectedIds.length;

export function handleKeyframeKey(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const ui = useKeyframeUi.getState();
  const doc = useProject.getState().doc;
  const sel = ui.selected.filter((s) => tlNow().clips.some((c) => c.id === s.clipId));

  if (mod && e.code === "KeyC" && sel.length) {
    const copied = copySelectedKeys(doc, sel);
    if (!copied) return false;
    useKeyframeUi.setState({ clipboard: copied });
    return true;
  }
  if (mod && e.code === "KeyV" && keyframePasteApplies()) {
    const clip = target()!;
    const cb = ui.clipboard!;
    const source = tlNow().clips.find((c) => c.id === cb.fromClipId);
    const at = pasteOffset(clip, cb.t0, getTime());
    editTimeline((t) => pasteLanes(t, clip.id, cb.lanes, source, at));
    useKeyframeUi.setState({
      selected: Object.entries(cb.lanes).flatMap(([laneKey, keys]) => keys.map((k) => ({ clipId: clip.id, laneKey, t: k.t + at }))),
    });
    return true;
  }
  if ((e.code === "Delete" || e.code === "Backspace") && sel.length && !mod) {
    editTimeline((t) =>
      sel.reduce((acc, s) => {
        const id = parseLaneKey(s.laneKey);
        return id ? removeLaneKey(acc, s.clipId, id, s.t) : acc;
      }, t)
    );
    useKeyframeUi.setState({ selected: [] });
    return true;
  }
  if (e.code === "Escape" && sel.length) {
    useKeyframeUi.setState({ selected: [] });
    return true;
  }
  return false;
}
