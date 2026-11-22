import { create } from "zustand";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import type { MediaItem } from "../store/media";
import type { MediaRef, ProjectDoc, Timeline } from "../model/types";
import { onActive, type EditCtx, type PointerMode, type Source, type Tool } from "./engine";

/** Timeline UI state that is not part of the project (not saved, not undoable). */
type TimelineUi = {
  tool: Tool;
  snapping: boolean;
  /** Snap to beat markers too (phase 16.5); only while snapping is on. */
  beatSnap: boolean;
  /** Selected clips on video and audio tracks (lyric lines keep their own selection). */
  selected: string[];
  /** The media-pool item used by insert, overwrite, replace... (the "source"). */
  sourceId: string | null;
  /** Live feedback while dragging: the snap guide and the current pointer mode. */
  guide: number | null;
  mode: PointerMode | null;
  /** Effect being hovered in the Effects panel: previewed on the selected clips in the viewer, never saved. */
  previewEffect: string | null;
  /** Transition selected on the timeline (edited in the Effects panel). */
  selectedTransition: string | null;
  /** The time range the timeline shows (seconds), kept up to date by the timeline for the AI prompt. */
  view: { t0: number; t1: number } | null;
};

export const useTimelineUi = create<TimelineUi>(() => ({ tool: "select", snapping: true, beatSnap: true, selected: [], sourceId: null, guide: null, mode: null, previewEffect: null, selectedTransition: null, view: null }));

export const TOOL_KEYS: Record<string, Tool> = { KeyA: "select", KeyT: "trim", KeyB: "blade", KeyH: "hand", KeyZ: "zoom" };

export const MODE_HINT: Record<PointerMode, string> = {
  move: "Move",
  "trim-start": "Trim the start",
  "trim-end": "Trim the end",
  "ripple-start": "Ripple trim the start (later clips follow)",
  "ripple-end": "Ripple trim the end (later clips follow)",
  roll: "Roll the cut between two clips",
  slip: "Slip: show another part of the source",
  slide: "Slide: move between the neighbours",
  blade: "Cut here",
  hand: "Scroll",
  zoom: "Zoom in (Alt: out)",
};

export const CURSOR: Record<PointerMode, string> = {
  move: "grab",
  "trim-start": "w-resize",
  "trim-end": "e-resize",
  "ripple-start": "w-resize",
  "ripple-end": "e-resize",
  roll: "col-resize",
  slip: "ew-resize",
  slide: "move",
  blade: "crosshair",
  hand: "grab",
  zoom: "zoom-in",
};

export const tlNow = (): Timeline => activeTimeline(useProject.getState().doc);

/** Edit context for the active document: frame rate and media lengths (so trims stop at the ends of sources). */
export function editCtx(doc: ProjectDoc = useProject.getState().doc): EditCtx {
  return { fps: doc.settings.fps, mediaDuration: (id) => doc.media.find((m) => m.id === id)?.duration };
}

/** Apply an engine edit to the active timeline as one undo step (or merged with the same key). */
export function editTimeline(fn: (tl: Timeline) => Timeline, key?: string) {
  useProject.getState().editDoc((doc) => onActive(doc, fn), key);
}

/** The document's media entry for a pool item (added when the item is first used on a timeline). */
export const poolMediaId = (poolId: string) => `pm-${poolId}`;

export function withPoolMedia(doc: ProjectDoc, item: MediaItem): ProjectDoc {
  const id = poolMediaId(item.id);
  const ref: MediaRef = {
    id,
    name: item.name,
    kind: item.kind === "audio" ? "audio" : item.kind === "image" ? "image" : "video",
    fileKey: `m/${item.id}`,
    poolId: item.id,
    ...(item.duration !== undefined ? { duration: item.duration } : {}),
    ...(item.width !== undefined ? { width: item.width, height: item.height } : {}),
    ...(item.fps !== undefined ? { fps: item.fps } : {}),
    ...(item.hasAudio !== undefined ? { hasAudio: item.hasAudio } : {}),
    ...(item.note ? { note: item.note } : {}),
  };
  const cur = doc.media.find((m) => m.id === id);
  // a timecode typed by hand wins over the one read from the file
  const tc = cur?.timecode ?? item.timecode;
  if (tc !== undefined) ref.timecode = tc;
  if (cur && JSON.stringify(cur) === JSON.stringify(ref)) return doc;
  return { ...doc, media: cur ? doc.media.map((m) => (m.id === id ? ref : m)) : [...doc.media, ref] };
}

/** Images have no length of their own; they go in for this many seconds. */
export const IMAGE_SECONDS = 5;

/** A pool item as an edit source, using its source marks when set. */
export function sourceOf(item: MediaItem): Source | null {
  if (item.kind !== "video" && item.kind !== "audio" && item.kind !== "image") return null;
  const len = item.kind === "image" ? IMAGE_SECONDS : item.duration ?? IMAGE_SECONDS;
  const a = Math.max(0, Math.min(item.markIn ?? 0, len));
  const b = Math.max(a + 0.04, Math.min(item.markOut ?? len, len));
  return { mediaId: poolMediaId(item.id), name: item.name, kind: item.kind, in: a, out: b, withAudio: item.kind === "video" && item.hasAudio !== false };
}

/** Whether a drag snaps to beats right now: snapping on (Alt flips it) and the beat toggle on. */
export function beatSnapOn(altKey = false): boolean {
  const ui = useTimelineUi.getState();
  return ui.snapping !== altKey && ui.beatSnap;
}

/** Timecode h:mm:ss:ff (hours only when needed). */
export function timecode(t: number, fps: number): string {
  const total = Math.max(0, Math.round(t * fps));
  const f = total % fps;
  const s = Math.floor(total / fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  return `${hms}:${pad(f)}`;
}
