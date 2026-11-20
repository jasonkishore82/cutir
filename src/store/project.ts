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
/** Short decaying reactions that fire on each beat (phase 16.5). */
export type BeatName = "none" | "pulse" | "flash" | "shake" | "nudge" | "colour-swap" | "jump-cut" | "bounce" | "punch" | "heartbeat" | "drop" | "rise" | "swing" | "spin" | "wobble" | "glitch" | "blur-hit" | "strobe";
/** The beat slot: `strength` 0..2 (1 = normal); `downbeatsOnly` reacts on the first beat of each bar only. */
export type BeatSlot = { name: BeatName; strength: number; downbeatsOnly: boolean };

/** How a line appears, stays and leaves. `ms` of 0 means the effect's own automatic duration (typewriter) or none. */
export type AnimationSpec = {
  in: { name: EffectName; ms: number; easing: Easing };
  out: { name: EffectName; ms: number; easing: Easing };
  loop: { name: LoopName; speed: number };
  /** Reaction on each beat of the song (phase 16.5). Missing = none. */
  beat?: BeatSlot;
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
  /**
   * Looks for emphasised words, by level: index 0 is level 1 (mild) to index 2 is level 3 (strongest). A word's
   * `emphasis` picks one; changing a level here restyles every word at that level. Missing = DEFAULT_EMPHASIS.
   */
  emphasis?: EmphasisLevel[];
  /** How much the song's loudness drives motion: 0 = not at all, 1 = fully (phase 16.5). Missing = 0. */
  energy?: number;
  /** Ghost lines: faded copies of the neighbouring lines behind the current one. 0 / missing = off. */
  ghosts?: number;
  /** Ghost brightness 0..1 for the nearest ghost (missing = 0.3); farther ghosts fade further. */
  ghostOpacity?: number;
  /** Ghost distance as a multiple of the current line's block height (missing = 0.9). */
  ghostSpacing?: number;
  /** Label box: a filled card behind the line, like a paper sticker. Missing = none. It tilts with the line's rotation. */
  labelColor?: string;
  /** Label padding around the text in px at 1080p (missing = 24). */
  labelPad?: number;
  /** Fit to frame: size the text so its widest row spans this fraction of the canvas width (0.3..1). Missing / 0 = use fontSize. */
  fitWidth?: number;
  /** Arch: bend each row of text along a circular arc spanning this many degrees. Positive bows up like a rainbow, negative bows down like a smile. Missing / 0 = straight. */
  arch?: number;
  /** Fill up: the text fills with this colour from the bottom as the line is sung (plain entrances only). Missing = none. */
  fillColor?: string;
  /** Echo: ghost lines repeat the current line as outlines (a trail of copies) instead of showing the neighbouring lines. */
  ghostEcho?: boolean;
  /** Text alignment inside the block. Left / right also park the block at that side of the frame (until it is placed freely). Missing = centre. */
  align?: "left" | "center" | "right";
};

/** How an emphasis level changes a word: size multiplier, optional colour and bolder weight. */
export type EmphasisLevel = { scale: number; color?: string; bold?: boolean };

/**
 * Per-word overrides of a line, keyed by word index (words of `line.text` split on whitespace, counted across the
 * whole line). Everything falls back to the line.
 */
export type WordOverride = {
  /** Style on top of the line's resolved style (colour, font, outline, animation slots...). */
  style?: StyleOverride;
  /** Extra placement of the word relative to where the line's layout puts it. x, y are fractions of the canvas. */
  transform?: { x?: number; y?: number; scale?: number; rotation?: number };
  /** Motion keyframes for this word; times are relative to the line's start, like line keyframes. */
  keyframes?: Keyframe[];
  /** Emphasis level 1..3 (0 or missing = normal). */
  emphasis?: 0 | 1 | 2 | 3;
};

/** One beat of the song, read from the timeline's beat markers. `strength` is the onset strength, 0..1. */
export type Beat = { time: number; downbeat: boolean; strength: number };

/** Loudness curve of a song: `values[i]` (0..1) is the level at `i / rate` seconds. */
export type EnergyCurve = { rate: number; values: number[] };

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
  /** Per-word overrides (phase 16.5), keyed by word index. */
  wordOverrides?: Record<number, WordOverride>;
  /** Doodle stickers drawn behind this line's text while the line shows. */
  stickers?: Sticker[];
};

/** A doodle drawn with the line: `x`, `y` are the centre as fractions of the canvas, `size` a fraction of the shorter side. */
export type Sticker = { id: string; shape: string; x: number; y: number; size: number; rotation: number; color: string; outline: boolean };

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
  /**
   * Read-only, derived from the document by docToView (never written back by viewToDoc): the beats of the active
   * timeline (its `kind: "beat"` markers, sorted by time) and the song's loudness curve. Change them with editDoc.
   */
  beats?: Beat[];
  energy?: EnergyCurve;
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
    beat: { name: "none", strength: 1, downbeatsOnly: false },
  },
  highlight: { tint: false, color: "#ffd84a", activeScale: 1 },
  emphasis: [{ scale: 1.3 }, { scale: 1.65, bold: true }, { scale: 2, bold: true, color: "#ffd84a" }],
  energy: 0,
};

