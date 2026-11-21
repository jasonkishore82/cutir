/**
 * Phase 27: pages and panel layouts. A page is a saved arrangement of the same editor over the same project, so
 * switching pages changes what is shown and how big it is, never the playhead, the selection or the undo history.
 * Pure data and functions; the store keeps the user's changes.
 */

export type PageId = "media" | "cut" | "edit" | "motion" | "color" | "audio" | "lyrics" | "deliver";
export type SectionName = "import" | "media" | "lyrics" | "style" | "motion" | "effects" | "titles" | "audio" | "captions";

export type Layout = {
  left: boolean;
  leftW: number;
  /** Width of the AI panel when it is open (whether it is open is the project's chat toggle, not a page setting). */
  chatW: number;
  timeline: boolean;
  timelineH: number;
};

export type Page = {
  id: PageId;
  label: string;
  title: string;
  /** The inspector section the page opens on. */
  section: SectionName;
  /** What fills the middle: the viewer, the media library or the deliver page. */
  main: "viewer" | "library" | "deliver";
  /** A strip of quick actions above the timeline (the Cut page). */
  quickBar?: boolean;
  layout: Layout;
};

export const LIMITS = { leftW: [240, 480], chatW: [280, 720], timelineH: [120, 700] } as const;

const L = (p: Partial<Layout> = {}): Layout => ({ left: true, leftW: 300, chatW: 360, timeline: true, timelineH: 240, ...p });

export const PAGES: Page[] = [
  { id: "media", label: "Media", title: "Media: import, organise and preview", section: "import", main: "library", layout: L({ timeline: false }) },
  { id: "cut", label: "Cut", title: "Cut: fast assembly with a source viewer and a short timeline", section: "media", main: "viewer", quickBar: true, layout: L({ left: false, timelineH: 190 }) },
  { id: "edit", label: "Edit", title: "Edit: the full timeline", section: "media", main: "viewer", layout: L({ timelineH: 300 }) },
  { id: "motion", label: "Motion", title: "Motion: titles, animation and keyframes", section: "motion", main: "viewer", layout: L({ leftW: 340 }) },
  { id: "color", label: "Color", title: "Color: grade, scopes and effects", section: "effects", main: "viewer", layout: L({ leftW: 380, timelineH: 170 }) },
  { id: "audio", label: "Audio", title: "Audio: mixer, loudness and voice-over", section: "audio", main: "viewer", layout: L({ leftW: 360 }) },
  { id: "lyrics", label: "Lyrics", title: "Lyrics: write, sync and style", section: "lyrics", main: "viewer", layout: L() },
  { id: "deliver", label: "Deliver", title: "Deliver: presets and the render queue", section: "media", main: "deliver", layout: L({ left: false, timeline: false }) },
];

export const DEFAULT_PAGE: PageId = "edit";
export const pageById = (id: string): Page => PAGES.find((p) => p.id === id) ?? PAGES.find((p) => p.id === DEFAULT_PAGE)!;
export const isPageId = (v: unknown): v is PageId => PAGES.some((p) => p.id === v);

const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Make any stored layout safe: right types, sizes inside the limits. Missing values come from `base`. */
export function sanitizeLayout(raw: unknown, base: Layout): Layout {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    left: bool(r.left, base.left),
    leftW: clamp(num(r.leftW, base.leftW), LIMITS.leftW),
    chatW: clamp(num(r.chatW, base.chatW), LIMITS.chatW),
    timeline: bool(r.timeline, base.timeline),
    timelineH: clamp(num(r.timelineH, base.timelineH), LIMITS.timelineH),
  };
}

/** The layout in force for a page: the user's saved one when there is one, else the page's own. */
export const layoutFor = (id: PageId, saved: Partial<Record<PageId, Layout>>): Layout => sanitizeLayout(saved[id], pageById(id).layout);

/** Named arrangements that can be applied to any page. */
export type LayoutPreset = { id: string; name: string; apply: (base: Layout) => Layout };

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: "default", name: "Page default", apply: (b) => b },
  { id: "wide-timeline", name: "Wide timeline", apply: (b) => ({ ...b, timeline: true, timelineH: 420 }) },
  { id: "focus-viewer", name: "Focus on the viewer", apply: (b) => ({ ...b, left: false, timeline: true, timelineH: 160 }) },
  { id: "inspector", name: "Large inspector", apply: (b) => ({ ...b, left: true, leftW: 480 }) },
  { id: "minimal", name: "Viewer only", apply: (b) => ({ ...b, left: false, timeline: false }) },
];

/** Where each page's layout is kept, and what a fresh start is. */
export type SavedLayouts = Partial<Record<PageId, Layout>>;

/** Layouts that differ from the page's own, so the saved file stays small and a changed default still reaches users. */
export function compactLayouts(saved: SavedLayouts): SavedLayouts {
  const out: SavedLayouts = {};
  for (const p of PAGES) {
    const s = saved[p.id];
    if (!s) continue;
    const clean = sanitizeLayout(s, p.layout);
    if (JSON.stringify(clean) !== JSON.stringify(p.layout)) out[p.id] = clean;
  }
  return out;
}

export const layoutsToJson = (saved: SavedLayouts) => JSON.stringify({ cutirLayouts: 1, layouts: compactLayouts(saved) }, null, 2);

export function layoutsFromJson(text: string): SavedLayouts | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const src = (j as { layouts?: unknown })?.layouts;
  if (!src || typeof src !== "object") return null;
  const out: SavedLayouts = {};
  for (const p of PAGES) if ((src as Record<string, unknown>)[p.id]) out[p.id] = sanitizeLayout((src as Record<string, unknown>)[p.id], p.layout);
  return out;
}

/** Page after or before this one, wrapping, for the keyboard. */
export const stepPage = (id: PageId, dir: 1 | -1): PageId => PAGES[(PAGES.findIndex((p) => p.id === id) + dir + PAGES.length) % PAGES.length].id;
