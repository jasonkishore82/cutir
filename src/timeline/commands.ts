import { useProject } from "../store/project";
import { useMedia } from "../store/media";
import { getTime, seek, setLoop } from "../lib/transport";
import * as E from "./engine";
import { IMAGE_SECONDS, TOOL_KEYS, editCtx, editTimeline, sourceOf, tlNow, useTimelineUi, withPoolMedia } from "./ui";

/**
 * Timeline commands shared by the keyboard, the toolbar and menus. Each one is a single undoable operation.
 */

export type SourceEdit = "insert" | "overwrite" | "replace" | "top" | "fit" | "append";

export const SOURCE_EDITS: { id: SourceEdit; label: string; key: string }[] = [
  { id: "insert", label: "Insert", key: "F9" },
  { id: "overwrite", label: "Overwrite", key: "F10" },
  { id: "replace", label: "Replace", key: "F11" },
  { id: "top", label: "Place on top", key: "F12" },
  { id: "fit", label: "Fit to fill", key: "Shift+F11" },
  { id: "append", label: "Append", key: "Shift+F12" },
];

/** Why a source edit cannot run right now, or "" when it can. */
export function sourceEditProblem(kind: SourceEdit): string {
  const id = useTimelineUi.getState().sourceId;
  const item = id ? useMedia.getState().items.find((i) => i.id === id) : undefined;
  if (!item || !sourceOf(item)) return "Choose a video, audio or image in the Media library first (click it).";
  const tl = tlNow();
  if (kind === "replace" && !useTimelineUi.getState().selected.length) return "Select the clip to replace.";
  if (kind === "fit" && (tl.inPoint === undefined || tl.outPoint === undefined)) return "Set timeline in and out points (I and O) first.";
  return "";
}

/** Edit the source (the chosen pool item, using its marks) into the timeline. */
export function sourceEdit(kind: SourceEdit): string {
  const problem = sourceEditProblem(kind);
  if (problem) return problem;
  const item = useMedia.getState().items.find((i) => i.id === useTimelineUi.getState().sourceId)!;
  const src0 = sourceOf(item)!;
  const tl = tlNow();
  const targets = { video: E.targetTrack(tl, "video")?.id, audio: E.targetTrack(tl, "audio")?.id };
  // three / four point: source marks + timeline in/out (or the playhead)
  const full = item.kind === "image" ? IMAGE_SECONDS : item.duration ?? IMAGE_SECONDS;
  const r = E.resolveMarks({ srcIn: item.markIn, srcOut: item.markOut, tlIn: tl.inPoint, tlOut: tl.outPoint }, full, getTime());
  const src = { ...src0, in: r.in, out: r.out };
  let ids: string[] = [];
  useProject.getState().editDoc((doc) =>
    E.onActive(withPoolMedia(doc, item), (t) => {
      let res: { tl: typeof t; ids: string[] };
      switch (kind) {
        case "insert":
          res = E.insertEdit(t, src, r.at, targets);
          break;
        case "overwrite":
          res = r.fitTo !== undefined ? E.fitToFill(t, src, r.at, r.fitTo, targets) : E.overwriteEdit(t, src, r.at, targets);
          break;
        case "replace": {
          const sel = useTimelineUi.getState().selected.map((id) => t.clips.find((c) => c.id === id)).filter(Boolean);
          const target = sel.find((c) => c!.mediaId && c!.trackId !== targets.audio) ?? sel[0];
          res = { tl: target ? E.replaceEdit(t, target.id, src, editCtx(doc)) : t, ids: target ? [target.id] : [] };
          break;
        }
        case "top":
          res = E.placeOnTop(t, src, r.at, targets);
          break;
        case "fit":
          res = E.fitToFill(t, src, t.inPoint!, t.outPoint!, targets);
          break;
        case "append":
          res = E.appendEdit(t, src, targets);
          break;
      }
      ids = res.ids;
      return res.tl;
    })
  );
  if (ids.length) useTimelineUi.setState({ selected: ids });
  return ids.length ? "" : "Nothing changed: check that the target tracks are unlocked.";
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
};

