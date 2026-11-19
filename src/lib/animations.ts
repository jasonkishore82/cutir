import type { AnimationSpec, Easing, EffectName, LoopName, TransitionType } from "../store/project";

/**
 * Text animation: easing curves, the in/out effects and the loop effects.
 * Every effect is a pure function; the renderer only composes what they return, so adding one is one entry here.
 *
 * In and out share the same definitions. An effect describes how the text looks at a given "presence":
 * 0 = hidden, 1 = fully shown. An in slot runs presence 0 -> 1, an out slot runs 1 -> 0.
 */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  "ease-in": (t) => t * t * t,
  "ease-out": easeOutCubic,
  "ease-in-out": (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: easeOutBack,
  elastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1),
};

/** What an effect does to the text. Offsets are fractions of the canvas height; blur is in 1080p pixels. */
export type Fx = { opacity: number; dx: number; dy: number; scale: number; rotation: number; blur: number; reveal: number };
export const IDENTITY: Fx = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0, reveal: 1 };
export const toFx = (p: Partial<Fx>): Fx => ({ ...IDENTITY, ...p });

export function combineFx(a: Fx, b: Fx): Fx {
  return {
    opacity: a.opacity * b.opacity,
    dx: a.dx + b.dx,
    dy: a.dy + b.dy,
    scale: a.scale * b.scale,
    rotation: a.rotation + b.rotation,
    blur: Math.max(a.blur, b.blur),
    reveal: Math.min(a.reveal, b.reveal),
  };
}

export type Phase = "in" | "out";
export type Info = { chars: number; words: number; dur: number };

export type EffectDef = {
  label: string;
  /** Can be used as an exit. */
  out: boolean;
  /**
   * block: acts on the whole text. reveal: shows a growing part of it. highlight: lights words in time with the song.
   * word and letter: acts on each word or letter in turn, with `spread` of the duration used for the stagger.
   */
  mode: "block" | "reveal" | "highlight" | "word" | "letter";
  spread?: number;
  /** Seconds to use when the slot's duration is 0. */
  auto?: (info: Info) => number;
  fx: (presence: number, phase: Phase) => Partial<Fx>;
};

const SLIDE = 0.06;
const SLIDE_X = 0.1;
const sign = (p: Phase) => (p === "in" ? 1 : -1);

export const EFFECTS: Record<EffectName, EffectDef> = {
  none: { label: "none", out: true, mode: "block", fx: () => ({}) },
  fade: {
    label: "fade",
    out: true,
    mode: "block",
    fx: (p, ph) => ({ opacity: p, scale: ph === "in" ? 0.96 + 0.04 * easeOutCubic(p) : 1 }),
  },
  pop: { label: "pop", out: true, mode: "block", fx: (p) => ({ opacity: clamp01(p * 2), scale: 0.6 + 0.4 * easeOutBack(p) }) },
  "slide-up": { label: "slide up", out: true, mode: "block", fx: (p, ph) => ({ opacity: p, dy: sign(ph) * (1 - easeOutCubic(p)) * SLIDE }) },
  "slide-down": { label: "slide down", out: true, mode: "block", fx: (p, ph) => ({ opacity: p, dy: -sign(ph) * (1 - easeOutCubic(p)) * SLIDE }) },
  "slide-left": { label: "slide left", out: true, mode: "block", fx: (p, ph) => ({ opacity: p, dx: sign(ph) * (1 - easeOutCubic(p)) * SLIDE_X }) },
  "slide-right": { label: "slide right", out: true, mode: "block", fx: (p, ph) => ({ opacity: p, dx: -sign(ph) * (1 - easeOutCubic(p)) * SLIDE_X }) },
  zoom: { label: "zoom", out: true, mode: "block", fx: (p) => ({ opacity: p, scale: 1 + 0.5 * (1 - easeOutCubic(p)) }) },
  blur: { label: "blur", out: true, mode: "block", fx: (p) => ({ opacity: p, blur: (1 - clamp01(p)) * 14 }) },
  rotate: {
    label: "rotate",
    out: true,
    mode: "block",
    fx: (p, ph) => ({ opacity: p, rotation: -sign(ph) * (1 - easeOutCubic(p)) * 25, scale: 0.9 + 0.1 * easeOutCubic(p) }),
  },
  typewriter: {
    label: "typewriter",
    out: true,
    mode: "reveal",
    auto: (i) => Math.min(i.dur * 0.7, Math.max(0.3, i.chars * 0.05)),
    fx: (p) => ({ reveal: clamp01(p) }),
  },
  "word-highlight": { label: "word highlight", out: false, mode: "highlight", fx: (p) => ({ opacity: p }) },
  "word-by-word": {
    label: "word by word",
    out: true,
    mode: "word",
    spread: 0.7,
    fx: (p) => ({ opacity: clamp01(p * 2), scale: 0.6 + 0.4 * easeOutBack(clamp01(p)) }),
  },
  "letter-by-letter": {
    label: "letter by letter",
    out: true,
    mode: "letter",
    spread: 0.85,
    fx: (p, ph) => ({ opacity: clamp01(p * 1.5), dy: sign(ph) * (1 - easeOutCubic(clamp01(p))) * 0.03 }),
  },
};

