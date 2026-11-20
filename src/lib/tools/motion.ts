import { z } from "zod";
import { defineTool } from "./registry";
import { EasingName, Loop, idx, num } from "./schema";
import { lineAt } from "./helpers";
import { editProjectStyle, type Target } from "../styleEdit";
import { keyLineAt } from "../keyframes";
import { BUILTIN_TEMPLATES, applyTemplateTo, findTemplate } from "../templates";
import { ensureFont } from "../fonts";
import { EFFECTS } from "../animations";
import type { EffectName, Project, TransitionType } from "../../store/project";

/**
 * Tools for placement, animation slots, keyframes, transitions and templates.
 * Every tool takes an optional 1-based `index`: with it the change goes on that line only, without it on every line.
 */

const target = (p: Project, index?: number): Target => (index ? { scope: "line", ids: [lineAt(p, index).id] } : { scope: "project" });
const who = (index?: number) => (index ? `line ${index}` : "all lines");
const optIndex = idx.optional().describe("1-based line number; leave out for all lines");

/** Lenient object args: lower-case keys and turn "line" / "line_index" into index. */
function tidy(args: unknown, renames: Record<string, string> = {}): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const key = k.toLowerCase();
    const to = renames[key] ?? (["line", "line_index", "lineindex", "line_number", "n"].includes(key) ? "index" : key);
    if (v !== null && v !== "") out[to] = v;
  }
  if (typeof out.index === "string" && /^(all|every|\*)/i.test(out.index)) delete out.index;
  return out;
}

/* ---------- placement (group: transform) ---------- */

const PLACES = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const;
const PLACE_XY: Record<(typeof PLACES)[number], [number, number]> = {
  "top-left": [0.25, 0.15], top: [0.5, 0.15], "top-right": [0.75, 0.15],
  left: [0.25, 0.5], center: [0.5, 0.5], right: [0.75, 0.5],
  "bottom-left": [0.25, 0.85], bottom: [0.5, 0.85], "bottom-right": [0.75, 0.85],
};

/** "top left", "upper-left", "top_left corner", "middle" -> a PLACES value. */
function toPlace(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.toLowerCase().replace(/corner|of the (screen|video|frame)|side/g, "").replace(/upper/g, "top").replace(/lower/g, "bottom").replace(/middle|centre/g, "center");
  const v1 = /top/.test(s) ? "top" : /bottom/.test(s) ? "bottom" : "";
  const h1 = /left/.test(s) ? "left" : /right/.test(s) ? "right" : "";
  return v1 && h1 ? `${v1}-${h1}` : v1 || h1 || (/center/.test(s) ? "center" : v);
}

export const moveText = defineTool({
  name: "move_text",
  group: "transform",
  description: "Move text on the screen. Use place for a spot like top-left, or x / y in percent of the width / height.",
  hint: "place one of top-left,top,top-right,left,center,right,bottom-left,bottom,bottom-right; or x,y 0-100 (50,50 = centre)",
  params: z.object({
    index: optIndex,
    place: z.enum(PLACES).optional(),
    x: num(0, 100).optional().describe("percent from the left"),
    y: num(0, 100).optional().describe("percent from the top"),
  }),
  normalize: (a) => {
    const o = tidy(a, { position: "place", location: "place", where: "place", to: "place", anchor: "place" }) as Record<string, unknown>;
    if (o && typeof o === "object" && "place" in o) o.place = toPlace(o.place);
    return o;
  },
  apply: (p, a) => {
    let x = a.x !== undefined ? a.x / 100 : undefined;
    let y = a.y !== undefined ? a.y / 100 : undefined;
    if (a.place) [x, y] = [x ?? PLACE_XY[a.place][0], y ?? PLACE_XY[a.place][1]];
    if (x === undefined && y === undefined) throw new Error("give place, or x and/or y");
    const set: [string, unknown][] = [];
    if (x !== undefined) set.push(["transform.x", x]);
    if (y !== undefined) set.push(["transform.y", y]);
    return { project: editProjectStyle(p, target(p, a.index), { set }), summary: `${who(a.index)} moved to ${a.place ?? `${Math.round((x ?? 0.5) * 100)}%, ${Math.round((y ?? 0.5) * 100)}%`}` };
  },
});

