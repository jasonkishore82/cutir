import { create } from "zustand";
import { useProject } from "../store/project";
import { useMedia } from "../store/media";
import { activeTimeline } from "../model/convert";
import { exactFrames } from "../render/sources";
import { sourceTime } from "../render/compositor";
import * as E from "../timeline/engine";
import { poolMediaId, useTimelineUi, withPoolMedia } from "../timeline/ui";
import type { Clip } from "../model/types";

/** The nested timelines that were opened to edit inside, outermost first (the breadcrumb of phase 23). */
export const useNest = create<{ trail: string[]; set: (t: string[]) => void }>((set) => ({ trail: [], set: (trail) => set({ trail }) }));

/** Show another timeline in the editor (not an undo step). */
export function openTimeline(id: string, pushFrom?: string) {
  const st = useProject.getState();
  if (!st.doc.timelines.some((t) => t.id === id)) return;
  const nest = useNest.getState();
  useTimelineUi.setState({ selected: [] });
  if (pushFrom !== undefined) nest.set([...nest.trail, pushFrom]);
  else {
    // jumping to a timeline already on the trail pops back to it; anything else starts a fresh trail
    const at = nest.trail.indexOf(id);
    nest.set(at >= 0 ? nest.trail.slice(0, at) : []);
  }
  st.setActiveTimeline(id);
}

/** One source frame of a video clip, as a PNG, exactly as the export would decode it. */
export async function grabFrame(clip: Clip, sourceSeconds: number): Promise<Blob> {
  const doc = useProject.getState().doc;
  const media = doc.media.find((m) => m.id === clip.mediaId);
  if (!media || media.kind !== "video") throw new Error("Only a video clip has a frame to freeze.");
  const st = Math.max(0, Math.min(sourceSeconds, (media.duration ?? Infinity) - 0.001));
  const frames = exactFrames("export");
  await frames.prepare([{ mediaId: media.id, kind: "video", sourceTime: st }]);
  const pic = frames.picture(media.id, "video", st);
  if (!pic) throw new Error("That frame could not be decoded.");
  const canvas = document.createElement("canvas");
  canvas.width = pic.width;
  canvas.height = pic.height;
  canvas.getContext("2d")!.drawImage(pic, 0, 0);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("The frame could not be saved"))), "image/png"));
}

/**
 * Freeze: the frame of `clip` at `where` becomes a still image on the timeline, `seconds` long, with everything after
 * it moved later. "playhead" cuts the clip there first; "start" and "end" hold the clip's first or last frame.
 */
export async function freezeFrame(clipId: string, where: "playhead" | "start" | "end", playhead: number, seconds = 2): Promise<string> {
  const doc0 = useProject.getState().doc;
  const clip = activeTimeline(doc0).clips.find((c) => c.id === clipId);
  if (!clip) throw new Error("Select a clip first.");
  const fps = doc0.settings.fps;
  const at = where === "start" ? clip.start : where === "end" ? E.clipEnd(clip) : Math.min(E.clipEnd(clip) - 1e-3, Math.max(clip.start, playhead));
  const rel = where === "end" ? clip.duration - 1 / fps : where === "start" ? 0 : at - clip.start;
  const blob = await grabFrame(clip, sourceTime(clip, clip.start + Math.max(0, rel)));
  const file = new File([blob], `Freeze ${clip.name ?? "frame"} ${Date.now().toString(36)}.png`, { type: "image/png" });
  const item = (await useMedia.getState().addFiles([file]))[0];
  if (!item) throw new Error("The still could not be added to the media pool.");
  useProject.getState().editDoc((d) => {
    const withMedia = withPoolMedia(d, item);
    return E.onActive(withMedia, (tl) => {
      let t = tl;
      if (where === "playhead") t = E.blade(t, at, [clipId]); // the cut: the still goes between the two halves
      const src: E.Source = { mediaId: poolMediaId(item.id), name: "Freeze frame", kind: "image", in: 0, out: seconds };
      return E.insertEdit(t, src, at, { video: clip.trackId }).tl;
    });
  });
  return `Froze ${at.toFixed(2)} s for ${seconds} s.`;
}

/** Download the frame in the viewer as a PNG. */
export function downloadViewerFrame(canvas: HTMLCanvasElement | null, name = "still") {
  if (!canvas || !canvas.width) return;
  canvas.toBlob((b) => {
    if (!b) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `${name}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/png");
}

