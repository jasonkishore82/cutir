import { create } from "zustand";
import { deleteFile, loadFile, saveFile } from "./assetdb";
import { editProjectStyle, editStyle, type Target } from "./styleEdit";
import { resolveStyle, uid, type Project, type StyleOverride } from "../store/project";

/**
 * Style templates: a named bundle of font, colours, outline, shadow, animation slots, karaoke highlight and
 * placement. Applying one writes its fields at the chosen level (project, layer or selected lines) as one undo step.
 * Built-ins live here; the user's own are kept in IndexedDB on this device.
 */

export type Template = { id: string; name: string; description: string; style: StyleOverride; builtIn?: boolean };

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: "karaoke",
    name: "Karaoke",
    description: "Words light up gold as they are sung, the current word grows",
    builtIn: true,
    style: {
      fontFamily: "Montserrat",
      fontSize: 84,
      color: "#ffffff",
      uppercase: false,
      letterSpacing: 0,
      outline: { width: 3, color: "#000000" },
      shadow: { blur: 10, offsetX: 0, offsetY: 4, opacity: 0.5 },
      position: "bottom",
      animation: { in: { name: "word-highlight", ms: 0, easing: "linear" }, out: { name: "fade", ms: 200, easing: "linear" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: true, color: "#ffd84a", activeScale: 1.15 },
    },
  },
  {
    id: "bold-caption",
    name: "Bold Caption",
    description: "Heavy uppercase captions that pop in, word by word",
    builtIn: true,
    style: {
      fontFamily: "Anton",
      fontSize: 110,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 1,
      outline: { width: 6, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 6, opacity: 0.6 },
      position: "center",
      animation: { in: { name: "word-by-word", ms: 400, easing: "back" }, out: { name: "pop", ms: 150, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Small, light, lower third, gentle fades",
    builtIn: true,
    style: {
      fontFamily: "Inter",
      fontSize: 56,
      color: "#f5f5f5",
      uppercase: false,
      letterSpacing: 0.5,
      outline: { width: 0 },
      shadow: { blur: 8, offsetX: 0, offsetY: 2, opacity: 0.35 },
      position: "bottom",
      animation: { in: { name: "fade", ms: 350, easing: "ease-out" }, out: { name: "fade", ms: 300, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "neon",
    name: "Neon",
    description: "Glowing pink tubes that flicker gently",
    builtIn: true,
    style: {
      fontFamily: "Monoton",
      fontSize: 96,
      color: "#ff4fd8",
      uppercase: true,
      letterSpacing: 4,
      outline: { width: 0 },
      shadow: { blur: 24, offsetX: 0, offsetY: 0, opacity: 0.9 },
      position: "center",
      animation: { in: { name: "blur", ms: 500, easing: "ease-out" }, out: { name: "fade", ms: 300, easing: "linear" }, loop: { name: "glow", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "cinematic",
    name: "Cinematic",
    description: "Wide-spaced serif, slow letter reveal",
    builtIn: true,
    style: {
      fontFamily: "Cinzel",
      fontSize: 72,
      color: "#fff7e6",
      uppercase: true,
      letterSpacing: 10,
      outline: { width: 0 },
      shadow: { blur: 16, offsetX: 0, offsetY: 3, opacity: 0.5 },
      position: "center",
      animation: { in: { name: "letter-by-letter", ms: 900, easing: "ease-out" }, out: { name: "fade", ms: 500, easing: "ease-in-out" }, loop: { name: "float", speed: 0.5 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "poster-stack",
    name: "Poster Stack",
    description: "Tall condensed caps, tightly stacked, one big block that pops in",
    builtIn: true,
    style: {
      fontFamily: "League Gothic",
      fontSize: 170,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 2,
      lineHeight: 0.88,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 },
      ghosts: 2,
      ghostOpacity: 0.3,
      ghostSpacing: 0.85,
      position: "center",
      animation: { in: { name: "word-by-word", ms: 350, easing: "back" }, out: { name: "fade", ms: 200, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "impact-punch",
    name: "Impact Punch",
    description: "Huge Anton caps that slam in and zoom out, built for a beat reaction",
    builtIn: true,
    style: {
      fontFamily: "Anton",
      fontSize: 190,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 0,
      lineHeight: 0.9,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 },
      ghosts: 2,
      ghostOpacity: 0.3,
      ghostSpacing: 0.85,
      position: "center",
      animation: { in: { name: "zoom", ms: 220, easing: "back" }, out: { name: "zoom", ms: 160, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "bebas-slide",
    name: "Bebas Slide",
    description: "Clean Bebas Neue caps sliding up line by line",
    builtIn: true,
    style: {
      fontFamily: "Bebas Neue",
      fontSize: 150,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 3,
      lineHeight: 0.95,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 8, offsetX: 0, offsetY: 4, opacity: 0.35 },
      position: "center",
      animation: { in: { name: "slide-up", ms: 300, easing: "ease-out" }, out: { name: "slide-up", ms: 220, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "gold-marquee",
    name: "Gold Marquee",
    description: "Condensed gold caps with a hard shadow, like a movie title",
    builtIn: true,
    style: {
      fontFamily: "Oswald",
      fontSize: 140,
      color: "#ffd84a",
      uppercase: true,
      letterSpacing: 4,
      lineHeight: 1,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 8, opacity: 0.7 },
      position: "center",
      animation: { in: { name: "pop", ms: 260, easing: "back" }, out: { name: "fade", ms: 250, easing: "linear" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "street-type",
    name: "Street Type",
    description: "Bold condensed caps with a thick black outline that pop in",
    builtIn: true,
    style: {
      fontFamily: "Big Shoulders Display",
      fontSize: 150,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 1,
      lineHeight: 0.92,
      outline: { width: 8, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 6, opacity: 0.5 },
      position: "center",
      animation: { in: { name: "pop", ms: 240, easing: "back" }, out: { name: "pop", ms: 140, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "highlight-stack",
    name: "Highlight Stack",
    description: "Poster caps where the word being sung turns yellow and grows",
    builtIn: true,
    style: {
      fontFamily: "Bebas Neue",
      fontSize: 140,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 2,
      lineHeight: 0.92,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 },
      position: "center",
      animation: { in: { name: "word-highlight", ms: 0, easing: "linear" }, out: { name: "fade", ms: 200, easing: "linear" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: true, color: "#ffe14a", activeScale: 1.12 },
    },
  },
  {
    id: "whisper-caps",
    name: "Whisper Caps",
    description: "Thin tall caps that fade in letter by letter, calm and airy",
    builtIn: true,
    style: {
      fontFamily: "Big Shoulders Display",
      fontSize: 130,
      color: "#e8f4f8",
      uppercase: true,
      letterSpacing: 8,
      lineHeight: 1,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 14, offsetX: 0, offsetY: 0, opacity: 0.4 },
      position: "center",
      animation: { in: { name: "letter-by-letter", ms: 700, easing: "ease-out" }, out: { name: "fade", ms: 400, easing: "ease-in-out" }, loop: { name: "float", speed: 0.4 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "paper-collage",
    name: "Paper Collage",
    description: "Black heavy caps with a white cut-out edge, collage style",
    builtIn: true,
    style: {
      fontFamily: "Anton",
      fontSize: 200,
      color: "#0d0d0d",
      uppercase: true,
      letterSpacing: 0,
      lineHeight: 0.9,
      outline: { width: 10, color: "#fbf6e6" },
      shadow: { blur: 0, offsetX: 0, offsetY: 10, opacity: 1 },
      transform: { scale: 1, rotation: 0 },
      position: "center",
      animation: { in: { name: "pop", ms: 240, easing: "back" }, out: { name: "pop", ms: 140, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "cream-sticker",
    name: "Cream Sticker",
    description: "Black caps on a cream paper card, tilted",
    builtIn: true,
    style: {
      fontFamily: "Oswald",
      fontSize: 120,
      color: "#111111",
      uppercase: true,
      letterSpacing: 2,
      lineHeight: 1,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 1 },
      transform: { scale: 1, rotation: -6 },
      labelColor: "#fbf6e6",
      labelPad: 26,
      position: "center",
      animation: { in: { name: "pop", ms: 220, easing: "back" }, out: { name: "pop", ms: 140, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "green-tag",
    name: "Green Tag",
    description: "Black caps on a green paper tag, tilted the other way",
    builtIn: true,
    style: {
      fontFamily: "Oswald",
      fontSize: 110,
      color: "#111111",
      uppercase: true,
      letterSpacing: 2,
      lineHeight: 1,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 1 },
      transform: { scale: 1, rotation: 5 },
      labelColor: "#1f8f3e",
      labelPad: 26,
      position: "center",
      animation: { in: { name: "slide-up", ms: 240, easing: "back" }, out: { name: "fade", ms: 160, easing: "linear" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "pink-tape",
    name: "Pink Tape",
    description: "White caps on a hot-pink strip",
    builtIn: true,
    style: {
      fontFamily: "Anton",
      fontSize: 120,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 2,
      lineHeight: 1,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 1 },
      transform: { scale: 1, rotation: -3 },
      labelColor: "#e0309a",
      labelPad: 26,
      position: "center",
      animation: { in: { name: "zoom", ms: 200, easing: "back" }, out: { name: "zoom", ms: 140, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "rainbow-arch",
    name: "Rainbow Arch",
    description: "Heavy caps bent into a rainbow arch that fills the frame",
    builtIn: true,
    style: {
      fontFamily: "Anton",
      fontSize: 150,
      color: "#fbe6c8",
      uppercase: true,
      letterSpacing: 2,
      lineHeight: 1,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 },
      fitWidth: 0.8,
      arch: 100,
      position: "center",
      animation: { in: { name: "letter-by-letter", ms: 600, easing: "back" }, out: { name: "fade", ms: 200, easing: "linear" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "paint-fill",
    name: "Paint Fill",
    description: "Chunky hand-cut caps that fill up with yellow as the line is sung",
    builtIn: true,
    style: {
      fontFamily: "Londrina Solid",
      fontSize: 190,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 1,
      lineHeight: 0.95,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 },
      fitWidth: 0.85,
      fillColor: "#f9e060",
      position: "center",
      animation: { in: { name: "pop", ms: 220, easing: "back" }, out: { name: "fade", ms: 200, easing: "linear" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "echo-stack",
    name: "Echo Stack",
    description: "Wide bold caps with a trail of outlined echoes above and below",
    builtIn: true,
    style: {
      fontFamily: "Archivo Black",
      fontSize: 150,
      color: "#ffffff",
      uppercase: true,
      letterSpacing: 0,
      lineHeight: 1,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 },
      ghosts: 3,
      ghostOpacity: 0.9,
      ghostSpacing: 0.55,
      ghostEcho: true,
      position: "center",
      animation: { in: { name: "zoom", ms: 200, easing: "ease-out" }, out: { name: "fade", ms: 160, easing: "linear" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "brush-poster",
    name: "Brush Poster",
    description: "Huge hand-cut caps that fill the frame, in one flat colour",
    builtIn: true,
    style: {
      fontFamily: "Londrina Solid",
      fontSize: 200,
      color: "#ffa94a",
      uppercase: true,
      letterSpacing: 0,
      lineHeight: 0.9,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 },
      fitWidth: 0.95,
      position: "center",
      animation: { in: { name: "slide-up", ms: 260, easing: "back" }, out: { name: "slide-up", ms: 180, easing: "ease-in" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
  {
    id: "left-stack",
    name: "Left Stack",
    description: "Big bold caps lined up on the left edge, like a poster headline",
    builtIn: true,
    style: {
      fontFamily: "Archivo Black",
      fontSize: 150,
      color: "#111111",
      uppercase: true,
      letterSpacing: 0,
      lineHeight: 0.95,
      outline: { width: 0, color: "#000000" },
      shadow: { blur: 0, offsetX: 0, offsetY: 0, opacity: 0 },
      align: "left",
      position: "center",
      animation: { in: { name: "slide-right", ms: 280, easing: "ease-out" }, out: { name: "fade", ms: 160, easing: "linear" }, loop: { name: "none", speed: 1 } },
      highlight: { tint: false, activeScale: 1 },
    },
  },
];

/** Style fields a template carries (where a line sits on screen is included only as the position preset). */
export const TEMPLATE_PATHS = [
  "fontFamily", "fontSize", "color", "uppercase", "letterSpacing", "lineHeight",
  "shadow.blur", "shadow.offsetX", "shadow.offsetY", "shadow.opacity", "outline.width", "outline.color",
  "position", "transform.scale", "transform.rotation",
  "animation.in.name", "animation.in.ms", "animation.in.easing", "animation.out.name", "animation.out.ms", "animation.out.easing",
  "animation.loop.name", "animation.loop.speed",
  "highlight.tint", "highlight.color", "highlight.activeScale",
  "ghosts", "ghostOpacity", "ghostSpacing", "labelColor", "labelPad", "fitWidth", "arch", "fillColor", "ghostEcho", "align",
];

const getIn = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]), o);

/**
 * What applying a template clears: free placement (so its position preset shows) and every template field the template
 * does not set, so nothing is left over from the look applied before (an arch, a label card, echo lines...).
 */
export const templateUnsets = (t: Template): string[] => [
  ...(t.style.position ? ["transform.x", "transform.y"] : []),
  ...TEMPLATE_PATHS.filter((p) => getIn(t.style, p) === undefined),
];

/** Flatten a template's style into dot-path writes. */
export const templateWrites = (t: Template): [string, unknown][] =>
  TEMPLATE_PATHS.map((p) => [p, getIn(t.style, p)] as [string, unknown]).filter(([, v]) => v !== undefined);

/**
 * Apply a template at a level. Free placement (transform x / y) is cleared so the template's position preset shows.
 * Fonts are downloaded by the caller first (see `ensureFont`), so the first frame already uses them.
 */
export function applyTemplate(target: Target, t: Template) {
  editStyle(target, { set: templateWrites(t), unset: templateUnsets(t) });
}

/** Same as applyTemplate, as a pure function on a project (for chat tools). */
export const applyTemplateTo = (p: Project, target: Target, t: Template): Project =>
  editProjectStyle(p, target, { set: templateWrites(t), unset: templateUnsets(t) });

/** A template made from a line's current look. */
export function templateFromLine(p: Project, lineId: string, name: string): Template | null {
  const line = p.lines.find((l) => l.id === lineId);
  if (!line) return null;
  const s = resolveStyle(p, line);
  let style: StyleOverride = {};
  for (const path of TEMPLATE_PATHS) {
    const v = getIn(s, path);
    if (v === undefined) continue;
    const keys = path.split(".");
    let o = style as Record<string, unknown>;
    keys.slice(0, -1).forEach((k) => (o = (o[k] ??= {}) as Record<string, unknown>));
    o[keys[keys.length - 1]] = v;
  }
  return { id: uid(), name: name.trim() || "My template", description: "Saved from a line", style };
}

/* ---------- the user's own templates (IndexedDB, one record) ---------- */

const KEY = "templates/user";

type TemplateState = { user: Template[]; loaded: boolean };
export const useTemplates = create<TemplateState>(() => ({ user: [], loaded: false }));

export async function loadUserTemplates() {
  if (useTemplates.getState().loaded) return;
  try {
    const f = await loadFile(KEY);
    const list = f ? (JSON.parse(await f.blob.text()) as Template[]) : [];
    useTemplates.setState({ user: Array.isArray(list) ? list : [], loaded: true });
  } catch {
    useTemplates.setState({ loaded: true });
  }
}

async function persist(list: Template[]) {
  useTemplates.setState({ user: list });
  if (list.length) await saveFile(KEY, new Blob([JSON.stringify(list)], { type: "application/json" }), "templates.json");
  else await deleteFile(KEY);
}

export const saveUserTemplate = (t: Template) => persist([...useTemplates.getState().user.filter((x) => x.name !== t.name), t]);
export const deleteUserTemplate = (id: string) => persist(useTemplates.getState().user.filter((x) => x.id !== id));

/** Built-ins and the user's templates, matched by name or id (case and spaces ignored). */
export function findTemplate(name: string): Template | undefined {
  const k = name.toLowerCase().replace(/[\s_-]+/g, "");
  return [...BUILTIN_TEMPLATES, ...useTemplates.getState().user].find((t) => t.id.replace(/-/g, "") === k || t.name.toLowerCase().replace(/[\s_-]+/g, "") === k);
}
