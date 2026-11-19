import { z } from "zod";
import { defineTool } from "./registry";
import { Animation, EasingName, Loop, StylePatch, num } from "./schema";
import { ensureFont, titleCaseFont } from "../fonts";

const STYLE_KEYS = Object.keys(StylePatch.shape);

export const updateStyle = defineTool({
  name: "update_style",
  group: "style",
  description: "Change text style. Put the fields to change inside patch.",
  hint:
    "patch keys: fontFamily,fontSize,color(hex),uppercase,letterSpacing,lineHeight,maxCharsPerLine,shadow{blur,offsetX,offsetY,opacity},outline{width,color},position(top|center|bottom). Animation is set with set_animation",
  params: z.object({ patch: StylePatch.describe("style fields to change") }),
  // models often send the style fields flat instead of inside `patch`
  normalize: (args) => {
    if (args && typeof args === "object" && !("patch" in args)) {
      const keys = Object.keys(args as object);
      if (keys.length && keys.every((k) => STYLE_KEYS.includes(k))) return { patch: args };
    }
    return args;
  },
  // a new fontFamily is downloaded from Google Fonts first; unknown fonts are rejected
  prepare: async (a) => {
    if (a.patch.fontFamily) await ensureFont(a.patch.fontFamily);
  },
  apply: (p, a) => {
    const keys = Object.keys(a.patch);
    if (!keys.length) throw new Error("patch is empty");
    const { shadow, outline, ...rest } = a.patch;
    if (rest.fontFamily) rest.fontFamily = titleCaseFont(rest.fontFamily);
    const style = {
      ...p.style,
      ...rest,
      shadow: { ...p.style.shadow, ...shadow },
      outline: { ...p.style.outline, ...outline },
    };
    return { project: { ...p, style }, summary: `style: ${keys.join(", ")}` };
  },
});

export const setFont = defineTool({
  name: "set_font",
  group: "style",
  description: "Use a font by name. Any Google Fonts family works (e.g. Roboto, Lobster, Open Sans): it is downloaded automatically.",
  hint: "downloads any Google Font by name",
  params: z.object({ family: z.string().min(1).describe("font family name, e.g. Roboto") }),
  normalize: (args) => (args && typeof args === "object" && !("family" in args) && "name" in args ? { family: (args as { name: unknown }).name } : args),
  prepare: async (a) => {
    await ensureFont(a.family);
  },
  apply: (p, a) => ({ project: { ...p, style: { ...p.style, fontFamily: titleCaseFont(a.family) } }, summary: `font ${titleCaseFont(a.family)}` }),
});

export const setAnimation = defineTool({
  name: "set_animation",
  group: "style",
  description: "Set how lines appear (slot in), leave (slot out) or keep moving (slot loop)",
  hint:
    "slot in|out: name one of none,fade,pop,slide-up,slide-down,slide-left,slide-right,zoom,blur,rotate,typewriter,word-by-word,letter-by-letter (in also word-highlight), durationMs, easing linear|ease-in|ease-out|ease-in-out|back|elastic. slot loop: name float|pulse|shake|glow|wave|none, speed 0.25-4",
  params: z.object({
    slot: z.enum(["in", "out", "loop"]).default("in"),
    name: z.string().optional().describe("effect name"),
    durationMs: num(0, 3000).optional(),
    easing: EasingName.optional(),
    speed: num(0.25, 4).optional(),
  }),
  // older prompts sent only { name, durationMs } for the entrance
  normalize: (args) => (args && typeof args === "object" && !("slot" in args) ? { slot: "in", ...(args as object) } : args),
  apply: (p, a) => {
    const cur = p.style.animation;
    if (a.slot === "loop") {
      const name = a.name ? Loop.parse(a.name) : cur.loop.name;
      const speed = a.speed ?? cur.loop.speed;
      return { project: { ...p, style: { ...p.style, animation: { ...cur, loop: { name, speed } } } }, summary: `loop ${name}${a.speed !== undefined ? ` x${speed}` : ""}` };
    }
    const name = a.name ? Animation.parse(a.name) : cur[a.slot].name;
    if (a.slot === "out" && name === "word-highlight") throw new Error("word-highlight is only available as an entrance");
    const slot = { name, ms: a.durationMs ?? cur[a.slot].ms, easing: a.easing ?? cur[a.slot].easing };
    return {
      project: { ...p, style: { ...p.style, animation: { ...cur, [a.slot]: slot } } },
      summary: `${a.slot} ${name}${a.durationMs !== undefined ? ` ${a.durationMs}ms` : ""}${a.easing ? ` ${a.easing}` : ""}`,
    };
  },
});

export const styleTools = [updateStyle, setFont, setAnimation];
