import { drawFrame, type RenderAssets } from "../lib/renderer";
import { activeTimeline } from "../model/convert";
import { IDENTITY_TRANSFORM, type BlendMode, type Clip, type ClipEffect, type ClipTransform, type ClipTransition, type ProjectDoc, type Timeline } from "../model/types";
import { applyStack, getTransition, poolFor, transitionAt, type LayerPool } from "../lib/effects";
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

type Visual = { clip: Clip; kind: "video" | "image"; st: number };
/** One thing to draw on a track at t: a clip, or a transition between two clips (either may be missing at an edge). */
export type PlanItem = { type: "clip"; v: Visual } | { type: "transition"; tr: ClipTransition; p: number; a?: Visual; b?: Visual };

/** Source time of a clip at t, kept inside its media (frames just past a cut come from the handles). */
function stOf(c: Clip, t: number, doc: ProjectDoc): number {
  const len = doc.media.find((m) => m.id === c.mediaId)?.duration;
  const st = sourceTime(c, t);
  return Math.max(0, len !== undefined ? Math.min(st, Math.max(0, len - 0.001)) : st);
}

function visualOf(c: Clip | undefined, doc: ProjectDoc, t: number): Visual | undefined {
  if (!c || c.fill || !c.enabled || !c.mediaId) return undefined;
  const m = doc.media.find((x) => x.id === c.mediaId);
  if (!m || (m.kind !== "video" && m.kind !== "image")) return undefined;
  return { clip: c, kind: m.kind, st: stOf(c, t, doc) };
}

/**
 * What to draw at t, bottom track first: on each visible video track either the transition running there, or the
 * clips under the playhead. Hidden tracks, disabled clips and fill clips are skipped.
 */
export function visualPlan(tl: Timeline, doc: ProjectDoc, t: number): PlanItem[] {
  const out: PlanItem[] = [];
  for (const track of tl.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    const tr = transitionAt(tl, track.id, t);
    if (tr && getTransition(tr.tr.type)) {
      const a = visualOf(tr.from, doc, t);
      const b = visualOf(tr.to, doc, t);
      if (a || b) {
        out.push({ type: "transition", tr: tr.tr, p: tr.p, a, b });
        continue;
      }
    }
    for (const c of tl.clips) {
      if (c.trackId !== track.id || t < c.start || t >= c.start + c.duration) continue;
      const v = visualOf(c, doc, t);
      if (v) out.push({ type: "clip", v });
    }
  }
  return out;
}

/** Video and image clips to draw at t (including both sides of a running transition), bottom track first. */
export function activeVisuals(tl: Timeline, doc: ProjectDoc, t: number): { clip: Clip; kind: "video" | "image" }[] {
  return visualPlan(tl, doc, t).flatMap((i) => (i.type === "clip" ? [i.v] : [i.a, i.b].filter((x): x is Visual => !!x))).map(({ clip, kind }) => ({ clip, kind }));
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

/** A temporary extra effect on some clips (the Effects panel's hover preview). Viewer only, never exported. */
export type PreviewEffect = { clipIds: Set<string>; effect: ClipEffect };

const effectsOf = (c: Clip, preview?: PreviewEffect) => {
  const own = c.effects.filter((e) => e.enabled);
  return preview?.clipIds.has(c.id) ? [...own, preview.effect] : own;
};

/** A clip drawn into a frame-sized layer (with its placement and opacity) and run through its effect stack. */
function clipLayer(v: Visual, pic: Picture, t: number, w: number, h: number, pool: LayerPool, preview?: PreviewEffect) {
  const layer = pool.take();
  drawPicture(layer.ctx as CanvasRenderingContext2D, pic, { ...transformOf(v.clip), blend: "normal" }, w, h);
  return applyStack(layer, effectsOf(v.clip, preview), t - v.clip.start, v.clip.duration, pool);
}

/** Draw the timeline's video and image tracks at t. Returns how many clips had no picture ready yet. */
export function compositeVisuals(ctx: CanvasRenderingContext2D, doc: ProjectDoc, t: number, w: number, h: number, frames: FrameProvider, preview?: PreviewEffect): number {
  const tl = activeTimeline(doc);
  let missing = 0;
  let pool: LayerPool | null = null;
  const layers = () => (pool ??= poolFor(w, h));
  const pictureOf = (v: Visual) => {
    const pic = frames.picture(v.clip.mediaId!, v.kind, v.st);
    if (!pic) missing++;
    return pic;
  };
  for (const item of visualPlan(tl, doc, t)) {
    if (item.type === "clip") {
      const pic = pictureOf(item.v);
      if (!pic) continue;
      if (!effectsOf(item.v.clip, preview).length) {
        drawPicture(ctx, pic, transformOf(item.v.clip), w, h); // no effects: the direct path of phase 15
        continue;
      }
      const out = clipLayer(item.v, pic, t, w, h, layers(), preview);
      ctx.save();
      ctx.globalCompositeOperation = BLEND_OP[transformOf(item.v.clip).blend] ?? "source-over";
      ctx.drawImage(out.canvas, 0, 0);
      ctx.restore();
      continue;
    }
    // a transition: both sides as layers (with their effects), mixed by the transition
    const def = getTransition(item.tr.type)!;
    const pa = item.a && pictureOf(item.a);
    const pb = item.b && pictureOf(item.b);
    const la = item.a && pa ? clipLayer(item.a, pa, t, w, h, layers(), preview) : null;
    const lb = item.b && pb ? clipLayer(item.b, pb, t, w, h, layers(), preview) : null;
    const mix = layers().take();
    def.render(mix.ctx, la, lb, item.p, item.tr.params, { w, h, scratch: () => layers().take() });
    ctx.drawImage(mix.canvas, 0, 0);
  }
  (pool as LayerPool | null)?.reset();
  return missing;
}

/** What export must decode before drawing the frame at t (both sides of a running transition too). */
export function needsAt(doc: ProjectDoc, t: number) {
  return visualPlan(activeTimeline(doc), doc, t)
    .flatMap((i) => (i.type === "clip" ? [i.v] : [i.a, i.b].filter((x): x is Visual => !!x)))
    .map((v) => ({ mediaId: v.clip.mediaId!, kind: v.kind, sourceTime: v.st }));
}

/** One whole frame: lyric background, timeline pictures, lyric text. Used by the viewer and by export. */
export function renderFrame(ctx: CanvasRenderingContext2D, doc: ProjectDoc, view: Project, t: number, w: number, h: number, assets: RenderAssets, frames: FrameProvider, preview?: PreviewEffect): number {
  let missing = 0;
  drawFrame(ctx, view, t, w, h, assets, (c) => {
    missing = compositeVisuals(c, doc, t, w, h, frames, preview);
  });
  return missing;
}

/** Media ids the timeline uses for pictures (to keep their decoders open). */
export function visualMediaIds(doc: ProjectDoc): Set<string> {
  const ids = new Set<string>();
  for (const tl of doc.timelines) for (const c of tl.clips) if (c.mediaId && !c.fill) ids.add(c.mediaId);
  return ids;
}
