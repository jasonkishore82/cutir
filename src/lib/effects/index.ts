import { EASINGS } from "../animations";
import type { Clip, ClipEffect, ClipTransition, ParamKey, Timeline } from "../../model/types";
import { runGpu } from "./gpu";
import type { AnyCanvas, Canvas2D, EffectDef, EffectEnv, Layer, ParamSpec, Params, TransitionDef } from "./types";
import { transform } from "./builtins/transform";
import { crop } from "./builtins/crop";
import { blur } from "./builtins/blur";
import { sharpen } from "./builtins/sharpen";
import { glow } from "./builtins/glow";
import { vignette } from "./builtins/vignette";
import { dropShadow } from "./builtins/dropShadow";
import { mask } from "./builtins/mask";
import { chromaKey } from "./builtins/chromaKey";
import { invert } from "./builtins/invert";
import { mirror } from "./builtins/mirror";
import { noise } from "./builtins/noise";
import { pixelate } from "./builtins/pixelate";
import { animate } from "./builtins/animate";
import { BUILTIN_TRANSITIONS } from "./transitions/builtins";

export type * from "./types";

/**
 * The effect and transition registry (phase 17). Built-ins register here at load; plugins call the same
 * `registerEffect` / `registerTransition`. Everything else (inspector, keyframes, chat tools, the compositor) reads
 * the registry, so a new effect appears everywhere once registered.
 */

const effects = new Map<string, EffectDef>();
const transitions = new Map<string, TransitionDef>();

export function registerEffect(def: EffectDef) {
  if (!/^[a-z0-9-]+$/.test(def.id)) throw new Error(`effect id "${def.id}" must be lowercase letters, digits and dashes`);
  effects.set(def.id, def);
}
export function registerTransition(def: TransitionDef) {
  if (!/^[a-z0-9-]+$/.test(def.id)) throw new Error(`transition id "${def.id}" must be lowercase letters, digits and dashes`);
  transitions.set(def.id, def);
}

for (const e of [transform, crop, blur, sharpen, glow, vignette, dropShadow, mask, chromaKey, invert, mirror, noise, pixelate, animate]) registerEffect(e);
for (const t of BUILTIN_TRANSITIONS) registerTransition(t);

export const getEffect = (id: string) => effects.get(id);
export const getTransition = (id: string) => transitions.get(id);
export const listEffects = () => [...effects.values()];
export const listTransitions = () => [...transitions.values()];

/* ---------- params ---------- */

export const defaultParams = (specs: ParamSpec[]): Params => Object.fromEntries(specs.map((s) => [s.key, structuredClone(s.default)]));

let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A new effect for a clip's stack, with default params (overridden by `params`). */
export function newEffect(type: string, params: Params = {}): ClipEffect {
  const def = getEffect(type);
  if (!def) throw new Error(`no effect "${type}". Effects: ${listEffects().map((e) => e.id).join(", ")}`);
  return { id: newId("fx"), type, enabled: true, params: { ...defaultParams(def.params), ...cleanParams(def.params, params) } };
}

/** Keep only known params, clamped to their ranges, coerced to their types. */
export function cleanParams(specs: ParamSpec[], params: Params): Params {
  const out: Params = {};
  for (const s of specs) {
    if (!(s.key in params)) continue;
    const v = params[s.key];
    if (s.type === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[s.key] = Math.min(s.max, Math.max(s.min, n));
    } else if (s.type === "angle") {
      const n = Number(v);
      if (Number.isFinite(n)) out[s.key] = n;
    } else if (s.type === "boolean") out[s.key] = v === true || v === "true";
    else if (s.type === "choice") {
      if (s.options.some((o) => o.value === v)) out[s.key] = v;
    } else if (s.type === "color") {
      if (typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) out[s.key] = v;
    } else if (s.type === "point") {
      const o = v as { x?: unknown; y?: unknown };
      if (o && Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.y))) out[s.key] = { x: Number(o.x), y: Number(o.y) };
    } else if (s.type === "curve" && Array.isArray(v)) out[s.key] = v;
  }
  return out;
}

/** The value of one numeric param at `t` seconds into the clip: its keyframes when it has any, else its value. */
export function keyedValue(keys: ParamKey[] | undefined, t: number, fallback: number): number {
  if (!keys?.length) return fallback;
  const k = [...keys].sort((a, b) => a.t - b.t);
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  const i = k.findIndex((x) => x.t > t);
  const a = k[i - 1];
  const b = k[i];
  const e = EASINGS[a.easing ?? "linear"] ?? EASINGS.linear;
  return a.v + (b.v - a.v) * e((t - a.t) / Math.max(1e-6, b.t - a.t));
}

/** All params of an effect at time t (keyframed ones evaluated). */
export function paramsAt(fx: ClipEffect, t: number): Params {
  if (!fx.keys) return fx.params;
  const out = { ...fx.params };
  for (const [k, keys] of Object.entries(fx.keys)) out[k] = keyedValue(keys, t, typeof fx.params[k] === "number" ? (fx.params[k] as number) : 0);
  return out;
}

