import { create } from "zustand";
import {
  DEFAULT_STYLE,
  layerIdOf,
  linesOfLayer,
  resolveLayerStyle,
  resolveStyle,
  useProject,
  type LyricLine,
  type Project,
  type StyleOverride,
} from "../store/project";
import { getLineBounds, ASPECT_SIZES } from "./renderer";

/**
 * Editing styles at the right level. A style value can be set on a line, on a layer or on the project; the most
 * specific one wins. Fields are addressed by a dot path such as `shadow.blur`.
 */

export type Scope = "line" | "layer" | "project";
export type Target = { scope: "line"; ids: string[] } | { scope: "layer"; layerId: string } | { scope: "project" };
export type FieldRead = { value: unknown; mixed: boolean; source: Scope; overridden: boolean };

/* ---------- paths ---------- */

const getIn = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]), o);

function setIn<T extends object>(o: T | undefined, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const cur = (o ?? {}) as Record<string, unknown>;
  return { ...cur, [head]: rest.length ? setIn(cur[head] as object | undefined, rest.join("."), value) : value } as T;
}

/** Remove a field and any group left empty by it. Returns undefined when nothing remains. */
function unsetIn<T extends object>(o: T | undefined, path: string): T | undefined {
  if (!o) return undefined;
  const [head, ...rest] = path.split(".");
  const cur = { ...(o as Record<string, unknown>) };
  if (rest.length) {
    const inner = unsetIn(cur[head] as object | undefined, rest.join("."));
    if (inner === undefined) delete cur[head];
    else cur[head] = inner;
  } else delete cur[head];
  return Object.keys(cur).length ? (cur as T) : undefined;
}

/** Identity of a target, for merging a slider drag into one undo step only while it stays on the same thing. */
export const targetKey = (t: Target) => (t.scope === "line" ? `line:${t.ids.join(",")}` : t.scope === "layer" ? `layer:${t.layerId}` : "project");

/* ---------- reading ---------- */

export function readField(p: Project, t: Target, path: string): FieldRead {
  if (t.scope === "project") return { value: getIn(p.style, path), mixed: false, source: "project", overridden: false };

  if (t.scope === "layer") {
    const layer = p.layers.find((l) => l.id === t.layerId) ?? p.layers[0];
    const own = getIn(layer.style, path);
    return { value: getIn(resolveLayerStyle(p, layer), path), mixed: false, source: own !== undefined ? "layer" : "project", overridden: own !== undefined };
  }

  const lines = p.lines.filter((l) => t.ids.includes(l.id));
  if (!lines.length) return { value: getIn(p.style, path), mixed: false, source: "project", overridden: false };
  const values = lines.map((l) => getIn(resolveStyle(p, l), path));
  const mixed = values.some((v) => v !== values[0]);
  const lineOwn = lines.some((l) => getIn(l.styleOverride, path) !== undefined);
  const layerOwn = lines.some((l) => getIn(p.layers.find((x) => x.id === layerIdOf(p, l))?.style, path) !== undefined);
  return { value: values[0], mixed, source: lineOwn ? "line" : layerOwn ? "layer" : "project", overridden: lineOwn };
}

/* ---------- writing ---------- */

type Edit = { set?: [string, unknown][]; unset?: string[] };

function applyEdit(o: StyleOverride | undefined, e: Edit): StyleOverride | undefined {
  let out = o;
  for (const [path, v] of e.set ?? []) out = setIn(out, path, v);
  for (const path of e.unset ?? []) out = unsetIn(out, path);
  return out;
}

/** One undoable change to one level. Sliders pass a key so a drag merges into a single step. */
export function editStyle(t: Target, e: Edit, coalesceKey?: string) {
  useProject.getState().update((p) => {
    if (t.scope === "project") {
      let style = p.style as StyleOverride;
      for (const [path, v] of e.set ?? []) style = setIn(style, path, v);
      for (const path of e.unset ?? []) style = setIn(style, path, getIn(DEFAULT_STYLE, path)); // the project always has a value
      return { ...p, style: style as Project["style"] };
    }
    if (t.scope === "layer") {
      return { ...p, layers: p.layers.map((l) => (l.id === t.layerId ? { ...l, style: applyEdit(l.style, e) } : l)) };
    }
    const ids = new Set(t.ids);
    return { ...p, lines: p.lines.map((l) => (ids.has(l.id) ? { ...l, styleOverride: applyEdit(l.styleOverride, e) } : l)) };
  }, coalesceKey);
}

export const writeField = (t: Target, path: string, value: unknown, key?: string) => editStyle(t, { set: [[path, value]] }, key);
export const resetFields = (t: Target, paths: string[]) => editStyle(t, { unset: paths });

/* ---------- copy and apply ---------- */

/** Everything that styles a line except where it sits. */
const COPY_PATHS = [
  "fontFamily", "fontSize", "color", "uppercase", "letterSpacing", "lineHeight", "maxCharsPerLine",
  "shadow.blur", "shadow.offsetX", "shadow.offsetY", "shadow.opacity", "outline.width", "outline.color", "animation", "animationMs",
];