export const scaleText = defineTool({
  name: "scale_text",
  group: "transform",
  description: "Make text bigger or smaller as a whole. scale 1 = normal, 2 = double, 0.5 = half.",
  params: z.object({ index: optIndex, scale: num(0.1, 8) }),
  // "150" or "150%" means 1.5
  normalize: (a) => {
    const o = tidy(a, { size: "scale", factor: "scale", percent: "scale" }) as Record<string, unknown>;
    if (o && typeof o === "object") {
      const n = typeof o.scale === "string" ? parseFloat(o.scale) : o.scale;
      if (typeof n === "number" && n > 8) o.scale = n / 100;
    }
    return o;
  },
  apply: (p, a) => ({ project: editProjectStyle(p, target(p, a.index), { set: [["transform.scale", a.scale]] }), summary: `${who(a.index)} scaled to ${Math.round(a.scale * 100)}%` }),
});

export const rotateText = defineTool({
  name: "rotate_text",
  group: "transform",
  description: "Tilt text by an angle in degrees (positive = clockwise, 0 = straight).",
  params: z.object({ index: optIndex, degrees: num(-360, 360) }),
  normalize: (a) => tidy(a, { angle: "degrees", deg: "degrees", rotation: "degrees" }),
  apply: (p, a) => ({ project: editProjectStyle(p, target(p, a.index), { set: [["transform.rotation", a.degrees]] }), summary: `${who(a.index)} rotated ${a.degrees} deg` }),
});

/* ---------- animation slots (group: style, always offered) ---------- */

/** Everyday words for effects. */
const EFFECT_WORDS: Record<string, EffectName> = {
  spin: "rotate", spinning: "rotate", twist: "rotate", rotating: "rotate",
  bounce: "pop", popup: "pop", "pop-in": "pop", grow: "zoom", "zoom-in": "zoom",
  slide: "slide-up", "slide-in": "slide-up", rise: "slide-up", up: "slide-up", down: "slide-down", drop: "slide-down",
  left: "slide-left", right: "slide-right", fadein: "fade", "fade-in": "fade", fadeout: "fade", "fade-out": "fade", appear: "fade",
  typing: "typewriter", type: "typewriter", karaoke: "word-highlight", highlight: "word-highlight",
  words: "word-by-word", "word": "word-by-word", letters: "letter-by-letter", letter: "letter-by-letter",
  off: "none", nothing: "none", cut: "none",
};
const EFFECT_NAMES = Object.keys(EFFECTS) as EffectName[];

function toEffect(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if ((EFFECT_NAMES as string[]).includes(k)) return k;
  return EFFECT_WORDS[k] ?? EFFECT_WORDS[k.replace(/-/g, "")] ?? k;
}

const slotTool = (slot: "in" | "out") =>
  defineTool({
    name: `set_animation_${slot}`,
    group: "style",
    description:
      slot === "in"
        ? "How text appears (its entrance). spin = rotate, typing = typewriter, karaoke = word-highlight."
        : "How text leaves (its exit).",
    hint: `effect one of ${EFFECT_NAMES.filter((n) => slot === "in" || EFFECTS[n].out).join(",")}; durationMs; easing linear|ease-in|ease-out|ease-in-out|back|elastic`,
    params: z.object({
      index: optIndex,
      effect: z.enum(EFFECT_NAMES as [EffectName, ...EffectName[]]),
      durationMs: num(0, 3000).optional(),
      easing: EasingName.optional(),
    }),
    normalize: (a) => {
      const o = tidy(a, { name: "effect", animation: "effect", type: "effect", ms: "durationMs", duration: "durationMs", durationms: "durationMs" }) as Record<string, unknown>;
      if (o && typeof o === "object") o.effect = toEffect(o.effect);
      return o;
    },
    apply: (p, a) => {
      if (slot === "out" && !EFFECTS[a.effect].out) throw new Error(`${a.effect} can only be an entrance`);
      const set: [string, unknown][] = [[`animation.${slot}.name`, a.effect]];
      if (a.durationMs !== undefined) set.push([`animation.${slot}.ms`, a.durationMs]);
      if (a.easing) set.push([`animation.${slot}.easing`, a.easing]);
      return { project: editProjectStyle(p, target(p, a.index), { set }), summary: `${who(a.index)}: ${slot} ${a.effect}${a.durationMs !== undefined ? ` ${a.durationMs}ms` : ""}` };
    },
  });

