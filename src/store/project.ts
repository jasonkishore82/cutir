import { create } from "zustand";
import { activeTimeline, docToView, viewToDoc } from "../model/convert";
import { applyOperation, applyPatches, makeOperation, revertOperation, type Operation } from "../model/ops";
import { serializeDoc } from "../model/migrate";
import type { ProjectDoc } from "../model/types";

/* ---------- Types ---------- */

export type Aspect = "16:9" | "9:16" | "1:1";
export type EffectName =
  | "none" | "fade" | "pop" | "slide-up" | "slide-down" | "slide-left" | "slide-right" | "zoom" | "blur" | "rotate"
  | "typewriter" | "word-highlight" | "word-by-word" | "letter-by-letter";
export type LoopName = "none" | "float" | "pulse" | "shake" | "glow" | "wave";
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "back" | "elastic";

/** How a line appears, stays and leaves. `ms` of 0 means the effect's own automatic duration (typewriter) or none. */
export type AnimationSpec = {
  in: { name: EffectName; ms: number; easing: Easing };
  out: { name: EffectName; ms: number; easing: Easing };
  loop: { name: LoopName; speed: number };
};
export type Position = "top" | "center" | "bottom";

/** How one line hands over to the next line on its layer. "none" is a hard cut. */
export type TransitionType = "none" | "crossfade" | "slide-push" | "zoom-through";
export type Transition = { type: TransitionType; ms: number };

/** Karaoke look for the word-highlight entrance: sung words take `color` when `tint` is on; the word being sung grows to `activeScale`. */
export type Highlight = { tint: boolean; color: string; activeScale: number };

export type AssetRef = {
  name: string;
  kind: "audio" | "image" | "video";
  /** Object URL, valid for this session only; stripped when saving to JSON. */
  url?: string;
  /** The media pool item this came from, so the pool can show what is in use. */
  mediaId?: string;
};

export type Background =
  | { type: "gradient"; colors: string[]; angle: number; noise: boolean }
  | { type: "asset"; asset?: AssetRef };

/**
 * Free placement of a line. `x` and `y` are the centre of the text block as fractions of the canvas (0..1), so the
 * placement survives any aspect ratio. While they are missing, the `position` preset places the line.
 */
export type Transform = { x?: number; y?: number; scale: number; rotation: number };

export type TextStyle = {
  fontFamily: string;
  fontSize: number; // px at 1080p reference height
  color: string;
  uppercase: boolean;
  letterSpacing: number;
  lineHeight: number;
  maxCharsPerLine: number;
  shadow: { blur: number; offsetX: number; offsetY: number; opacity: number };
  outline: { width: number; color: string };
  position: Position;
  transform: Transform;
  animation: AnimationSpec;
  highlight: Highlight;
};

/** Overrides for a layer or a line: any subset of the style, including single fields inside shadow, outline and transform. */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type StyleOverride = DeepPartial<TextStyle>;

export type LyricLine = {
  id: string;
  text: string;
  start: number;
  end: number;
  words?: { text: string; start: number; end: number }[];
  styleOverride?: StyleOverride;
  /** Which layer this line lives on. Missing = the first layer. */
  layerId?: string;
  /** Custom motion over the line's life. Times are relative to `start`, so moving the line moves its keyframes. */
  keyframes?: Keyframe[];
  /** Transition into the next line on the same layer. Missing = the project's default transition. */
  transition?: Transition;
};

/** Properties a keyframe can animate. All are offsets on top of the resolved style and the in/out/loop animation. */
export type KeyProp = "x" | "y" | "scale" | "rotation" | "opacity";

/**
 * One keyframe. `x` and `y` are offsets as fractions of the canvas width and height, `scale` and `opacity` multiply,
 * `rotation` adds degrees. Only the properties present are keyed here; the rest interpolate past this keyframe.
 * `easing` shapes the move from this keyframe to the next one that keys the same property.
 */
export type Keyframe = { id: string; time: number; props: Partial<Record<KeyProp, number>>; easing: Easing };

/** A timeline layer (lane). Today every layer holds text; the style here overrides the project style for its lines. */
export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  style?: StyleOverride;
};

export type Project = {
  audio?: AssetRef;
  background: Background;
  layers: Layer[]; // drawn bottom to top, in array order; never empty
  lines: LyricLine[];
  style: TextStyle;
  aspect: Aspect;
  fps: 30 | 60;
  /** Default transition between consecutive lines; a line's own `transition` overrides it. */
  transition: Transition;
};

/* ---------- Defaults ---------- */

