/**
 * Caption looks (phase 25): style presets for a subtitle track, and the size that keeps a full line inside the safe area.
 * Google Fonts load by name on demand, so every family here works without being installed.
 */
import type { StyleOverride } from "../../store/project";
import type { CaptionRules } from "./checks";

export type SafeArea = "action" | "title" | "wide";
/** Share of the frame width a line may use. The bottom of captions sits on the 90% line, which is the title-safe edge. */
export const SAFE_WIDTH: Record<SafeArea, number> = { action: 0.93, title: 0.9, wide: 0.8 };
export const SAFE_LABEL: Record<SafeArea, string> = { action: "Action safe (93%)", title: "Title safe (90%)", wide: "Wide margin (80%)" };

export type CaptionPreset = { id: string; name: string; hint: string; style: StyleOverride };

const still = { in: { name: "none", ms: 0, easing: "linear" }, out: { name: "none", ms: 0, easing: "linear" } } as const;
const quick = { in: { name: "fade", ms: 100, easing: "linear" }, out: { name: "fade", ms: 100, easing: "linear" } } as const;

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "classic", name: "Classic", hint: "White on a dark box, the broadcast look",
    style: { fontFamily: "Inter", fontSize: 52, color: "#ffffff", uppercase: false, letterSpacing: 0, lineHeight: 1.25, position: "bottom", labelColor: "#000000b3", labelPad: 14, outline: { width: 0, color: "#000000" }, shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 }, animation: { ...quick, loop: { name: "none", speed: 1 } } },
  },
  {
    id: "outline", name: "Outlined", hint: "White with a black outline, no box",
    style: { fontFamily: "Roboto", fontSize: 54, color: "#ffffff", uppercase: false, letterSpacing: 0, lineHeight: 1.2, position: "bottom", labelColor: undefined, outline: { width: 6, color: "#000000" }, shadow: { blur: 4, offsetX: 0, offsetY: 2, opacity: 0.5 }, animation: { ...still, loop: { name: "none", speed: 1 } } },
  },
  {
    id: "yellow", name: "Yellow", hint: "Yellow text with an outline, easy to read on busy pictures",
    style: { fontFamily: "Roboto", fontSize: 54, color: "#ffe14a", uppercase: false, letterSpacing: 0, lineHeight: 1.2, position: "bottom", labelColor: undefined, outline: { width: 6, color: "#000000" }, shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 }, animation: { ...still, loop: { name: "none", speed: 1 } } },
  },
  {
    id: "social", name: "Social bold", hint: "Big bold capitals, word by word, for vertical video",
    style: { fontFamily: "Montserrat", fontSize: 76, color: "#ffffff", uppercase: true, letterSpacing: 1, lineHeight: 1.1, position: "center", labelColor: undefined, outline: { width: 9, color: "#000000" }, shadow: { blur: 10, offsetX: 0, offsetY: 4, opacity: 0.5 }, highlight: { tint: true, color: "#ffd84a", activeScale: 1.08 }, animation: { in: { name: "word-highlight", ms: 160, easing: "ease-out" }, out: { name: "none", ms: 0, easing: "linear" }, loop: { name: "none", speed: 1 } } },
  },
  {
    id: "minimal", name: "Minimal", hint: "Small light text with a soft shadow",
    style: { fontFamily: "Inter", fontSize: 44, color: "#f4f4f4", uppercase: false, letterSpacing: 0.5, lineHeight: 1.3, position: "bottom", labelColor: undefined, outline: { width: 0, color: "#000000" }, shadow: { blur: 14, offsetX: 0, offsetY: 3, opacity: 0.75 }, animation: { in: { name: "fade", ms: 160, easing: "linear" }, out: { name: "fade", ms: 160, easing: "linear" }, loop: { name: "none", speed: 1 } } },
  },
];

export const presetById = (id: string) => CAPTION_PRESETS.find((p) => p.id === id);

/** Average width of a character as a share of the font size (a typical sans-serif; bold capitals are wider). */
const CHAR_WIDTH = 0.56;

/**
 * The largest size at or below `wanted` (px at 1080 tall) that keeps `rules.maxChars` characters inside the safe width.
 * `aspectRatio` is width over height of the frame (16/9, 9/16...).
 */
export function fitFontSize(wanted: number, rules: Pick<CaptionRules, "maxChars">, aspectRatio: number, safe: SafeArea = "title", uppercase = false): number {
  const frameW = 1080 * aspectRatio;
  const avail = frameW * SAFE_WIDTH[safe];
  const per = CHAR_WIDTH * (uppercase ? 1.12 : 1);
  return Math.max(16, Math.min(wanted, Math.floor(avail / (rules.maxChars * per))));
}

/** The preset's style with the size fitted to the rules and the safe area, and the wrap width set to the rule. */
export function styleFor(preset: CaptionPreset, rules: Pick<CaptionRules, "maxChars">, aspectRatio: number, safe: SafeArea = "title"): StyleOverride {
  const s = preset.style;
  return { ...s, fontSize: fitFontSize(s.fontSize ?? 52, rules, aspectRatio, safe, !!s.uppercase), maxCharsPerLine: rules.maxChars };
}
