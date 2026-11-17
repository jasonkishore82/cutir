import { z } from "zod";

/**
 * Shared zod building blocks. Small models are sloppy ("120" instead of 120, "pink" instead of a hex),
 * so these are lenient on input but strict about what actually gets applied.
 */

const COLOR_NAMES: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#e53935", pink: "#ff5fa2", hotpink: "#ff69b4", orange: "#ff8a1f",
  yellow: "#ffd84a", gold: "#ffc933", green: "#34c759", lime: "#a3e635", teal: "#14b8a6", cyan: "#22d3ee",
  blue: "#3b82f6", navy: "#1e2a6b", indigo: "#4f46e5", purple: "#8b5cf6", violet: "#7c3aed", magenta: "#e11d8f",
  gray: "#9ca3af", grey: "#9ca3af", brown: "#8b5a2b", peach: "#ffb38a", coral: "#ff7f6e",
};

export const color = z
  .string()
  .transform((s) => {
    const k = s.trim().toLowerCase().replace(/\s+/g, "");
    return COLOR_NAMES[k] ?? k;
  })
  .pipe(z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, "must be a hex color like #ff8800 or a basic color name"));

export const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
export const bool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
/** 1-based line number */
export const idx = z.coerce.number().int().min(1);
export const seconds = num(0, 36000);

export const Position = z.enum(["top", "center", "bottom"]);
export const Animation = z.enum(["fade", "pop", "slide-up", "typewriter", "word-highlight"]);
export const Aspect = z.enum(["16:9", "9:16", "1:1"]);

export const StylePatch = z
  .object({
    fontFamily: z.string().min(1),
    fontSize: num(8, 400),
    color,
    uppercase: bool,
    letterSpacing: num(-20, 100),
    lineHeight: num(0.5, 4),
    maxCharsPerLine: z.coerce.number().int().min(4).max(120),
    shadow: z.object({ blur: num(0, 100), offsetX: num(-100, 100), offsetY: num(-100, 100), opacity: num(0, 1) }).partial().strict(),
    outline: z.object({ width: num(0, 40), color }).partial().strict(),
    position: Position,
    animation: Animation,
    animationMs: num(0, 3000),
  })
  .partial()
  .strict();
