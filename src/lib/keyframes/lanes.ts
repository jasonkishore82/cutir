import type { Clip, ParamKey, ProjectDoc, Timeline } from "../../model/types";
import { IDENTITY_TRANSFORM } from "../../model/types";
import { getEffect, paramKind, type ParamSpec } from "../effects";
import { isLocked } from "../../timeline/engine";
import { activeTimeline } from "../../model/convert";
import { evalLane, pasteKeys, setKey, setShape, shiftKeys, sortKeys, type EaseName, type Key, type KeyMode, type KeyValue, type ValueKind } from "./engine";

/**
 * The animatable values of a clip, each addressed by a LaneId:
 *   { kind: "clip", name: "x" | "y" | "scale" | "rotation" | "opacity" | "volume" }   placement and volume
 *   { kind: "effect", fxId, param }                                                    an effect's param
 * The inspector, the keyframe lane, the curve editor and the chat tools all read and write through here, so a new
 * effect param or clip value is animatable without further work.
 */

export type LaneId = { kind: "clip"; name: ClipLane } | { kind: "effect"; fxId: string; param: string };
export type ClipLane = "x" | "y" | "scale" | "rotation" | "opacity" | "volume";

export type LaneInfo = {
  id: LaneId;
  /** Stable string form, for selection and maps. */
  key: string;
  label: string;
  group: string;
  valueKind: ValueKind;
  /** Display range and unit (for the curve editor's axis and the inspector). */
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Shown value = stored value * factor. */
  factor: number;
  keys: Key[];
  /** The plain (unanimated) value. */
  base: KeyValue;
};

export const laneKey = (id: LaneId) => (id.kind === "clip" ? `clip:${id.name}` : `fx:${id.fxId}:${id.param}`);
export function parseLaneKey(key: string): LaneId | null {
  const m = /^clip:(x|y|scale|rotation|opacity|volume)$/.exec(key);
  if (m) return { kind: "clip", name: m[1] as ClipLane };
  const f = /^fx:([^:]+):(.+)$/.exec(key);
  return f ? { kind: "effect", fxId: f[1], param: f[2] } : null;
}

const CLIP_LANES: Record<ClipLane, Omit<LaneInfo, "id" | "key" | "keys" | "base">> = {
  x: { label: "Horizontal", group: "Placement", valueKind: "number", min: -50, max: 150, step: 0.5, unit: "%", factor: 100 },
  y: { label: "Vertical", group: "Placement", valueKind: "number", min: -50, max: 150, step: 0.5, unit: "%", factor: 100 },
  scale: { label: "Size", group: "Placement", valueKind: "number", min: 5, max: 400, step: 1, unit: "%", factor: 100 },
  rotation: { label: "Rotation", group: "Placement", valueKind: "angle", min: -180, max: 180, step: 1, unit: " deg", factor: 1 },
  opacity: { label: "Opacity", group: "Placement", valueKind: "number", min: 0, max: 100, step: 1, unit: "%", factor: 100 },
  volume: { label: "Volume", group: "Sound", valueKind: "number", min: 0, max: 200, step: 1, unit: "%", factor: 100 },
};

const baseOf = (c: Clip, name: ClipLane): number => (name === "volume" ? c.volume ?? 1 : ((c.transform ?? {})[name] ?? IDENTITY_TRANSFORM[name]) as number);

/** Every lane a clip has (placement or volume by media kind, plus every param of every effect). */
export function lanesOf(c: Clip, doc: ProjectDoc): LaneInfo[] {
  const kind = doc.media.find((m) => m.id === c.mediaId)?.kind;
  const out: LaneInfo[] = [];
  const names: ClipLane[] = kind === "audio" ? ["volume"] : kind === "video" || kind === "image" ? ["x", "y", "scale", "rotation", "opacity"] : [];
  for (const name of names) {
    const id: LaneId = { kind: "clip", name };
    out.push({ id, key: laneKey(id), ...CLIP_LANES[name], keys: (c.anim?.[name] ?? []) as Key[], base: baseOf(c, name) });
  }
  for (const fx of c.effects) {
    const def = getEffect(fx.type);
    if (!def) continue;
    for (const spec of def.params) {
      if (spec.type === "boolean" || spec.type === "choice" || spec.type === "curve") continue;
      const id: LaneId = { kind: "effect", fxId: fx.id, param: spec.key };
      out.push({ id, key: laneKey(id), ...specRange(spec), label: spec.label, group: def.name, valueKind: paramKind(spec), keys: (fx.keys?.[spec.key] ?? []) as Key[], base: fx.params[spec.key] as KeyValue });
    }
  }
  return out;
}