export const setAnimationIn = slotTool("in");
export const setAnimationOut = slotTool("out");

export const setAnimationLoop = defineTool({
  name: "set_animation_loop",
  group: "style",
  description: "Keep text moving while it is on screen (float, pulse, shake, glow, wave, or none).",
  params: z.object({ index: optIndex, effect: Loop, speed: num(0.25, 4).optional() }),
  normalize: (a) => {
    const o = tidy(a, { name: "effect", animation: "effect", loop: "effect" }) as Record<string, unknown>;
    if (o && typeof o.effect === "string") o.effect = o.effect.toLowerCase().replace(/^(off|stop|nothing)$/, "none").replace(/^(bob|hover)$/, "float").replace(/^(beat|throb)$/, "pulse");
    return o;
  },
  apply: (p, a) => {
    const set: [string, unknown][] = [["animation.loop.name", a.effect]];
    if (a.speed !== undefined) set.push(["animation.loop.speed", a.speed]);
    return { project: editProjectStyle(p, target(p, a.index), { set }), summary: `${who(a.index)}: loop ${a.effect}` };
  },
});

/* ---------- keyframes, transitions, templates (group: motion) ---------- */

const KeyProps = z
  .object({
    x: num(-100, 100).describe("move across, percent of width (+ = right)"),
    y: num(-100, 100).describe("move down, percent of height (+ = down)"),
    scale: num(0.05, 8),
    rotation: num(-720, 720).describe("degrees"),
    opacity: num(0, 1),
  })
  .partial();

export const addKeyframe = defineTool({
  name: "add_keyframe",
  group: "motion",
  description: "Pin a line's motion at a moment. time = seconds from the line's start. Values are offsets from its normal place.",
  hint: "props {x,y (percent offsets), scale (1 = normal), rotation (deg), opacity (0-1)}; two keyframes make the text move between them",
  params: z.object({ index: idx, time: num(0, 600), props: KeyProps, easing: EasingName.optional() }),
  // models often send the props flat
  normalize: (a) => {
    const o = tidy(a, { at: "time", t: "time", seconds: "time", values: "props" }) as Record<string, unknown>;
    if (o && typeof o === "object" && !("props" in o)) {
      const props: Record<string, unknown> = {};
      for (const k of ["x", "y", "scale", "rotation", "opacity"]) if (k in o) (props[k] = o[k]), delete o[k];
      o.props = props;
    }
    return o;
  },
  apply: (p, a) => {
    const line = lineAt(p, a.index);
    const props = { ...a.props, ...(a.props.x !== undefined ? { x: a.props.x / 100 } : {}), ...(a.props.y !== undefined ? { y: a.props.y / 100 } : {}) };
    if (!Object.keys(props).length) throw new Error("props is empty: give at least one of x, y, scale, rotation, opacity");
    const { line: next, id } = keyLineAt(line, a.time, props, a.easing);
    const kf = next.keyframes!.find((k) => k.id === id)!;
    return { project: { ...p, lines: p.lines.map((l) => (l.id === line.id ? next : l)) }, summary: `line ${a.index}: keyframe at ${kf.time}s (${Object.keys(props).join(", ")})` };
  },
});