export const DEFAULT_EMPHASIS: EmphasisLevel[] = DEFAULT_STYLE.emphasis!;
export const DEFAULT_BEAT: BeatSlot = DEFAULT_STYLE.animation.beat!;

/** Words of a line as word overrides index them: `line.text` split on whitespace, empty parts dropped. */
export const lineWords = (text: string): string[] => text.split(/\s+/).filter(Boolean);

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
export function mergeStyle(base: TextStyle, ...layers: (StyleOverride | undefined)[]): TextStyle {
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

/**
 * Pairs of word indexes (old, new) that are the same word, by longest common subsequence on lower-cased words, so
 * fixing a typo or adding a word keeps the other words' overrides.
 */
export function matchWords(a: string[], b: string[]): [number, number][] {
  const A = a.map((w) => w.toLowerCase());
  const B = b.map((w) => w.toLowerCase());
  const L: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < A.length && j < B.length; ) {
    if (A[i] === B[j]) out.push([i++, j++]);
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** A line with new text: word overrides follow their words; word timings stay only when every word still matches. */
export function retext(line: LyricLine, text: string): LyricLine {
  const before = lineWords(line.text);
  const after = lineWords(text);
  const pairs = matchWords(before, after);
  const next: LyricLine = { ...line, text, words: undefined };
  if (line.words && line.words.length === before.length && before.length === after.length && pairs.length === after.length)
    next.words = pairs.map(([i, j]) => ({ ...line.words![i], text: after[j] }));
  if (line.wordOverrides) {
    const wo: Record<number, WordOverride> = {};
    for (const [i, j] of pairs) if (line.wordOverrides[i]) wo[j] = line.wordOverrides[i];
    if (Object.keys(wo).length) next.wordOverrides = wo;
    else delete next.wordOverrides;
  }
  return next;
}

/** A line with one word's override merged with `patch` (undefined fields removed, empty overrides dropped). */
export function setWordOverride(line: LyricLine, index: number, patch: Partial<WordOverride>): LyricLine {
  const cur: Record<string, unknown> = { ...(line.wordOverrides?.[index] ?? {}), ...patch };
  for (const k of Object.keys(cur)) if (cur[k] === undefined || (k === "emphasis" && cur[k] === 0)) delete cur[k];
  const wo = { ...(line.wordOverrides ?? {}) };
  if (Object.keys(cur).length) wo[index] = cur as WordOverride;
  else delete wo[index];
  const next: LyricLine = { ...line, wordOverrides: wo };
  if (!Object.keys(wo).length) delete next.wordOverrides;
  return next;
}

/** Rebuild lines from textarea text, keeping existing ids/timings by index. */
export function linesFromText(text: string, prev: LyricLine[]): LyricLine[] {
  const rows = text.split("\n").map((r) => r.trim()).filter(Boolean);
  const out: LyricLine[] = [];
  rows.forEach((row, i) => {
    const old = prev[i];
    if (old) {
      out.push(old.text === row ? old : retext(old, row));
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
  /** A single word picked on the preview (double-click a line); null = whole lines are selected. */
  selectedWord: { lineId: string; index: number } | null;
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
  /** Pick one word of a line (also selects that line), or null to go back to whole lines. */
  selectWord: (w: { lineId: string; index: number } | null) => void;
  /** Merge `patch` into one word's override (undoable). Undefined fields are removed; an empty override is dropped. */
  updateWord: (lineId: string, index: number, patch: Partial<WordOverride>, coalesceKey?: string) => void;
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
  selectedWord: null,
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
    set({ doc, project, past: [], future: [], selectedLineId: null, selectedIds: [], selectedWord: null, activeLayerId: project.layers[0].id });
  },
  select: (id, add) =>
    set((s) => {
      if (id === null) return { selectedLineId: null, selectedIds: [], selectedWord: null };
      if (!add) return { selectedLineId: id, selectedIds: [id], selectedWord: s.selectedWord?.lineId === id ? s.selectedWord : null };
      if (s.selectedIds.includes(id)) {
        const rest = s.selectedIds.filter((x) => x !== id);
        return { selectedIds: rest, selectedLineId: s.selectedLineId === id ? rest[rest.length - 1] ?? null : s.selectedLineId };
      }
      return { selectedIds: [...s.selectedIds, id], selectedLineId: id };
    }),
  selectMany: (ids) => set({ selectedIds: ids, selectedLineId: ids[ids.length - 1] ?? null, selectedWord: null }),
  setActiveLayer: (activeLayerId) => set({ activeLayerId }),
  selectWord: (w) => set(w ? { selectedWord: w, selectedLineId: w.lineId, selectedIds: [w.lineId] } : { selectedWord: null }),
  updateWord: (lineId, index, patch, key) =>
    get().update((p) => ({ ...p, lines: p.lines.map((l) => (l.id === lineId ? setWordOverride(l, index, patch) : l)) }), key),
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
