import { drawFrame, type RenderAssets } from "../lib/renderer";
import { activeTimeline } from "../model/convert";
import { IDENTITY_TRANSFORM, type BlendMode, type Clip, type ClipEffect, type ClipTransform, type ClipTransition, type ProjectDoc, type Timeline, type TrackMatte } from "../model/types";
import { applyStack, getTransition, poolFor, transitionAt, type Layer, type LayerPool } from "../lib/effects";
import { evalNumber, type Key } from "../lib/keyframes/engine";
import { drawGenerator } from "../lib/generators";
import { DEFAULT_TEXT, DEFAULT_TRANSFORM, evaluateGraph, type GraphNode } from "../lib/graph/graph";
import { titleOf } from "../lib/titles";
import { blendFrames, sourceAtRel, speedOf } from "../lib/retime";
import { videoAt } from "../lib/multicam";
import { hasMotion, rotationZoom, stabiliseOffset, stabiliseRotation, stabiliseZoom, trackerAt, trackerMotion, trackerOffset } from "../lib/track/tracker";
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
  softlight: "soft-light",
  hardlight: "hard-light",
  exclusion: "exclusion",
  dodge: "color-dodge",
  burn: "color-burn",
};

/** A clip's placement; with a time, its animated placement at t (timeline seconds) from its keyframe lanes. */
export function transformOf(c: Clip, t?: number, tl?: Timeline, aspect = 16 / 9): ClipTransform {
  const tf: ClipTransform = { ...IDENTITY_TRANSFORM, ...(c.transform ?? {}) };
  if (t === undefined) return tf;
  const rel = t - c.start;
  if (c.anim) {
    for (const name of ["x", "y", "scale", "opacity"] as const) {
      const keys = c.anim[name];
      if (keys?.length) tf[name] = evalNumber(keys as Key[], rel, tf[name]);
    }
    if (c.anim.rotation?.length) tf.rotation = evalNumber(c.anim.rotation as Key[], rel, tf.rotation, "angle");
  }
  if (tl) {
    // pinned to a tracker of another clip: move by what the tracked point has moved since the start
    if (c.follow) {
      const other = tl.clips.find((x) => x.id === c.follow!.clipId);
      const tr = other?.trackers?.find((x) => x.id === c.follow!.trackerId);
      if (other && tr) {
        const rel0 = t - other.start;
        const o = trackerOffset(tr, rel0);
        const m = hasMotion(tr) && (c.follow.rotate || c.follow.scale) ? trackerMotion(tr, rel0) : null;
        if (m) {
          // turning and growing with the surface: the clip's offset from the tracked point turns and grows too (in pixels, then back to frame fractions)
          const p0 = trackerAt(tr, tr.t0);
          const rot = c.follow.rotate ? (m.rot * Math.PI) / 180 : 0;
          const s = c.follow.scale ? m.scale : 1;
          const vx = (tf.x - p0.x) * aspect, vy = tf.y - p0.y;
          const cs = Math.cos(rot) * s, sn = Math.sin(rot) * s;
          const p = trackerAt(tr, rel0);
          tf.x = p.x + (cs * vx - sn * vy) / aspect;
          tf.y = p.y + (sn * vx + cs * vy);
          if (c.follow.rotate) tf.rotation += m.rot;
          tf.scale *= s;
        } else {
          tf.x += o.x;
          tf.y += o.y;
        }
      }
    }
    // steadied from its own tracker: shift against the shake and zoom to hide the borders
    if (c.stabilize) {
      const tr = c.trackers?.find((x) => x.id === c.stabilize!.trackerId);
      if (tr && tr.samples.length) {
        const o = stabiliseOffset(tr, rel, c.stabilize.smoothing);
        tf.x += o.x;
        tf.y += o.y;
        tf.scale *= stabiliseZoom(tr, c.stabilize.smoothing, c.stabilize.zoom);
        if (c.stabilize.rotation && hasMotion(tr)) {
          // also steady the turning: counter-turn the picture and zoom enough to hide the corners that uncovers
          tf.rotation += stabiliseRotation(tr, rel, c.stabilize.smoothing);
          tf.scale *= rotationZoom(tr, c.stabilize.smoothing, aspect);
        }
      }
    }
  }
  return tf;
}

/** Source time shown by a clip at timeline time t. */
export const sourceTime = (c: Clip, t: number) => sourceAtRel(c, t - c.start);

type VisualKind = "video" | "image" | "generator" | "nested";
/**
 * One clip to draw. `mediaId` is set when it differs from the clip's own (the angle of a multicam clip); `st2` and `w2`
 * are the second source frame and its weight for blended slow motion; a nested clip carries its timeline and time.
 */
