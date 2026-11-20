import { create } from "zustand";
import type { ProjectDoc } from "../../model/types";
import { activeTimeline } from "../../model/convert";
import { drawPicture, sourceTime, transformOf } from "../../render/compositor";
import { exactFrames } from "../../render/sources";
import { PointTracker, toGray, type TrackSample } from "./tracker";

/** The point being placed for the next track: shown as a crosshair in the viewer. */
export const useTrackUi = create<{ clipId: string | null; x: number; y: number; set: (p: Partial<{ clipId: string | null; x: number; y: number }>) => void }>((set) => ({
  clipId: null,
  x: 0.5,
  y: 0.5,
  set: (p) => set(p),
}));

export type TrackResult = { samples: TrackSample[]; /** Why it stopped early, if it did. */ lost?: string };

/**
 * Follow a point through a clip's picture, frame by frame, from the start of the clip. The frames are the exact ones
 * the export would use, drawn with the clip's own placement at a small size, so the point is in frame fractions.
 * Runs on the main thread in small steps (it yields between frames, so the editor stays usable).
 */
export async function trackClip(doc: ProjectDoc, clipId: string, start: { x: number; y: number }, o: { onProgress?: (f: number) => void; signal?: AbortSignal; width?: number; fps?: number } = {}): Promise<TrackResult> {
  const tl = activeTimeline(doc);
  const clip = tl.clips.find((c) => c.id === clipId);
  const media = doc.media.find((m) => m.id === clip?.mediaId);
  if (!clip || !media || (media.kind !== "video" && media.kind !== "image")) throw new Error("Only a video clip can be tracked.");
  const W = o.width ?? 480;
  const H = Math.max(1, Math.round((W * doc.settings.height) / doc.settings.width));
  const fps = Math.min(o.fps ?? doc.settings.fps, 30);
  const frames = exactFrames("playback");
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const total = Math.max(1, Math.floor(clip.duration * fps));
  const samples: TrackSample[] = [];
  let tracker: PointTracker | null = null;
  for (let i = 0; i <= total; i++) {
    if (o.signal?.aborted) return { samples, lost: "Cancelled" };
    const rel = Math.min(clip.duration - 1e-3, i / fps);
    const t = clip.start + rel;
    const need = { mediaId: media.id, kind: media.kind as "video" | "image", sourceTime: Math.max(0, Math.min(sourceTime(clip, t), (media.duration ?? Infinity) - 0.001)) };
    await frames.prepare([need]);
    const pic = frames.picture(need.mediaId, need.kind, need.sourceTime);
    if (!pic) return { samples, lost: "A frame could not be decoded" };
    ctx.clearRect(0, 0, W, H);
    drawPicture(ctx, pic, { ...transformOf(clip, t), blend: "normal", opacity: 1 }, W, H);
    const gray = toGray(ctx.getImageData(0, 0, W, H).data, W, H);
    if (!tracker) {
      tracker = new PointTracker(gray, start.x * W, start.y * H, { radius: Math.max(6, Math.round(W / 40)) });
      samples.push({ t: rel, x: start.x, y: start.y, c: 1 });
    } else {
      const m = tracker.next(gray);
      if (!m) return { samples, lost: `The point was lost at ${rel.toFixed(1)} s` };
      samples.push({ t: rel, x: m.x / W, y: m.y / H, c: m.c });
    }
    if (i % 3 === 0) {
      o.onProgress?.(i / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  o.onProgress?.(1);
  return { samples };
}
