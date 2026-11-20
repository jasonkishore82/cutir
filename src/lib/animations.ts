import type { AnimationSpec, Beat, BeatName, BeatSlot, Easing, EffectName, EnergyCurve, LoopName, TransitionType } from "../store/project";

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

/**
 * What an effect does to the text. Offsets are fractions of the canvas height; blur is in 1080p pixels.
 * `flash` (0..1) brightens the text toward white with a halo; `swap` (0..1) mixes its fill toward the accent colour.
 */
export type Fx = { opacity: number; dx: number; dy: number; scale: number; rotation: number; blur: number; reveal: number; flash: number; swap: number };
export const IDENTITY: Fx = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0, reveal: 1, flash: 0, swap: 0 };
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
    flash: Math.max(a.flash, b.flash),
    swap: Math.max(a.swap, b.swap),
  };
}

/** Scale how far an effect moves the text from rest by `k` (opacity and reveal are left alone). */
export function scaleFx<T extends Partial<Fx>>(p: T, k: number): T {
  if (k === 1) return p;
  const o: Partial<Fx> = { ...p };
  if (p.dx !== undefined) o.dx = p.dx * k;
  if (p.dy !== undefined) o.dy = p.dy * k;
  if (p.rotation !== undefined) o.rotation = p.rotation * k;
  if (p.scale !== undefined) o.scale = 1 + (p.scale - 1) * k;
  if (p.blur !== undefined) o.blur = p.blur * k;
  if (p.flash !== undefined) o.flash = clamp01(p.flash * k);
  if (p.swap !== undefined) o.swap = clamp01(p.swap * k);
  return o as T;
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

/** A loop's look scaled by `k` (energy): motion and glow grow or shrink, k = 1 leaves it as is. */
export function scaleLoop(p: Partial<Fx> & { glow?: number }, k: number): Partial<Fx> & { glow?: number } {
  if (k === 1) return p;
  const o = scaleFx(p, k);
  if (p.glow !== undefined) o.glow = clamp01(p.glow * k);
  return o;
}

/* ---------- energy ---------- */

/** Loudness (0..1) of the song at `t` seconds, linearly interpolated. No curve = 0. */
export function energyAt(curve: EnergyCurve | undefined, t: number): number {
  const v = curve?.values;
  if (!v || !v.length || !(curve!.rate > 0)) return 0;
  const x = t * curve!.rate;
  if (x <= 0) return clamp01(v[0]);
  if (x >= v.length - 1) return clamp01(v[v.length - 1]);
  const i = Math.floor(x);
  return clamp01(v[i] + (v[i + 1] - v[i]) * (x - i));
}

/**
 * How much the song's loudness `level` boosts motion when the style's energy amount is `amount` (0..1):
 * amount 0 = always 1 (no change), amount 1 = 0.4 in silence up to 1.6 at full loudness.
 */
export const energyFactor = (amount: number, level: number): number => {
  const a = clamp01(amount || 0);
  return a === 0 ? 1 : 1 + a * (0.4 + 1.2 * clamp01(level) - 1);
};

/**
 * Loop clock under energy: seconds from `from` to `to` with each moment sped up by its energy factor, so loops run
 * faster in loud parts without jumping when the level changes. Amount 0 gives back `to - from` exactly.
 */
export function energyClock(curve: EnergyCurve | undefined, amount: number, from: number, to: number): number {
  const span = to - from;
  if (!(amount > 0) || !curve?.values?.length || span <= 0) return span;
  const step = 0.05;
  const n = Math.ceil(span / step);
  const dt = span / n;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += energyFactor(amount, energyAt(curve, from + (i + 0.5) * dt)) * dt;
  return sum;
}

/* ---------- beat reactions ---------- */

export type BeatDef = {
  label: string;
  /** The look `since` seconds after a beat of strength `hit` (0..1, more on boosted hits); `index` counts the beats. */
  fx: (since: number, hit: number, index: number) => Partial<Fx>;
};

/** 1 on the beat, easing out to 0 after `len` seconds. */
const decay = (since: number, len: number) => {
  if (since < 0 || since >= len) return 0;
  const k = 1 - since / len;
  return k * k;
};

/** Framings a jump cut steps through, one per beat: like cutting between camera set-ups. */
const CUTS: Partial<Fx>[] = [
  {},
  { scale: 1.14, dx: 0.035, dy: -0.01, rotation: -2.5 },
  { scale: 0.9, dx: -0.03, dy: 0.012, rotation: 2 },
  { scale: 1.06, dx: 0.01, dy: 0.02, rotation: 1 },
];

export const BEATS: Record<BeatName, BeatDef> = {
  none: { label: "none", fx: () => ({}) },
  pulse: { label: "pulse", fx: (s, k) => ({ scale: 1 + 0.12 * k * decay(s, 0.22) }) },
  flash: { label: "flash", fx: (s, k) => ({ flash: clamp01(k * decay(s, 0.25)) }) },
  shake: {
    label: "shake",
    fx: (s, k) => {
      const d = k * decay(s, 0.25);
      return { dx: Math.cos(TAU * 22 * s) * 0.012 * d, dy: Math.sin(TAU * 17 * s) * 0.006 * d, rotation: Math.sin(TAU * 19 * s) * 1.8 * d };
    },
  },
  nudge: {
    label: "nudge",
    fx: (s, k, i) => {
      const d = k * decay(s, 0.2);
      return { dx: (i % 2 ? -1 : 1) * 0.018 * d, rotation: (i % 2 ? 1 : -1) * 1.2 * d };
    },
  },
  "colour-swap": { label: "colour swap", fx: (s, k) => ({ swap: clamp01(Math.max(0.35, k) * decay(s, 0.3)) }) },
  "jump-cut": { label: "jump cut", fx: (_s, k, i) => scaleFx(CUTS[i % CUTS.length], Math.min(2, k)) },
  bounce: { label: "bounce", fx: (s, k) => ({ dy: -0.05 * k * Math.abs(Math.sin(Math.PI * Math.min(1, s / 0.3))) * decay(s, 0.3) * 1.6, scale: 1 + 0.04 * k * decay(s, 0.2) }) },
  punch: { label: "punch", fx: (s, k) => ({ scale: 1 + 0.3 * k * decay(s, 0.16) }) },
  heartbeat: { label: "heartbeat", fx: (s, k) => ({ scale: 1 + 0.1 * k * (decay(s, 0.16) + 0.7 * decay(s - 0.18, 0.2)) }) },
  drop: { label: "drop", fx: (s, k) => ({ dy: -0.07 * k * decay(s, 0.22), scale: 1 + 0.06 * k * decay(s, 0.22) }) },
  rise: { label: "rise", fx: (s, k) => ({ dy: 0.05 * k * decay(s, 0.28), scale: 1 - 0.05 * k * decay(s, 0.28) }) },
  swing: { label: "swing", fx: (s, k, i) => ({ rotation: (i % 2 ? -1 : 1) * 6 * k * Math.cos(TAU * 3 * s) * decay(s, 0.45) }) },
  spin: { label: "spin", fx: (s) => ({ rotation: s < 0.35 ? 360 * (1 - Math.pow(1 - s / 0.35, 3)) : 0 }) },
  wobble: { label: "wobble", fx: (s, k) => { const d = k * decay(s, 0.4); return { scale: 1 + 0.06 * Math.sin(TAU * 6 * s) * d, rotation: 2.5 * Math.sin(TAU * 5 * s) * d }; } },
  glitch: { label: "glitch", fx: (s, k, i) => { const d = k * decay(s, 0.18); const j = Math.floor(s * 60) + i * 7; return { dx: (Math.sin(j * 12.9898) > 0 ? 1 : -1) * 0.03 * d, dy: Math.sin(j * 78.233) * 0.01 * d, flash: clamp01(0.4 * d) }; } },
  "blur-hit": { label: "blur hit", fx: (s, k) => ({ blur: 14 * k * decay(s, 0.25), scale: 1 + 0.05 * k * decay(s, 0.25) }) },
  strobe: { label: "strobe", fx: (s, k) => ({ opacity: 1 - 0.85 * clamp01(k) * (s < 0.06 ? 1 : 0) }) },
};

export const BEAT_NAMES = Object.keys(BEATS) as BeatName[];

/**
 * The latest beat at or before `t` in `beats` (sorted by time), with its count among the beats considered (only
 * downbeats when `downbeatsOnly`). Null before the first beat.
 */
export function nearestBeatBefore(beats: Beat[] | undefined, t: number, downbeatsOnly = false): { beat: Beat; index: number } | null {
  if (!beats?.length) return null;
  let lo = 0;
  let hi = beats.length - 1;
  if (beats[0].time > t) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  if (!downbeatsOnly) return { beat: beats[lo], index: lo };
  let i = lo;
  while (i >= 0 && !beats[i].downbeat) i--;
  if (i < 0) return null;
  let index = 0;
  for (let j = 0; j < i; j++) if (beats[j].downbeat) index++;
  return { beat: beats[i], index };
}

/**
 * The beat reaction at time `t` for a slot: hit strength = beat strength x slot strength x energy factor at the
 * beat (energy `amount` 0 = no energy influence). No beats or no slot = no reaction.
 */
export function beatFxAt(beats: Beat[] | undefined, slot: BeatSlot | undefined, t: number, curve?: EnergyCurve, amount = 0): Partial<Fx> {
  if (!slot || slot.name === "none" || !beats?.length) return {};
  const def = BEATS[slot.name];
  if (!def) return {};
  const near = nearestBeatBefore(beats, t, slot.downbeatsOnly);
  if (!near) return {};
  const hit = (near.beat.strength ?? 1) * (slot.strength ?? 1) * energyFactor(amount, energyAt(curve, near.beat.time));
  if (hit <= 0) return {};
  return def.fx(t - near.beat.time, hit, near.index);
}
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