function specRange(spec: ParamSpec): Pick<LaneInfo, "min" | "max" | "step" | "unit" | "factor"> {
  if (spec.type === "number") return { min: spec.min, max: spec.max, step: spec.step ?? 1, unit: spec.unit ? ` ${spec.unit}` : "", factor: 1 };
  if (spec.type === "angle") return { min: -180, max: 180, step: 1, unit: " deg", factor: 1 };
  if (spec.type === "point") return { min: 0, max: 100, step: 0.5, unit: "%", factor: 100 };
  return { min: 0, max: 1, step: 1, unit: "", factor: 1 };
}

export const laneOf = (c: Clip, doc: ProjectDoc, id: LaneId) => lanesOf(c, doc).find((l) => l.key === laneKey(id));

/** The value of a lane at t seconds into the clip. */
export const laneValue = (l: LaneInfo, t: number): KeyValue => evalLane(l.keys, t, l.base, l.valueKind);

/* ---------- writing (pure on a Timeline) ---------- */

function writeLane(tl: Timeline, clipId: string, id: LaneId, keys: Key[] | null): Timeline {
  const c = tl.clips.find((x) => x.id === clipId);
  if (!c || isLocked(tl, c.trackId)) return tl;
  const next: Clip = { ...c };
  if (id.kind === "clip") {
    const anim = { ...(c.anim ?? {}) };
    if (keys?.length) anim[id.name] = keys as ParamKey[];
    else delete anim[id.name];
    if (Object.keys(anim).length) next.anim = anim;
    else delete next.anim;
  } else {
    next.effects = c.effects.map((fx) => {
      if (fx.id !== id.fxId) return fx;
      const all = { ...(fx.keys ?? {}) };
      if (keys?.length) all[id.param] = keys as ParamKey[];
      else delete all[id.param];
      const out = { ...fx };
      if (Object.keys(all).length) out.keys = all;
      else delete out.keys;
      return out;
    });
  }
  return { ...tl, clips: tl.clips.map((x) => (x.id === clipId ? next : x)) };
}

const current = (tl: Timeline, clipId: string, id: LaneId): Key[] => {
  const c = tl.clips.find((x) => x.id === clipId);
  if (!c) return [];
  if (id.kind === "clip") return (c.anim?.[id.name] ?? []) as Key[];
  return (c.effects.find((f) => f.id === id.fxId)?.keys?.[id.param] ?? []) as Key[];
};

/** Set a key at t (seconds into the clip). */
export const setLaneKey = (tl: Timeline, clipId: string, id: LaneId, t: number, v: KeyValue) => writeLane(tl, clipId, id, setKey(current(tl, clipId, id), t, v));
export const removeLaneKey = (tl: Timeline, clipId: string, id: LaneId, t: number) => writeLane(tl, clipId, id, current(tl, clipId, id).filter((k) => Math.abs(k.t - t) > 0.02));
export const clearLane = (tl: Timeline, clipId: string, id: LaneId) => writeLane(tl, clipId, id, null);
export const replaceLane = (tl: Timeline, clipId: string, id: LaneId, keys: Key[]) => writeLane(tl, clipId, id, sortKeys(keys));

/** Move the keys at the given times by dt. */
export const moveLaneKeys = (tl: Timeline, clipId: string, id: LaneId, times: number[], dt: number) =>
  writeLane(tl, clipId, id, shiftKeys(current(tl, clipId, id), (k) => times.some((t) => Math.abs(k.t - t) <= 0.02), dt));

/** Change the shape of the keys at the given times (all keys when `times` is empty). */
export const shapeLaneKeys = (tl: Timeline, clipId: string, id: LaneId, times: number[], mode: KeyMode, easing?: EaseName) =>
  writeLane(tl, clipId, id, setShape(current(tl, clipId, id), (k) => !times.length || times.some((t) => Math.abs(k.t - t) <= 0.02), mode, easing));

