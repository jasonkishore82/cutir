import { z } from "zod";
import { defineTool } from "./registry";
import { Animation, StylePatch, num } from "./schema";
import { ensureFont, titleCaseFont } from "../fonts";

const STYLE_KEYS = Object.keys(StylePatch.shape);

export const updateStyle = defineTool({
  name: "update_style",
  group: "style",
  description: "Change text style. Put the fields to change inside patch.",
  hint:
    "patch keys: fontFamily,fontSize,color(hex),uppercase,letterSpacing,lineHeight,maxCharsPerLine,shadow{blur,offsetX,offsetY,opacity},outline{width,color},position(top|center|bottom),animation,animationMs",
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
  description: "Set the line entry animation",
  hint: "animations: fade,pop,slide-up,typewriter,word-highlight",
  params: z.object({ name: Animation, durationMs: num(0, 3000).optional() }),
  apply: (p, a) => ({
    project: { ...p, style: { ...p.style, animation: a.name, animationMs: a.durationMs ?? p.style.animationMs } },
    summary: `animation ${a.name}${a.durationMs !== undefined ? ` ${a.durationMs}ms` : ""}`,
  }),
});

export const styleTools = [updateStyle, setFont, setAnimation];
