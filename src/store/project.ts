import { create } from "zustand";

/* ---------- Types ---------- */

export type Aspect = "16:9" | "9:16" | "1:1";
export type AnimationName = "fade" | "pop" | "slide-up" | "typewriter" | "word-highlight";
export type Position = "top" | "center" | "bottom";

export type AssetRef = {
  name: string;
  kind: "audio" | "image" | "video";
  /** Object URL, valid for this session only; stripped when saving to JSON. */
  url?: string;
};

export type Background =
  | { type: "gradient"; colors: string[]; angle: number; noise: boolean }
  | { type: "asset"; asset?: AssetRef };

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
  animation: AnimationName;
  animationMs: number;
};

export type LyricLine = {
  id: string;
  text: string;
  start: number;
  end: number;
  words?: { text: string; start: number; end: number }[];
  styleOverride?: Partial<TextStyle>;
};

export type Project = {
  audio?: AssetRef;
  background: Background;
  lines: LyricLine[];
  style: TextStyle;
  aspect: Aspect;
  fps: 30 | 60;
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
  animation: "fade",
  animationMs: 200,
};

export const defaultProject = (): Project => ({
  background: DEFAULT_GRADIENT,
  lines: [],
  style: DEFAULT_STYLE,
  aspect: "16:9",
  fps: 30,
});

/* ---------- Helpers ---------- */

export const uid = () => Math.random().toString(36).slice(2, 10);

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

/** Strip session-only blob URLs before serialising. */
export function serializeProject(p: Project): string {
  const strip = (a?: AssetRef) => (a ? { ...a, url: undefined } : a);
  const bg: Background =
    p.background.type === "asset" ? { ...p.background, asset: strip(p.background.asset) } : p.background;
  return JSON.stringify({ ...p, audio: strip(p.audio), background: bg }, null, 2);
}

/* ---------- Store ---------- */

const HISTORY_LIMIT = 200;
const COALESCE_MS = 600;

type State = {
  project: Project;
  past: Project[];
  future: Project[];

  // non-undoable UI state
  selectedLineId: string | null;
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

  setStyle: (patch: Partial<TextStyle>, coalesceKey?: string) => void;
  setAspect: (a: Aspect) => void;
  setBackground: (b: Background) => void;
  setAudio: (a?: AssetRef) => void;
  setLinesFromText: (text: string) => void;
  updateLine: (id: string, patch: Partial<LyricLine>, coalesceKey?: string) => void;
  loadProject: (p: Project) => void;
  select: (id: string | null) => void;
  toggleChat: () => void;
  setSync: (on: boolean, index?: number) => void;
  setSyncIndex: (i: number) => void;
};

let batchDepth = 0;
let batchBase: Project | null = null;
let lastKey: string | undefined;
let lastTime = 0;

export const useProject = create<State>((set, get) => ({
  project: defaultProject(),
  past: [],
  future: [],
  selectedLineId: null,
  chatOpen: true,
  syncMode: false,
  syncIndex: 0,

  update: (fn, coalesceKey) => {
    const { project, past } = get();
    const next = fn(project);
    if (next === project) return;

    // Inside a batch: just apply; the base snapshot is pushed once at the end.
    if (batchDepth > 0) {
      set({ project: next });
      return;
    }

    const now = Date.now();
    const coalesce = !!coalesceKey && coalesceKey === lastKey && now - lastTime < COALESCE_MS;
    lastKey = coalesceKey;
    lastTime = now;

    set({
      project: next,
      past: coalesce ? past : [...past, project].slice(-HISTORY_LIMIT),
      future: [],
    });
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
    if (batchDepth === 0) batchBase = get().project;
    batchDepth++;
  },

  endGesture: () => {
    if (batchDepth === 0) return;
    batchDepth--;
    if (batchDepth === 0 && batchBase) {
      const { project, past } = get();
      if (project !== batchBase) {
        set({ past: [...past, batchBase].slice(-HISTORY_LIMIT), future: [] });
      }
      batchBase = null;
      lastKey = undefined;
    }
  },

  undo: () => {
    const { past, future, project } = get();
    if (!past.length) return;
    lastKey = undefined;
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] });
  },

  redo: () => {
    const { past, future, project } = get();
    if (!future.length) return;
    lastKey = undefined;
    set({ project: future[0], past: [...past, project], future: future.slice(1) });
  },

  setStyle: (patch, key) =>
    get().update((p) => ({ ...p, style: { ...p.style, ...patch } }), key ?? `style:${Object.keys(patch).join(",")}`),
  setAspect: (aspect) => get().update((p) => ({ ...p, aspect })),
  setBackground: (background) => get().update((p) => ({ ...p, background })),
  setAudio: (audio) => get().update((p) => ({ ...p, audio })),
  setLinesFromText: (text) => get().update((p) => ({ ...p, lines: linesFromText(text, p.lines) }), "lyrics-text"),
  updateLine: (id, patch, key) =>
    get().update((p) => ({ ...p, lines: p.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) }), key),
  loadProject: (project) => set({ project, past: [], future: [], selectedLineId: null }),
  select: (selectedLineId) => set({ selectedLineId }),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  setSync: (syncMode, index) => set((s) => ({ syncMode, syncIndex: index ?? (syncMode ? 0 : s.syncIndex) })),
  setSyncIndex: (syncIndex) => set({ syncIndex }),
}));

/* ---------- Persistence ---------- */

export function normalizeProject(raw: Partial<Project>): Project {
  const d = defaultProject();
  return { ...d, ...raw, style: { ...DEFAULT_STYLE, ...raw.style }, lines: raw.lines ?? [] };
}

/** Debounced autosave: calls `save` ~400ms after the last change to the project. */
export function startAutosave(save: (p: Project) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return useProject.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    clearTimeout(timer);
    timer = setTimeout(() => save(s.project), 400);
  });
}

export function downloadProject(p: Project) {
  const blob = new Blob([serializeProject(p)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "cutir-project.json";
  a.click();
  URL.revokeObjectURL(a.href);
}
