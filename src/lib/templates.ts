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
];

/** Style fields a template carries (where a line sits on screen is included only as the position preset). */
export const TEMPLATE_PATHS = [
  "fontFamily", "fontSize", "color", "uppercase", "letterSpacing", "lineHeight",
  "shadow.blur", "shadow.offsetX", "shadow.offsetY", "shadow.opacity", "outline.width", "outline.color",
  "position", "transform.scale", "transform.rotation",
  "animation.in.name", "animation.in.ms", "animation.in.easing", "animation.out.name", "animation.out.ms", "animation.out.easing",
  "animation.loop.name", "animation.loop.speed",
  "highlight.tint", "highlight.color", "highlight.activeScale",
];

const getIn = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]), o);

/** Flatten a template's style into dot-path writes. */
export const templateWrites = (t: Template): [string, unknown][] =>
  TEMPLATE_PATHS.map((p) => [p, getIn(t.style, p)] as [string, unknown]).filter(([, v]) => v !== undefined);

/**
 * Apply a template at a level. Free placement (transform x / y) is cleared so the template's position preset shows.
 * Fonts are downloaded by the caller first (see `ensureFont`), so the first frame already uses them.
 */
export function applyTemplate(target: Target, t: Template) {
  editStyle(target, { set: templateWrites(t), unset: t.style.position ? ["transform.x", "transform.y"] : [] });
}

/** Same as applyTemplate, as a pure function on a project (for chat tools). */
export const applyTemplateTo = (p: Project, target: Target, t: Template): Project =>
  editProjectStyle(p, target, { set: templateWrites(t), unset: t.style.position ? ["transform.x", "transform.y"] : [] });

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