/** Keyboard shortcuts of the multi-track timeline. Returns true when the key was used. */
export function handleTimelineKey(e: KeyboardEvent): boolean {
  if (isTyping(e.target) || useProject.getState().syncMode) return false;
  const mod = e.ctrlKey || e.metaKey;
  const ui = useTimelineUi.getState();
  const lyricSelected = useProject.getState().selectedIds.length > 0;
  const sel = ui.selected.filter((id) => tlNow().clips.some((c) => c.id === id));
  const fps = useProject.getState().doc.settings.fps;
  const t = getTime();

  if (!mod && !e.altKey && !e.shiftKey && TOOL_KEYS[e.code]) {
    useTimelineUi.setState({ tool: TOOL_KEYS[e.code] });
    return true;
  }
  if (!mod && e.code === "KeyN") return (useTimelineUi.setState({ snapping: !ui.snapping }), true);
  if (!mod && e.code === "KeyM") return (editTimeline((x) => E.addMarker(x, t, { name: `Marker ${x.markers.length + 1}` }).tl), true);
  if (e.shiftKey && (e.code === "ArrowUp" || e.code === "ArrowDown")) {
    const m = E.nearMarker(tlNow(), t, e.code === "ArrowDown" ? 1 : -1);
    if (m) seek(m.time);
    return true;
  }
  if (!mod && e.code === "KeyI" && !e.altKey) return (editTimeline((x) => E.setRange(x, t)), true);
  if (!mod && e.code === "KeyO" && !e.altKey) return (editTimeline((x) => E.setRange(x, undefined, t)), true);
  if (e.altKey && e.code === "KeyX") return (editTimeline((x) => E.setRange(x, null, null)), true);
  if (mod && e.code === "KeyB") return (editTimeline((x) => E.blade(x, t, sel.length ? sel : undefined)), true);
  if (e.code === "Escape" && sel.length) return (useTimelineUi.setState({ selected: [] }), true);

  const fkey = { F9: "insert", F10: "overwrite", F11: e.shiftKey ? "fit" : "replace", F12: e.shiftKey ? "append" : "top" }[e.code] as SourceEdit | undefined;
  if (fkey) {
    const msg = sourceEdit(fkey);
    if (msg) useMedia.setState({ notice: msg });
    return true;
  }

  if ((e.code === "Delete" || e.code === "Backspace") && !lyricSelected) {
    if (sel.length) {
      editTimeline((x) => (e.shiftKey ? E.rippleDelete(x, sel) : E.deleteClips(x, sel)));
      useTimelineUi.setState({ selected: [] });
      return true;
    }
    const tl = tlNow();
    if (tl.inPoint !== undefined && tl.outPoint !== undefined) {
      editTimeline((x) => (e.shiftKey ? E.extractRange(x, tl.inPoint!, tl.outPoint!) : E.liftRange(x, tl.inPoint!, tl.outPoint!)));
      return true;
    }
    return false;
  }

  // nudge selected clips by a frame (Shift: ten); with nothing selected the arrows step the playhead by a frame
  const step = e.code === "Comma" || e.code === "ArrowLeft" ? -1 : e.code === "Period" || e.code === "ArrowRight" ? 1 : 0;
  if (step && !mod && !lyricSelected) {
    if (e.target instanceof HTMLElement && e.target.closest("[data-text-stage]")) return false;
    const frames = step * (e.shiftKey ? 10 : 1);
    if (sel.length) editTimeline((x) => E.moveClips(x, sel, frames / fps), `nudge:${sel.join(",")}`);
    else if (e.code.startsWith("Arrow")) seek(Math.max(0, Math.round((t + frames / fps) * fps) / fps));
    else return false;
    return true;
  }
  return false;
}

/** Use the timeline in/out range as the playback loop (or clear the loop). */
export function loopRange(on: boolean) {
  const tl = tlNow();
  if (on && tl.inPoint !== undefined && tl.outPoint !== undefined) {
    setLoop({ start: tl.inPoint, end: tl.outPoint });
    seek(tl.inPoint);
  } else setLoop(null);
}