/* ---------- layers ---------- */

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Frame-sized layers reused between frames. `take` gives a cleared one; `reset` makes all free again. */
export class LayerPool {
  private all: Layer[] = [];
  private used = 0;
  constructor(public w: number, public h: number) {}
  take(): Layer {
    let l = this.all[this.used];
    if (!l) {
      const canvas = makeCanvas(this.w, this.h);
      l = { canvas, ctx: canvas.getContext("2d") as Canvas2D, w: this.w, h: this.h };
      this.all.push(l);
    }
    this.used++;
    l.ctx.setTransform(1, 0, 0, 1, 0, 0);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.filter = "none";
    l.ctx.clearRect(0, 0, this.w, this.h);
    return l;
  }
  reset() {
    this.used = 0;
  }
}

const pools = new Map<string, LayerPool>();
/** The shared pool for a frame size. */
export function poolFor(w: number, h: number): LayerPool {
  const key = `${w}x${h}`;
  let p = pools.get(key);
  if (!p) {
    if (pools.size > 4) pools.clear(); // sizes change rarely (viewer resize, export); keep memory bounded
    p = new LayerPool(w, h);
    pools.set(key, p);
  }
  return p;
}

/**
 * Run a clip's effect stack over `src` (the clip already drawn into a frame-sized layer). Returns the final layer.
 * Disabled and unknown effects are skipped. The GPU version of an effect is used when WebGL2 works.
 */
export function applyStack(src: Layer, stack: ClipEffect[], time: number, clipDuration: number, pool: LayerPool): Layer {
  let cur = src;
  for (const fx of stack) {
    if (!fx.enabled) continue;
    const def = getEffect(fx.type);
    if (!def) continue;
    const dst = pool.take();
    const env: EffectEnv = { w: src.w, h: src.h, time, clipDuration, scratch: () => pool.take() };
    const p = paramsAt(fx, time);
    if (!(def.gpu && runGpu(def.id, def.gpu, cur, dst, p, env))) def.render(cur, dst, p, env);
    cur = dst;
  }
  return cur;
}

/* ---------- transitions on the timeline ---------- */

/** The time where a transition's cut is: the outgoing clip's end, or the incoming clip's start at an edge. */
export function cutTime(tr: ClipTransition, clips: Map<string, Clip>): number | undefined {
  const a = tr.from ? clips.get(tr.from) : undefined;
  const b = tr.to ? clips.get(tr.to) : undefined;
  if (a) return a.start + a.duration;
  if (b) return b.start;
  return undefined;
}

/** [start, end) of a transition on the timeline. At a single clip edge it always lies inside the clip. */
export function transitionWindow(tr: ClipTransition, clips: Map<string, Clip>): [number, number] | null {
  const cut = cutTime(tr, clips);
  if (cut === undefined) return null;
  // a cut transition needs the two clips to touch; after a move pulls them apart it simply does nothing
  if (tr.from && tr.to) {
    const a = clips.get(tr.from);
    const b = clips.get(tr.to);
    if (!a || !b || a.trackId !== b.trackId || Math.abs(a.start + a.duration - b.start) > 0.05) return null;
  }
  const d = Math.max(0.01, tr.duration);
  if (tr.from && !tr.to) return [cut - d, cut]; // fade out at the end of a clip
  if (tr.to && !tr.from) return [cut, cut + d]; // fade in at the start of a clip
  if (tr.align === "start") return [cut, cut + d];
  if (tr.align === "end") return [cut - d, cut];
  return [cut - d / 2, cut + d / 2];
}

/** The transition running at t on a track, with eased progress, or null. */
export function transitionAt(tl: Timeline, trackId: string, t: number): { tr: ClipTransition; p: number; from?: Clip; to?: Clip } | null {
  const list = tl.cutTransitions?.filter((x) => x.trackId === trackId);
  if (!list?.length) return null;
  const clips = new Map(tl.clips.map((c) => [c.id, c]));
  for (const tr of list) {
    const w = transitionWindow(tr, clips);
    if (!w || t < w[0] || t >= w[1]) continue;
    const ease = EASINGS[tr.easing] ?? EASINGS.linear;
    return { tr, p: ease((t - w[0]) / (w[1] - w[0])), from: tr.from ? clips.get(tr.from) : undefined, to: tr.to ? clips.get(tr.to) : undefined };
  }
  return null;
}

/** A new transition between two clips (or at one clip's edge), with the transition's default params. */
export function newTransition(trackId: string, type: string, from: string | undefined, to: string | undefined, duration = 0.5, align: ClipTransition["align"] = "center"): ClipTransition {
  const def = getTransition(type);
  if (!def && type !== "crossfade") throw new Error(`no transition "${type}". Transitions: ${listTransitions().map((t) => t.id).join(", ")}`);
  return { id: newId("tr"), trackId, from, to, type, duration, align, easing: "ease-in-out", params: def ? defaultParams(def.params) : {} };
}