export const DEFAULT_GRADIENT: Background = {
  type: "gradient",
  colors: ["#1e2a6b", "#5b3a8c", "#d4687a", "#f0a070"],
  angle: 135,
  noise: true,
};

export const DEFAULT_STYLE: TextStyle = {
  fontFamily: "Permanent Marker",
  fontSize: 96,
  color: "#ffffff",
  uppercase: true,
  letterSpacing: 2,
  lineHeight: 1.2,
  maxCharsPerLine: 24,
  shadow: { blur: 12, offsetX: 0, offsetY: 4, opacity: 0.45 },
  outline: { width: 0, color: "#000000" },
  position: "center",
  transform: { scale: 1, rotation: 0 },
  animation: {
    in: { name: "fade", ms: 200, easing: "linear" },
    out: { name: "fade", ms: 200, easing: "linear" },
    loop: { name: "none", speed: 1 },
  },
  highlight: { tint: false, color: "#ffd84a", activeScale: 1 },
};

export const mainLayer = (): Layer => ({ id: "main", name: "Lyrics", visible: true, locked: false });

export const defaultProject = (): Project => ({
  background: DEFAULT_GRADIENT,
  layers: [mainLayer()],
  lines: [],
  style: DEFAULT_STYLE,
  aspect: "16:9",
  fps: 30,
  transition: { type: "none", ms: 400 },
});

/* ---------- Helpers ---------- */

export const uid = () => Math.random().toString(36).slice(2, 10);

/** The layer a line belongs to (lines without a valid layerId belong to the first layer). */
export const layerIdOf = (p: Pick<Project, "layers">, l: LyricLine): string =>
  l.layerId && p.layers.some((x) => x.id === l.layerId) ? l.layerId : p.layers[0].id;

export const linesOfLayer = (p: Project, layerId: string) => p.lines.filter((l) => layerIdOf(p, l) === layerId);

/**
 * Keep `lines` grouped by layer (in layer order). Line numbers used by the AI and the lyrics box follow this order.
 * Also gives every line an explicit layerId, so reordering layers never moves lines to another layer.
 */
export function orderByLayers(p: Project): Project {
  const rank = new Map(p.layers.map((l, i) => [l.id, i]));
  const lines = p.lines
    .map((l, i) => {
      const id = layerIdOf(p, l);
      return { l: l.layerId === id ? l : { ...l, layerId: id }, i, r: rank.get(id) ?? 0 };
    })
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.l);
  return { ...p, lines };
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Merge `over` into `base`: plain objects merge field by field, everything else is replaced. Undefined is skipped. */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/** Lay overrides over a base style. Groups (shadow, outline, transform, animation) merge field by field. */
function mergeStyle(base: TextStyle, ...layers: (StyleOverride | undefined)[]): TextStyle {
  let out = base as unknown as Record<string, unknown>;
  for (const o of layers) if (o) out = deepMerge(out, o as Record<string, unknown>);
  return out as unknown as TextStyle;
}

/** The style a layer gives its lines: project style with the layer's overrides. */
export const resolveLayerStyle = (p: Project, layer?: Layer): TextStyle => mergeStyle(p.style, layer?.style);

/**
 * The one place the cascade lives: project style, then the layer's style, then the line's own override.
 * The renderer, the preview overlay, the exporters and the properties panel all read through this.
 */
export function resolveStyle(p: Project, line: LyricLine): TextStyle {
  const layer = p.layers.find((x) => x.id === layerIdOf(p, line));
  return mergeStyle(p.style, layer?.style, line.styleOverride);
}

/** Older name for `resolveStyle`. */
export const effectiveStyle = resolveStyle;

const DEFAULT_LEN = 3;
const DEFAULT_GAP = 0.2;

/** Rebuild lines from textarea text, keeping existing ids/timings by index. */
export function linesFromText(text: string, prev: LyricLine[]): LyricLine[] {
  const rows = text.split("\n").map((r) => r.trim()).filter(Boolean);
  const out: LyricLine[] = [];
  rows.forEach((row, i) => {
    const old = prev[i];
    if (old) {
      out.push(old.text === row ? old : { ...old, text: row, words: undefined });
      return;
    }
    // New line: place after the previous line with a default length.
    const start = out.length ? out[out.length - 1].end + DEFAULT_GAP : 0;
    out.push({ id: uid(), text: row, start, end: start + DEFAULT_LEN });
  });
  return out;
}

export const linesToText = (lines: LyricLine[]) => lines.map((l) => l.text).join("\n");