export const clearKeyframes = defineTool({
  name: "clear_keyframes",
  group: "motion",
  description: "Remove all keyframes from a line (or from every line).",
  params: z.object({ index: optIndex }),
  normalize: (a) => tidy(a),
  apply: (p, a) => {
    const id = a.index ? lineAt(p, a.index).id : null;
    const lines = p.lines.map((l) => {
      if ((id && l.id !== id) || !l.keyframes) return l;
      const { keyframes: _k, ...rest } = l;
      void _k;
      return rest;
    });
    return { project: { ...p, lines }, summary: `keyframes cleared on ${who(a.index)}` };
  },
});

const TRANSITION_TYPES = ["none", "crossfade", "slide-push", "zoom-through"] as const;

export const setTransition = defineTool({
  name: "set_transition",
  group: "motion",
  description: "How one line hands over to the next. gap_index N = between line N and N+1; leave it out for every gap.",
  hint: "type none|crossfade|slide-push|zoom-through, ms 100-2000",
  params: z.object({ gap_index: optIndex, type: z.enum(TRANSITION_TYPES), ms: num(50, 3000).optional() }),
  normalize: (a) => {
    const o = tidy(a, { gap: "gap_index", gapindex: "gap_index", transition: "type", name: "type", duration: "ms", durationms: "ms", index: "gap_index", line: "gap_index" }) as Record<string, unknown>;
    if (o && typeof o.type === "string") {
      const k = o.type.toLowerCase().replace(/[\s_]+/g, "-");
      o.type = /cross|dissolve|fade/.test(k) ? "crossfade" : /push|slide/.test(k) ? "slide-push" : /zoom/.test(k) ? "zoom-through" : /none|cut|off/.test(k) ? "none" : k;
    }
    if (o && typeof o.gap_index === "string" && /^(all|every)/i.test(o.gap_index)) delete o.gap_index;
    return o;
  },
  apply: (p, a) => {
    if (a.gap_index) {
      const from = lineAt(p, a.gap_index);
      lineAt(p, a.gap_index + 1); // the gap must exist
      const ms = a.ms ?? from.transition?.ms ?? p.transition.ms;
      const lines = p.lines.map((l) => (l.id === from.id ? { ...l, transition: { type: a.type as TransitionType, ms } } : l));
      return { project: { ...p, lines }, summary: `${a.type} between lines ${a.gap_index} and ${a.gap_index + 1}` };
    }
    // every gap: set the default and drop per-gap choices so it really applies everywhere
    const lines = p.lines.map((l) => {
      if (!l.transition) return l;
      const { transition: _t, ...rest } = l;
      void _t;
      return rest;
    });
    return { project: { ...p, lines, transition: { type: a.type, ms: a.ms ?? p.transition.ms } }, summary: `${a.type} between all lines` };
  },
});

export const applyTemplateTool = defineTool({
  name: "apply_template",
  group: "motion",
  description: "Apply a ready-made look (font, colours, outline, animation).",
  hint: `name one of ${BUILTIN_TEMPLATES.map((t) => t.name).join(", ")} (or a saved template)`,
  params: z.object({ name: z.string().min(1), index: optIndex }),
  normalize: (a) => tidy(a, { template: "name", preset: "name", style: "name", target: "index" }),
  prepare: async (a) => {
    const t = findTemplate(a.name);
    if (!t) throw new Error(`no template "${a.name}". Templates: ${BUILTIN_TEMPLATES.map((x) => x.name).join(", ")}`);
    if (t.style.fontFamily) await ensureFont(t.style.fontFamily);
  },
  apply: (p, a) => {
    const t = findTemplate(a.name)!;
    return { project: applyTemplateTo(p, target(p, a.index), t), summary: `template ${t.name} on ${who(a.index)}` };
  },
});

export const transformTools = [moveText, scaleText, rotateText];
export const animationTools = [setAnimationIn, setAnimationOut, setAnimationLoop];
export const motionTools = [addKeyframe, clearKeyframes, setTransition, applyTemplateTool];