type Visual = { clip: Clip; kind: VisualKind; st: number; mediaId?: string; st2?: number; w2?: number; nested?: Timeline };
/** One thing to draw on a track at t: a clip, or a transition between two clips (either may be missing at an edge). */
export type PlanItem = { type: "clip"; v: Visual } | { type: "transition"; tr: ClipTransition; p: number; a?: Visual; b?: Visual };

/** Source time kept inside its media (frames just past a cut come from the handles). */
const inside = (st: number, len: number | undefined) => Math.max(0, len !== undefined ? Math.min(st, Math.max(0, len - 0.001)) : st);

function visualOf(c: Clip | undefined, doc: ProjectDoc, t: number): Visual | undefined {
  if (!c || c.fill || !c.enabled) return undefined;
  const rel = t - c.start;
  if (c.timelineId) {
    // a nested timeline: its own time runs from sourceIn at the clip's speed
    const nested = doc.timelines.find((x) => x.id === c.timelineId);
    return nested ? { clip: c, kind: "nested", st: sourceAtRel(c, rel), nested } : undefined;
  }
  if (c.multicam) {
    // the angle on at this time, read at its own offset
    const v = videoAt(c.multicam, sourceAtRel(c, rel));
    const m = v && doc.media.find((x) => x.id === v.angle.mediaId);
    return v && m && (m.kind === "video" || m.kind === "image") ? { clip: c, kind: m.kind, st: inside(v.st, m.duration), mediaId: v.angle.mediaId } : undefined;
  }
  if (!c.mediaId) return c.generator ? { clip: c, kind: "generator", st: 0 } : undefined; // solid, shape, title, noise...
  const m = doc.media.find((x) => x.id === c.mediaId);
  if (!m || (m.kind !== "video" && m.kind !== "image")) return undefined;
  const st = inside(sourceAtRel(c, rel), m.duration);
  const out: Visual = { clip: c, kind: m.kind, st };
  // slow motion between frames: mix the two source frames around the time
  if (c.interp === "blend" && m.kind === "video" && m.fps && speedOf(c, rel) < 0.999) {
    const b = blendFrames(st, m.fps);
    if (b.w > 0) (out.st = b.a), (out.st2 = inside(b.b, m.duration)), (out.w2 = b.w);
  }
  return out;
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
export function activeVisuals(tl: Timeline, doc: ProjectDoc, t: number): { clip: Clip; kind: VisualKind }[] {
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

/** Where the clip's first tracker is, as a move since its start (what a "follow the tracker" mask adds), in clip time. */
function trackerShift(c: Clip, rel: number): { x: number; y: number } | undefined {
  const tr = c.trackers?.[0];
  return tr && tr.samples.length ? trackerOffset(tr, rel) : undefined;
}

/** Run a clip's node graph: the picture goes in at the input node, effects and merges run in order, the output (or the previewed node) comes out. */
function runGraph(src: Layer, c: Clip, rel: number, w: number, h: number, pool: LayerPool, track?: { x: number; y: number }): Layer {
  const out = evaluateGraph<Layer>(c.graph!, {
    input: () => src,
    effect: (n: GraphNode, s: Layer) => applyStack(s, [{ id: n.id, type: n.effect!.type, enabled: true, params: n.effect!.params, ...(n.effect!.keys ? { keys: n.effect!.keys } : {}) }], rel, c.duration, pool, track),
    merge: (n: GraphNode, bg: Layer | null, fg: Layer | null) => {
      if (!bg && !fg) return null;
      const l = pool.take();
      if (bg) l.ctx.drawImage(bg.canvas, 0, 0);
      if (fg) {
        l.ctx.save();
        l.ctx.globalAlpha = Math.max(0, Math.min(1, n.merge?.opacity ?? 1));
        l.ctx.globalCompositeOperation = BLEND_OP[n.merge?.mode ?? "normal"] ?? "source-over";
        l.ctx.drawImage(fg.canvas, 0, 0);
        l.ctx.restore();
      }
      return l;
    },
    generator: (n: GraphNode) => {
      if (!n.generator) return null;
      const l = pool.take();
      drawGenerator(l.ctx, n.generator, rel, c.duration, w, h);
      return l;
    },
    // transform node: move, scale, turn and fade the picture about the centre of the frame
    transform: (n: GraphNode, s: Layer) => {
      const t = { ...DEFAULT_TRANSFORM, ...(n.transform ?? {}) };
      const l = pool.take();
      l.ctx.save();
      l.ctx.globalAlpha = Math.max(0, Math.min(1, t.opacity));
      l.ctx.translate(w / 2 + t.x * w, h / 2 + t.y * h);
      l.ctx.rotate((t.rotation * Math.PI) / 180);
      l.ctx.scale(t.scale, t.scale);
      l.ctx.translate(-w / 2, -h / 2);
      l.ctx.drawImage(s.canvas, 0, 0);
      l.ctx.restore();
      return l;
    },
    // mask node: a connected matte cuts the picture by its alpha, else the node's own mask shape does
    mask: (n: GraphNode, s: Layer, matte: Layer | null) => {
      if (matte) {
        const l = pool.take();
        l.ctx.drawImage(s.canvas, 0, 0);
        l.ctx.globalCompositeOperation = "destination-in";
        l.ctx.drawImage(matte.canvas, 0, 0);
        l.ctx.globalCompositeOperation = "source-over";
        return l;
      }
      return applyStack(s, [{ id: n.id, type: "mask", enabled: true, params: n.mask?.params ?? {}, ...(n.mask?.keys ? { keys: n.mask.keys } : {}) }], rel, c.duration, pool, track);
    },
    text: (n: GraphNode) => {
      const t = { ...DEFAULT_TEXT, ...(n.text ?? {}) };
      const l = pool.take();
      drawGenerator(l.ctx, { type: "title", title: titleOf({ text: t.text, color: t.color, size: t.size, x: t.x, y: t.y, ...(t.font ? { font: t.font } : {}) }) }, rel, c.duration, w, h);
      return l;
    },
  });
  return out ?? pool.take(); // a disconnected output shows nothing
}

/** A clip drawn into a frame-sized layer (with its placement and opacity) and run through its node graph or effect stack. */
function clipLayer(v: Visual, pic: Picture, t: number, w: number, h: number, pool: LayerPool, tl: Timeline, preview?: PreviewEffect) {
  const layer = pool.take();
  drawPicture(layer.ctx as CanvasRenderingContext2D, pic, { ...transformOf(v.clip, t, tl, w / h), blend: "normal" }, w, h);
  const rel = t - v.clip.start;
  const track = trackerShift(v.clip, rel);
  if (v.clip.graph) return runGraph(layer, v.clip, rel, w, h, pool, track);
  return applyStack(layer, effectsOf(v.clip, preview), rel, v.clip.duration, pool, track);
}

/**
 * Cut `out` to a matte layer: alpha uses the matte's own transparency, luma its brightness (times its alpha);
 * the inverted modes keep what the matte leaves out.
 */
export function applyMatte(out: Layer, matte: Layer, mode: TrackMatte["mode"], pool: LayerPool) {
  const ctx = out.ctx as CanvasRenderingContext2D;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (mode === "alpha" || mode === "alpha-inverted") {
    ctx.globalCompositeOperation = mode === "alpha" ? "destination-in" : "destination-out";
    ctx.drawImage(matte.canvas, 0, 0);
  } else {
    const tmp = pool.take();
    const img = (matte.ctx as CanvasRenderingContext2D).getImageData(0, 0, matte.w, matte.h);
    const d = img.data;
    const inv = mode === "luma-inverted";
    for (let i = 0; i < d.length; i += 4) {
      // premultiplied-looking luma: a transparent matte pixel counts as black
      const luma = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      const a = luma * (d[i + 3] / 255);
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round((inv ? 1 - a : a) * 255);
    }
    (tmp.ctx as CanvasRenderingContext2D).putImageData(img, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(tmp.canvas, 0, 0);
  }
  ctx.restore();
}

/** Draw the active timeline's video and image tracks at t. Returns how many clips had no picture ready yet. */
export function compositeVisuals(ctx: CanvasRenderingContext2D, doc: ProjectDoc, t: number, w: number, h: number, frames: FrameProvider, preview?: PreviewEffect): number {
  return compositeTimeline(ctx, doc, activeTimeline(doc), t, w, h, frames, preview, 0);
}

/** Layers for blended frames, kept per clip so two blended clips in one frame do not share a canvas. */
const blendCanvases = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
const NEST_LIMIT = 4;

/** Draw any timeline's tracks at t; nested clips draw their own timeline through the same path (up to NEST_LIMIT deep). */
function compositeTimeline(ctx: CanvasRenderingContext2D, doc: ProjectDoc, tl: Timeline, t: number, w: number, h: number, frames: FrameProvider, preview: PreviewEffect | undefined, depth: number): number {
  let missing = 0;
  let pool: LayerPool | null = null;
  const layers = () => (pool ??= poolFor(w, h));
  const pictureOf = (v: Visual): Picture | null => {
    if (v.kind === "nested") {
      if (depth >= NEST_LIMIT || !v.nested) return null;
      const l = layers().take();
      missing += compositeTimeline(l.ctx as CanvasRenderingContext2D, doc, v.nested, v.st, w, h, frames, undefined, depth + 1);
      return l.canvas as Picture;
    }
    if (v.kind === "generator") {
      // a generator draws itself into a frame-sized layer, which then goes through the clip's transform like a picture
      const l = layers().take();
      drawGenerator(l.ctx, v.clip.generator!, t - v.clip.start, v.clip.duration, w, h);
      return l.canvas as Picture;
    }
    const id = v.mediaId ?? v.clip.mediaId!;
    const pic = frames.picture(id, v.kind, v.st);
    if (!pic) missing++;
    if (pic && v.st2 !== undefined && v.w2) {
      const pic2 = frames.picture(id, v.kind, v.st2);
      if (pic2) {
        const key = `${v.clip.id}:${pic.width}x${pic.height}`;
        let cv = blendCanvases.get(key);
        if (!cv) {
          if (blendCanvases.size > 8) blendCanvases.clear();
          cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(pic.width, pic.height) : Object.assign(document.createElement("canvas"), { width: pic.width, height: pic.height });
          blendCanvases.set(key, cv);
        }
        const bctx = cv.getContext("2d") as CanvasRenderingContext2D;
        bctx.globalAlpha = 1;
        bctx.clearRect(0, 0, pic.width, pic.height);
        bctx.drawImage(pic, 0, 0, pic.width, pic.height);
        bctx.globalAlpha = v.w2;
        bctx.drawImage(pic2, 0, 0, pic.width, pic.height);
        bctx.globalAlpha = 1;
        return cv as Picture;
      }
    }
    return pic;
  };
  const plan = visualPlan(tl, doc, t);
  // clips used as another clip's matte are not drawn themselves
  const matteIds = new Set<string>();
  for (const item of plan) if (item.type === "clip" && item.v.clip.matte) matteIds.add(item.v.clip.matte.clipId);
  const matteLayer = (id: string): Layer | null => {
    const mc = tl.clips.find((x) => x.id === id);
    if (!mc || t < mc.start || t >= mc.start + mc.duration) return null;
    const v = visualOf(mc, doc, t);
    const pic = v && pictureOf(v);
    return v && pic ? clipLayer(v, pic, t, w, h, layers(), tl, preview) : null;
  };
  for (const item of plan) {
    if (item.type === "clip") {
      if (matteIds.has(item.v.clip.id)) continue;
      const pic = pictureOf(item.v);
      if (!pic) continue;
      const c = item.v.clip;
      if (!effectsOf(c, preview).length && !c.graph && !c.matte) {
        drawPicture(ctx, pic, transformOf(c, t, tl), w, h); // no effects: the direct path of phase 15
        continue;
      }
      const out = clipLayer(item.v, pic, t, w, h, layers(), tl, preview);
      if (c.matte) {
        const ml = matteLayer(c.matte.clipId);
        if (ml) applyMatte(out, ml, c.matte.mode, layers());
      }
      ctx.save();
      ctx.globalCompositeOperation = BLEND_OP[transformOf(c).blend] ?? "source-over";
      ctx.drawImage(out.canvas, 0, 0);
      ctx.restore();
      continue;
    }
    // a transition: both sides as layers (with their effects), mixed by the transition
    const def = getTransition(item.tr.type)!;
    const pa = item.a && pictureOf(item.a);
    const pb = item.b && pictureOf(item.b);
    const la = item.a && pa ? clipLayer(item.a, pa, t, w, h, layers(), tl, preview) : null;
    const lb = item.b && pb ? clipLayer(item.b, pb, t, w, h, layers(), tl, preview) : null;
    const mix = layers().take();
    def.render(mix.ctx, la, lb, item.p, item.tr.params, { w, h, scratch: () => layers().take() });
    ctx.drawImage(mix.canvas, 0, 0);
  }
  (pool as LayerPool | null)?.reset();
  return missing;
}

/** What export must decode before drawing the frame at t (both sides of a running transition, nested timelines and blended frames too). */
export function needsAt(doc: ProjectDoc, t: number, tl: Timeline = activeTimeline(doc), depth = 0): { mediaId: string; kind: "video" | "image"; sourceTime: number }[] {
  const out: { mediaId: string; kind: "video" | "image"; sourceTime: number }[] = [];
  for (const i of visualPlan(tl, doc, t)) {
    for (const v of i.type === "clip" ? [i.v] : [i.a, i.b]) {
      if (!v || v.kind === "generator") continue;
      if (v.kind === "nested") {
        if (depth < NEST_LIMIT && v.nested) out.push(...needsAt(doc, v.st, v.nested, depth + 1));
        continue;
      }
      const id = v.mediaId ?? v.clip.mediaId!;
      out.push({ mediaId: id, kind: v.kind, sourceTime: v.st });
      if (v.st2 !== undefined) out.push({ mediaId: id, kind: v.kind, sourceTime: v.st2 });
    }
  }
  return out;
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
  for (const tl of doc.timelines) {
    for (const c of tl.clips) {
      if (c.mediaId && !c.fill) ids.add(c.mediaId);
      for (const a of c.multicam?.angles ?? []) ids.add(a.mediaId); // every angle stays open so a switch is instant
    }
  }
  return ids;
}