/** A lyric project saved in the current file format (v2 document), without session-only blob URLs. */
export const serializeProject = (p: Project): string => serializeDoc(viewToDoc(p));

/* ---------- Store ---------- */

const HISTORY_LIMIT = 200;
const COALESCE_MS = 600;

/**
 * The store keeps two things in step:
 *   doc      the project document (model v2: settings, media, timelines, tracks, clips). This is what is saved.
 *   project  the active timeline seen as a lyric project, which the editor, renderer and chat tools work on.
 * Every edit goes through `update`: the new lyric view is folded into the document, the difference becomes an
 * Operation (patches + inverse patches), and undo / redo replay those operations instead of storing copies.
 */
type State = {
  doc: ProjectDoc;
  project: Project;
  past: Operation[];
  future: Operation[];

  // non-undoable UI state
  /** The line the handles are on: the last one selected. */
  selectedLineId: string | null;
  /** Every selected line, the primary one included. */
  selectedIds: string[];
  /** The layer the lyrics box, tap-sync and "add" act on. */
  activeLayerId: string;
  chatOpen: boolean;
  syncMode: boolean;
  syncIndex: number;

  /** History-tracked mutation. Same `coalesceKey` within 600ms merges into one undo step. */
  update: (fn: (p: Project) => Project, coalesceKey?: string) => void;
  /** Run several updates as a single undo step (e.g. one AI reply). */
  batch: (fn: () => void) => void;
  /** Start/finish a continuous gesture (drag, tap-sync). Everything in between is one undo step. */
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  /**
   * Edit the document directly (tracks, clips, markers: anything beyond the lyric view). Recorded as one operation;
   * the same `coalesceKey` within 600ms merges into one undo step. The lyric view is refreshed from the result.
   */
  editDoc: (fn: (doc: ProjectDoc) => ProjectDoc, coalesceKey?: string) => void;
  /** Apply a recorded operation to the document (undoable). */
  applyOperation: (op: Operation) => void;

  setStyle: (patch: Partial<TextStyle>, coalesceKey?: string) => void;
  setAspect: (a: Aspect) => void;
  setBackground: (b: Background) => void;
  setAudio: (a?: AssetRef) => void;
  setLinesFromText: (text: string) => void;
  updateLine: (id: string, patch: Partial<LyricLine>, coalesceKey?: string) => void;
  loadProject: (p: Project) => void;
  /** Open a whole document (keeps tracks, clips and timelines the lyric view does not show). */
  loadDoc: (doc: ProjectDoc) => void;
  /** Select a line; with `add`, toggle it in the selection instead. */
  select: (id: string | null, add?: boolean) => void;
  selectMany: (ids: string[]) => void;
  setActiveLayer: (id: string) => void;
  toggleChat: () => void;
  setSync: (on: boolean, index?: number) => void;
  setSyncIndex: (i: number) => void;
};

let batchDepth = 0;
let batchBase: ProjectDoc | null = null;
let lastKey: string | undefined;
let lastTime = 0;

const firstDoc = viewToDoc(defaultProject());

/** Fold a new lyric view into the document, sharing every unchanged part with the old document. */
function fold(doc: ProjectDoc, view: Project): { doc: ProjectDoc; op: Operation | null } {
  const op = makeOperation(doc, viewToDoc(view, doc));
  return { doc: op ? applyPatches(doc, op.patches) : doc, op };
}

const pushOp = (past: Operation[], op: Operation | null) => (op ? [...past, op].slice(-HISTORY_LIMIT) : past);

/** Record a change: inside a batch just apply it; otherwise push (or merge, for the same key) one operation. */
function commit(view: Project, nextDoc: ProjectDoc, op: Operation | null, coalesceKey?: string) {
  const { doc, past } = useProject.getState();
  if (batchDepth > 0) {
    useProject.setState({ project: view, doc: nextDoc });
    return;
  }
  const now = Date.now();
  const coalesce = !!coalesceKey && coalesceKey === lastKey && now - lastTime < COALESCE_MS && past.length > 0;
  lastKey = coalesceKey;
  lastTime = now;
  if (coalesce) {
    // merge into the previous step: one operation from before that step to now
    const prev = past[past.length - 1];
    const merged = makeOperation(revertOperation(doc, prev), nextDoc, prev.label);
    useProject.setState({ project: view, doc: nextDoc, past: merged ? [...past.slice(0, -1), merged] : past.slice(0, -1), future: [] });
    return;
  }
  useProject.setState({ project: view, doc: nextDoc, past: pushOp(past, op), future: op ? [] : useProject.getState().future });
}

