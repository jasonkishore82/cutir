import { create } from "zustand";
import type { ProjectDoc } from "../../model/types";
import { activeTimeline } from "../../model/convert";
import { drawPicture, sourceTime, transformOf } from "../../render/compositor";
import { exactFrames } from "../../render/sources";
import { toGray, type TrackSample } from "./tracker";
import { createMatcher, followFrames, type Matcher } from "./matcher";
import type { TrackSpec } from "./session";

/** The point (or region) being placed for the next track: shown in the viewer. */
export type TrackTarget = { x: number; y: number; /** Region size for a planar tracker, 0..1 of the frame. */ w: number; h: number };
export const useTrackUi = create<{ clipId: string | null; x: number; y: number; w: number; h: number; mode: "point" | "planar"; set: (p: Partial<{ clipId: string | null; x: number; y: number; w: number; h: number; mode: "point" | "planar" }>) => void }>((set) => ({
  clipId: null,
  x: 0.5,
  y: 0.5,
  w: 0.3,
  h: 0.3,
  mode: "point",
  set: (p) => set(p),
}));

export type TrackResult = { samples: TrackSample[]; /** Why it stopped early, if it did. */ lost?: string; /** Whether the matching ran in a worker. */ inWorker?: boolean };

export type TrackRequest = { mode: "point"; x: number; y: number } | { mode: "planar"; x: number; y: number; w: number; h: number };

/**
 * Follow a point or a flat region through a clip's picture, frame by frame, from the start of the clip. The frames are
 * the exact ones the export would use, drawn with the clip's own placement at a small size, so positions are fractions
 * of the frame. The page draws frames; the matching runs in a worker (the next frame is drawn while one is matched).
 */
export async function trackClip(doc: ProjectDoc, clipId: string, req: TrackRequest, o: { onProgress?: (f: number) => void; signal?: AbortSignal; width?: number; fps?: number; matcher?: Matcher } = {}): Promise<TrackResult> {
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
  const total = Math.max(1, Math.floor(clip.duration * fps)) + 1;
  const matcher = o.matcher ?? createMatcher();
  const relOf = (i: number) => Math.min(clip.duration - 1e-3, i / fps);

  const frame = async (i: number) => {
    const t = clip.start + relOf(i);
    const need = { mediaId: media.id, kind: media.kind as "video" | "image", sourceTime: Math.max(0, Math.min(sourceTime(clip, t), (media.duration ?? Infinity) - 0.001)) };
    await frames.prepare([need]);
    const pic = frames.picture(need.mediaId, need.kind, need.sourceTime);
    if (!pic) return null;
    ctx.clearRect(0, 0, W, H);
    drawPicture(ctx, pic, { ...transformOf(clip, t), blend: "normal", opacity: 1 }, W, H);
    return toGray(ctx.getImageData(0, 0, W, H).data, W, H);
  };
  const spec = (): TrackSpec =>
    req.mode === "point"
      ? { mode: "point", x: req.x * W, y: req.y * H, radius: Math.max(6, Math.round(W / 40)) }
      : { mode: "planar", region: { x: (req.x - req.w / 2) * W, y: (req.y - req.h / 2) * H, w: req.w * W, h: req.h * H } };

  try {
    const r = await followFrames(matcher, total, frame, spec, { signal: o.signal, onStep: (i) => o.onProgress?.(i / total) });
    const samples: TrackSample[] = r.steps.map((s, i) => ({ t: relOf(i), x: s.x / W, y: s.y / H, c: s.c, ...(s.rot !== undefined ? { rot: s.rot, scale: s.scale } : {}) }));
    // the first sample is exactly where the user put the point
    if (samples.length) (samples[0].x = req.x), (samples[0].y = req.y);
    o.onProgress?.(1);
    const lost = r.cancelled ? "Cancelled" : r.frameError ? "A frame could not be decoded" : r.lostAt !== undefined ? `The ${req.mode === "planar" ? "surface" : "point"} was lost at ${relOf(r.lostAt).toFixed(1)} s` : undefined;
    return { samples, lost, inWorker: matcher.inWorker };
  } finally {
    matcher.close();
  }
}