export function snapshotOf(p: Project, lineId: string): [string, unknown][] | null {
  const line = p.lines.find((l) => l.id === lineId);
  if (!line) return null;
  const s = resolveStyle(p, line);
  return COPY_PATHS.map((path) => [path, getIn(s, path)]);
}

type Clip = { snapshot: [string, unknown][] | null; set: (s: [string, unknown][] | null) => void };
export const useStyleClipboard = create<Clip>((set) => ({ snapshot: null, set: (snapshot) => set({ snapshot }) }));

export const copyStyle = (lineId: string) => useStyleClipboard.getState().set(snapshotOf(useProject.getState().project, lineId));

/**
 * Give lines the copied style as their own overrides, in one undo step. Only fields that differ from what a line
 * already resolves to are written, so the rest keep following the layer and the project.
 */
export function applyStyle(ids: string[], snapshot: [string, unknown][]) {
  const want = new Set(ids);
  useProject.getState().update((p) => ({
    ...p,
    lines: p.lines.map((l) => {
      if (!want.has(l.id)) return l;
      const cur = resolveStyle(p, l);
      let o = l.styleOverride;
      for (const [path, v] of snapshot) if (getIn(cur, path) !== v) o = setIn(o, path, v);
      return o === l.styleOverride ? l : { ...l, styleOverride: o };
    }),
  }));
}

export const idsOfLayer = (p: Project, lineId: string) => {
  const line = p.lines.find((l) => l.id === lineId);
  return line ? linesOfLayer(p, layerIdOf(p, line)).map((l) => l.id) : [];
};

/* ---------- alignment ---------- */

export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
const MARGIN = 0.05;

type Box = { line: LyricLine; cx: number; cy: number; hw: number; hh: number };

function boxesOf(p: Project, ids: string[]): { boxes: Box[]; W: number; H: number } {
  const { w: W, h: H } = ASPECT_SIZES[p.aspect];
  const boxes: Box[] = [];
  for (const l of p.lines) {
    if (!ids.includes(l.id)) continue;
    const b = getLineBounds(p, l, W, H);
    if (!b) continue;
    const a = (b.rotation * Math.PI) / 180;
    boxes.push({ line: l, cx: b.cx, cy: b.cy, hw: Math.abs(Math.cos(a)) * b.halfW + Math.abs(Math.sin(a)) * b.halfH, hh: Math.abs(Math.sin(a)) * b.halfW + Math.abs(Math.cos(a)) * b.halfH });
  }
  return { boxes, W, H };
}

function place(p: Project, moves: Map<string, { x?: number; y?: number }>): Project {
  return {
    ...p,
    lines: p.lines.map((l) => {
      const m = moves.get(l.id);
      if (!m) return l;
      let o = l.styleOverride;
      if (m.x !== undefined) o = setIn(o, "transform.x", m.x);
      if (m.y !== undefined) o = setIn(o, "transform.y", m.y);
      return { ...l, styleOverride: o };
    }),
  };
}

/** Align the selected lines to the canvas (edges use the 5% safe margin). */
export function alignLines(ids: string[], mode: AlignMode) {
  useProject.getState().update((p) => {
    const { boxes, W, H } = boxesOf(p, ids);
    const moves = new Map<string, { x?: number; y?: number }>();
    for (const b of boxes) {
      if (mode === "left") moves.set(b.line.id, { x: (W * MARGIN + b.hw) / W });
      else if (mode === "right") moves.set(b.line.id, { x: (W * (1 - MARGIN) - b.hw) / W });
      else if (mode === "centerX") moves.set(b.line.id, { x: 0.5 });
      else if (mode === "top") moves.set(b.line.id, { y: (H * MARGIN + b.hh) / H });
      else if (mode === "bottom") moves.set(b.line.id, { y: (H * (1 - MARGIN) - b.hh) / H });
      else moves.set(b.line.id, { y: 0.5 });
    }
    return moves.size ? place(p, moves) : p;
  });
}

/** Space three or more lines evenly between the outermost two. */
export function distributeLines(ids: string[], axis: "x" | "y") {
  useProject.getState().update((p) => {
    const { boxes, W, H } = boxesOf(p, ids);
    if (boxes.length < 3) return p;
    const sorted = [...boxes].sort((a, b) => (axis === "x" ? a.cx - b.cx : a.cy - b.cy));
    const size = (b: Box) => (axis === "x" ? b.hw : b.hh) * 2;
    const start = axis === "x" ? sorted[0].cx - sorted[0].hw : sorted[0].cy - sorted[0].hh;
    const last = sorted[sorted.length - 1];
    const end = axis === "x" ? last.cx + last.hw : last.cy + last.hh;
    const gap = (end - start - sorted.reduce((n, b) => n + size(b), 0)) / (sorted.length - 1);
    const moves = new Map<string, { x?: number; y?: number }>();
    let at = start;
    for (const b of sorted) {
      const c = at + size(b) / 2;
      moves.set(b.line.id, axis === "x" ? { x: c / W } : { y: c / H });
      at += size(b) + gap;
    }
    return place(p, moves);
  });
}