export const useProject = create<State>((set, get) => ({
  doc: firstDoc,
  project: docToView(firstDoc),
  past: [],
  future: [],
  selectedLineId: null,
  selectedIds: [],
  activeLayerId: "main",
  chatOpen: false,
  syncMode: false,
  syncIndex: 0,

  update: (fn, coalesceKey) => {
    const { project, doc } = get();
    const next = fn(project);
    if (next === project) return;
    const { doc: nextDoc, op } = fold(doc, next);
    commit(next, nextDoc, op, coalesceKey);
  },

  editDoc: (fn, coalesceKey) => {
    const { doc } = get();
    const changed = fn(doc);
    if (changed === doc) return;
    const op = makeOperation(doc, changed);
    if (!op) return;
    const nextDoc = applyPatches(doc, op.patches); // share everything that did not change
    commit(docToView(nextDoc), nextDoc, op, coalesceKey);
  },

  batch: (fn) => {
    get().beginGesture();
    try {
      fn();
    } finally {
      get().endGesture();
    }
  },

  beginGesture: () => {
    if (batchDepth === 0) batchBase = get().doc;
    batchDepth++;
  },

  endGesture: () => {
    if (batchDepth === 0) return;
    batchDepth--;
    if (batchDepth === 0 && batchBase) {
      const { doc, past } = get();
      const op = makeOperation(batchBase, doc);
      if (op) set({ past: pushOp(past, op), future: [] });
      batchBase = null;
      lastKey = undefined;
    }
  },

  undo: () => {
    const { past, future, doc } = get();
    if (!past.length) return;
    lastKey = undefined;
    const op = past[past.length - 1];
    const prev = revertOperation(doc, op);
    set({ doc: prev, project: docToView(prev), past: past.slice(0, -1), future: [op, ...future] });
  },

  redo: () => {
    const { past, future, doc } = get();
    if (!future.length) return;
    lastKey = undefined;
    const op = future[0];
    const next = applyOperation(doc, op);
    set({ doc: next, project: docToView(next), past: pushOp(past, op), future: future.slice(1) });
  },

  applyOperation: (op) => {
    const { doc, past } = get();
    const next = applyOperation(doc, op);
    lastKey = undefined;
    set({ doc: next, project: docToView(next), past: pushOp(past, op), future: [] });
  },

  setStyle: (patch, key) =>
    get().update((p) => ({ ...p, style: { ...p.style, ...patch } }), key ?? `style:${Object.keys(patch).join(",")}`),
  setAspect: (aspect) => get().update((p) => ({ ...p, aspect })),
  setBackground: (background) => get().update((p) => ({ ...p, background })),
  setAudio: (audio) => get().update((p) => ({ ...p, audio })),
  // the lyrics box edits only the ACTIVE layer's lines; other layers are untouched
  setLinesFromText: (text) =>
    get().update((p) => {
      const lid = p.layers.some((l) => l.id === get().activeLayerId) ? get().activeLayerId : p.layers[0].id;
      const mine = linesFromText(text, linesOfLayer(p, lid)).map((l) => ({ ...l, layerId: lid }));
      const others = p.lines.filter((l) => layerIdOf(p, l) !== lid);
      return orderByLayers({ ...p, lines: [...others, ...mine] });
    }, "lyrics-text"),
  updateLine: (id, patch, key) =>
    get().update((p) => ({ ...p, lines: p.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) }), key),
  loadProject: (project) => get().loadDoc(viewToDoc(project)),
  loadDoc: (doc) => {
    const project = docToView(doc);
    lastKey = undefined;
    set({ doc, project, past: [], future: [], selectedLineId: null, selectedIds: [], activeLayerId: project.layers[0].id });
  },
  select: (id, add) =>
    set((s) => {
      if (id === null) return { selectedLineId: null, selectedIds: [] };
      if (!add) return { selectedLineId: id, selectedIds: [id] };
      if (s.selectedIds.includes(id)) {
        const rest = s.selectedIds.filter((x) => x !== id);
        return { selectedIds: rest, selectedLineId: s.selectedLineId === id ? rest[rest.length - 1] ?? null : s.selectedLineId };
      }
      return { selectedIds: [...s.selectedIds, id], selectedLineId: id };
    }),
  selectMany: (ids) => set({ selectedIds: ids, selectedLineId: ids[ids.length - 1] ?? null }),
  setActiveLayer: (activeLayerId) => set({ activeLayerId }),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  setSync: (syncMode, index) => set((s) => ({ syncMode, syncIndex: index ?? (syncMode ? 0 : s.syncIndex) })),
  setSyncIndex: (syncIndex) => set({ syncIndex }),
}));

