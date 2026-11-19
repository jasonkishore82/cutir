import { drawFrame, type RenderAssets } from "../lib/renderer";
import { activeTimeline } from "../model/convert";
import { IDENTITY_TRANSFORM, type BlendMode, type Clip, type ClipTransform, type ProjectDoc, type Timeline } from "../model/types";
import type { Project } from "../store/project";
import type { FrameProvider, Picture } from "./sources";

/**
 * The compositor: one frame of the whole timeline.
 *
 *   lyric background  ->  video and image tracks, bottom to top  ->  lyric text (subtitle tracks)
 *
 * Every visible video or image clip under the playhead becomes a picture drawn with its transform, opacity and blend
 * mode. Pictures come from a FrameProvider: the live one for the viewer, the exact one for export. Both feed this
 * same function, so the viewer and the exported file show the same frame for the same time.
 */

export const BLEND_OP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  add: "lighter",
  difference: "difference",
};

export const transformOf = (c: Clip): ClipTransform => ({ ...IDENTITY_TRANSFORM, ...(c.transform ?? {}) });

/** Source time shown by a clip at timeline time t. */
export const sourceTime = (c: Clip, t: number) => c.sourceIn + (t - c.start) * c.speed;

/** Video and image clips to draw at t, bottom track first. Hidden tracks, disabled clips and fill clips are skipped. */
export function activeVisuals(tl: Timeline, doc: ProjectDoc, t: number): { clip: Clip; kind: "video" | "image" }[] {
  const out: { clip: Clip; kind: "video" | "image" }[] = [];
  for (const track of tl.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    for (const c of tl.clips) {
      if (c.trackId !== track.id || c.fill || !c.enabled || !c.mediaId || t < c.start || t >= c.start + c.duration) continue;
      const m = doc.media.find((x) => x.id === c.mediaId);
      if (!m || (m.kind !== "video" && m.kind !== "image")) continue;
      out.push({ clip: c, kind: m.kind });
    }
  }
  return out;
}

/** The size of a picture fitted into the frame before the clip's own scale. */
export function fitSize(pw: number, ph: number, w: number, h: number, fit: ClipTransform["fit"]): { w: number; h: number } {
  if (fit === "fill" || !pw || !ph) return { w, h };
  const s = fit === "cover" ? Math.max(w / pw, h / ph) : Math.min(w / pw, h / ph);
  return { w: pw * s, h: ph * s };
}

/** Draw one picture with a clip transform. */
export function drawPicture(ctx: CanvasRenderingContext2D, pic: Picture, tf: ClipTransform, w: number, h: number) {
  if (tf.opacity <= 0 || tf.scale <= 0) return;
  const size = fitSize(pic.width, pic.height, w, h, tf.fit);
  ctx.save();
  ctx.globalAlpha = Math.min(1, tf.opacity);
  ctx.globalCompositeOperation = BLEND_OP[tf.blend] ?? "source-over";
  ctx.translate(tf.x * w, tf.y * h);
  if (tf.rotation) ctx.rotate((tf.rotation * Math.PI) / 180);
  ctx.scale(tf.scale, tf.scale);
  ctx.drawImage(pic, -size.w / 2, -size.h / 2, size.w, size.h);
  ctx.restore();
}

/** Draw the timeline's video and image tracks at t. Returns how many clips had no picture ready yet. */
export function compositeVisuals(ctx: CanvasRenderingContext2D, doc: ProjectDoc, t: number, w: number, h: number, frames: FrameProvider): number {
  const tl = activeTimeline(doc);
  let missing = 0;
  for (const { clip, kind } of activeVisuals(tl, doc, t)) {
    const pic = frames.picture(clip.mediaId!, kind, sourceTime(clip, t));
    if (!pic) {
      missing++;
      continue;
    }
    drawPicture(ctx, pic, transformOf(clip), w, h);
  }
  return missing;
}

/** What export must decode before drawing the frame at t. */
export function needsAt(doc: ProjectDoc, t: number) {
  return activeVisuals(activeTimeline(doc), doc, t).map(({ clip, kind }) => ({ mediaId: clip.mediaId!, kind, sourceTime: sourceTime(clip, t) }));
}

/** One whole frame: lyric background, timeline pictures, lyric text. Used by the viewer and by export. */
export function renderFrame(ctx: CanvasRenderingContext2D, doc: ProjectDoc, view: Project, t: number, w: number, h: number, assets: RenderAssets, frames: FrameProvider): number {
  let missing = 0;
  drawFrame(ctx, view, t, w, h, assets, (c) => {
    missing = compositeVisuals(c, doc, t, w, h, frames);
  });
  return missing;
}

/** Media ids the timeline uses for pictures (to keep their decoders open). */
export function visualMediaIds(doc: ProjectDoc): Set<string> {
  const ids = new Set<string>();
  for (const tl of doc.timelines) for (const c of tl.clips) if (c.mediaId && !c.fill) ids.add(c.mediaId);
  return ids;
}