export const IN_EFFECTS = Object.keys(EFFECTS) as EffectName[];
export const OUT_EFFECTS = IN_EFFECTS.filter((n) => EFFECTS[n].out);

/** Presence of one unit (word or letter) when the whole text is at `presence`, staggered across `n` units. */
export function unitPresence(presence: number, i: number, n: number, spread: number): number {
  const start = spread * (n > 1 ? i / (n - 1) : 0);
  return clamp01((presence - start) / (1 - spread));
}

/** Seconds a slot takes. A slot never takes more than half the line, so in + out always fit. */
export function slotSeconds(slot: { name: EffectName; ms: number }, info: Info): number {
  if (slot.name === "none") return 0;
  if (slot.ms > 0) return Math.min(slot.ms / 1000, info.dur / 2);
  const auto = EFFECTS[slot.name].auto;
  return auto ? Math.min(auto(info), info.dur * 0.7) : 0;
}

/** In presence at `since` seconds after the line starts. */
export function presenceIn(slot: AnimationSpec["in"], since: number, info: Info): number {
  const d = slotSeconds(slot, info);
  return d > 0 ? EASINGS[slot.easing](clamp01(since / d)) : 1;
}

/** Out presence with `left` seconds until the line ends. */
export function presenceOut(slot: AnimationSpec["out"], left: number, info: Info): number {
  const d = slotSeconds(slot, info);
  if (d <= 0) return 1;
  if (slot.easing === "linear") return clamp01(left / d);
  return 1 - EASINGS[slot.easing](1 - clamp01(left / d));
}

/* ---------- loops ---------- */

export type LoopDef = {
  label: string;
  /** Whole-block motion at `t` seconds into the line. `glow` is 0..1. */
  fx: (t: number, speed: number) => Partial<Fx> & { glow?: number };
  /** Per-letter vertical offset (fraction of height). Present for letter-wise loops. */
  letterDy?: (t: number, speed: number, i: number) => number;
};

const TAU = Math.PI * 2;

export const LOOPS: Record<LoopName, LoopDef> = {
  none: { label: "none", fx: () => ({}) },
  float: { label: "float", fx: (t, s) => ({ dy: Math.sin(TAU * 0.5 * s * t) * 0.012 }) },
  pulse: { label: "pulse", fx: (t, s) => ({ scale: 1 + 0.04 * Math.sin(TAU * s * t) }) },
  shake: { label: "shake", fx: (t, s) => ({ dx: Math.sin(TAU * 9 * s * t) * 0.004, rotation: Math.sin(TAU * 7 * s * t) * 0.6 }) },
  glow: { label: "glow", fx: (t, s) => ({ glow: 0.5 + 0.5 * Math.sin(TAU * s * t) }) },
  wave: { label: "wave", fx: () => ({}), letterDy: (t, s, i) => Math.sin(TAU * (0.8 * s * t - i * 0.09)) * 0.022 },
};

export const LOOP_NAMES = Object.keys(LOOPS) as LoopName[];
export const EASING_NAMES = Object.keys(EASINGS) as Easing[];

/* ---------- transitions between consecutive lines ---------- */

export type TransitionDef = {
  label: string;
  /** The outgoing line at progress p (0 = transition starts, 1 = done). */
  out: (p: number) => Partial<Fx>;
  /** The incoming line at progress p. */
  in: (p: number) => Partial<Fx>;
};

const smooth = EASINGS["ease-in-out"];

export const TRANSITIONS: Record<TransitionType, TransitionDef> = {
  none: { label: "none (cut)", out: () => ({}), in: () => ({}) },
  crossfade: { label: "crossfade", out: (p) => ({ opacity: 1 - p }), in: (p) => ({ opacity: p }) },
  "slide-push": {
    label: "slide push",
    out: (p) => ({ opacity: 1 - p, dy: -0.08 * smooth(p) }),
    in: (p) => ({ opacity: p, dy: 0.08 * (1 - smooth(p)) }),
  },
  "zoom-through": {
    label: "zoom through",
    out: (p) => ({ opacity: 1 - p, scale: 1 + 0.6 * smooth(p), blur: 6 * p }),
    in: (p) => ({ opacity: p, scale: 0.7 + 0.3 * smooth(p) }),
  },
};

export const TRANSITION_NAMES = Object.keys(TRANSITIONS) as TransitionType[];