/** Paste copied keys into a lane; times stay relative to the destination clip's start. */
export const pasteLaneKeys = (tl: Timeline, clipId: string, id: LaneId, copied: Key[], atOffset = 0) => {
  const c = tl.clips.find((x) => x.id === clipId);
  return writeLane(tl, clipId, id, pasteKeys(current(tl, clipId, id), copied, c?.duration, atOffset));
};

/** Key the lane's value at t to what it shows at t (adds a key without changing the picture). */
export const holdLaneAt = (tl: Timeline, clipId: string, id: LaneId, t: number, doc: ProjectDoc) => {
  const c = tl.clips.find((x) => x.id === clipId);
  const l = c && laneOf(c, doc, id);
  return l ? setLaneKey(tl, clipId, id, t, laneValue(l, t)) : tl;
};

/** Clips' lanes copied for paste: everything, as { laneKey -> keys }. */
export function copyLanes(c: Clip, doc: ProjectDoc, onlyKeys?: Set<string>): Record<string, Key[]> {
  const out: Record<string, Key[]> = {};
  for (const l of lanesOf(c, doc)) if (l.keys.length && (!onlyKeys || onlyKeys.has(l.key))) out[l.key] = structuredClone(l.keys);
  return out;
}

/** Paste copied lanes onto a clip. Effect lanes match by param name on the first effect of the same type. */
export function pasteLanes(tl: Timeline, clipId: string, copied: Record<string, Key[]>, sourceClip?: Clip, atOffset = 0): Timeline {
  let next = tl;
  const c = tl.clips.find((x) => x.id === clipId);
  if (!c) return tl;
  for (const [key, keys] of Object.entries(copied)) {
    const id = parseLaneKey(key);
    if (!id) continue;
    if (id.kind === "clip") {
      next = pasteLaneKeys(next, clipId, id, keys, atOffset);
      continue;
    }
    const srcFx = sourceClip?.effects.find((f) => f.id === id.fxId);
    const type = srcFx?.type;
    const target = c.effects.find((f) => f.id === id.fxId) ?? (type ? c.effects.find((f) => f.type === type) : undefined);
    if (target) next = pasteLaneKeys(next, clipId, { kind: "effect", fxId: target.id, param: id.param }, keys, atOffset);
  }
  return next;
}

/**
 * Set a placement value of a clip from the viewer or a slider: keyed (at `rel`, clip-relative) when the lane already
 * has keys or auto-key is on, otherwise the plain value.
 */
export function writePlacement(tl: Timeline, clipId: string, name: ClipLane, v: number, rel: number, autoKey: boolean): Timeline {
  const c = tl.clips.find((x) => x.id === clipId);
  if (!c) return tl;
  const id: LaneId = { kind: "clip", name };
  if ((c.anim?.[name]?.length ?? 0) > 0 || autoKey) return rel >= 0 && rel <= c.duration ? setLaneKey(tl, clipId, id, rel, v) : tl;
  return {
    ...tl,
    clips: tl.clips.map((x) => (x.id !== clipId ? x : name === "volume" ? { ...x, volume: v } : { ...x, transform: { ...(x.transform ?? {}), [name]: v } })),
  };
}

/** The selected keys, grouped per lane, with times relative to the first one. */
export function copySelectedKeys(doc: ProjectDoc, sel: { clipId: string; laneKey: string; t: number }[]): { lanes: Record<string, Key[]>; fromClipId: string; t0: number } | null {
  if (!sel.length) return null;
  const clipId = sel[0].clipId;
  const clip = activeTimeline(doc).clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const mine = sel.filter((s) => s.clipId === clipId);
  const t0 = Math.min(...mine.map((s) => s.t));
  const lanes: Record<string, Key[]> = {};
  for (const l of lanesOf(clip, doc)) {
    const keys = l.keys.filter((k) => mine.some((s) => s.laneKey === l.key && Math.abs(s.t - k.t) <= 0.02));
    if (keys.length) lanes[l.key] = keys.map((k) => ({ ...structuredClone(k), t: k.t - t0 }));
  }
  return Object.keys(lanes).length ? { lanes, fromClipId: clipId, t0 } : null;
}

/** Where a paste lands on `clip`: at the playhead when it is inside the clip, else at the copied offset. */
export function pasteOffset(clip: Clip, t0: number, playhead: number): number {
  const rel = playhead - clip.start;
  return rel >= 0 && rel <= clip.duration ? rel : t0;
}