/* ---------- Persistence ---------- */

/**
 * Projects saved before animation slots had one `animation` name and one `animationMs`. The name becomes the in slot
 * and the old fixed fade-out becomes the out slot, so they look exactly as they did.
 */
export function migrateAnimation<T extends object>(style: T | undefined, whole: boolean): T | undefined {
  if (!style) return style;
  const o = { ...(style as Record<string, unknown>) };
  const name = typeof o.animation === "string" ? (o.animation as EffectName) : undefined;
  const ms = typeof o.animationMs === "number" ? o.animationMs : undefined;
  if (name === undefined && ms === undefined) return style;
  delete o.animationMs;
  const inSlot: Record<string, unknown> = {};
  const outSlot: Record<string, unknown> = {};
  if (name !== undefined) {
    inSlot.name = name;
    inSlot.easing = "linear";
    // the old typewriter timed itself from the text, so it keeps an automatic duration
    inSlot.ms = name === "typewriter" ? 0 : ms ?? (whole ? 200 : undefined);
    if (whole) {
      outSlot.name = "fade";
      outSlot.easing = "linear";
    }
  } else if (typeof o.animation === "object") {
    return o as T;
  }
  if (ms !== undefined) {
    outSlot.ms = ms;
    if (name === undefined) inSlot.ms = ms;
  } else if (whole && name !== undefined) outSlot.ms = 200;
  for (const k of Object.keys(inSlot)) if (inSlot[k] === undefined) delete inSlot[k];
  o.animation = { in: inSlot, out: outSlot, loop: { name: "none", speed: 1 } };
  if (!whole) delete (o.animation as Record<string, unknown>).loop;
  return o as T;
}

export function normalizeProject(raw: Partial<Project>): Project {
  const d = defaultProject();
  raw = {
    ...raw,
    style: migrateAnimation(raw.style, true) as Project["style"] | undefined,
    layers: raw.layers?.map((l) => ({ ...l, style: migrateAnimation(l.style, false) })),
    lines: raw.lines?.map((l) => (l.styleOverride ? { ...l, styleOverride: migrateAnimation(l.styleOverride, false) } : l)),
  } as Partial<Project>;
  const layers: Layer[] = raw.layers?.length
    ? raw.layers.map((l) => ({ ...l, id: l.id || uid(), name: l.name || "Layer", visible: l.visible !== false, locked: !!l.locked }))
    : d.layers;
  return orderByLayers({ ...d, ...raw, layers, style: mergeStyle(DEFAULT_STYLE, raw.style as StyleOverride | undefined), lines: raw.lines ?? [] });
}

/** Debounced autosave: calls `save` ~400ms after the last change to the document. */
export function startAutosave(save: (doc: ProjectDoc, view: Project) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return useProject.subscribe((s, prev) => {
    if (s.doc === prev.doc) return;
    clearTimeout(timer);
    timer = setTimeout(() => save(useProject.getState().doc, useProject.getState().project), 400);
  });
}

/* ---------- per-timeline selectors: components re-render only when the part they show changes ---------- */

export const useActiveTimeline = () => useProject((s) => activeTimeline(s.doc));
export const useTimeline = (id: string) => useProject((s) => s.doc.timelines.find((t) => t.id === id));
export const useTracks = (timelineId: string) => useProject((s) => s.doc.timelines.find((t) => t.id === timelineId)?.tracks);
/** Clips of one track. Returns the same array while that track's clips are unchanged. */
export function useTrackClips(timelineId: string, trackId: string) {
  return useProject((s) => {
    const tl = s.doc.timelines.find((t) => t.id === timelineId);
    return tl ? clipsOf(tl, trackId) : EMPTY;
  });
}
const EMPTY: never[] = [];
const clipCache = new WeakMap<object, Map<string, unknown[]>>();
function clipsOf(tl: ProjectDoc["timelines"][number], trackId: string) {
  let byTrack = clipCache.get(tl.clips);
  if (!byTrack) clipCache.set(tl.clips, (byTrack = new Map()));
  let list = byTrack.get(trackId);
  if (!list) byTrack.set(trackId, (list = tl.clips.filter((c) => c.trackId === trackId)));
  return list as ProjectDoc["timelines"][number]["clips"];
}

export function downloadProject(p: Project) {
  const st = useProject.getState();
  const doc = p === st.project ? st.doc : viewToDoc(p);
  const blob = new Blob([serializeDoc(doc)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "cutir-project.json";
  a.click();
  URL.revokeObjectURL(a.href);
}
