import type { Clip, ClipEffect, ClipTransition, ParamKey, ProjectDoc, Timeline } from "../model/types";
import { cleanParams, getEffect, getTransition, newEffect, newTransition } from "../lib/effects";
import { clipsOn, isLocked } from "./engine";

/**
 * Effect stacks and transitions on a timeline (phase 17). Pure: each returns a new Timeline (or the same one when
 * nothing changes), so every edit is one undoable operation. Locked tracks are never changed.
 */

const EPS = 0.05;

/** Clips that can carry picture effects: video and image clips on unlocked tracks. */
export function effectTargets(tl: Timeline, doc: ProjectDoc, ids: string[]): string[] {
  return ids.filter((id) => {
    const c = tl.clips.find((x) => x.id === id);
    if (!c || c.fill || c.text || !c.mediaId || isLocked(tl, c.trackId)) return false;
    const kind = doc.media.find((m) => m.id === c.mediaId)?.kind;
    return kind === "video" || kind === "image";
  });
}

const mapClips = (tl: Timeline, ids: Set<string>, fn: (c: Clip) => Clip): Timeline => {
  let changed = false;
  const clips = tl.clips.map((c) => {
    if (!ids.has(c.id) || isLocked(tl, c.trackId)) return c;
    const n = fn(c);
    if (n !== c) changed = true;
    return n;
  });
  return changed ? { ...tl, clips } : tl;
};

/** Add an effect (with optional params) to the end of each clip's stack. */
export function addEffect(tl: Timeline, ids: string[], type: string, params: Record<string, unknown> = {}): Timeline {
  return mapClips(tl, new Set(ids), (c) => ({ ...c, effects: [...c.effects, newEffect(type, params)] }));
}

/** Change an effect's params, enabled state or keyframes. Params are checked against the effect's spec. */
export function updateEffect(tl: Timeline, clipId: string, fxId: string, patch: { params?: Record<string, unknown>; enabled?: boolean; keys?: Record<string, ParamKey[]> | null }): Timeline {
  return mapClips(tl, new Set([clipId]), (c) => ({
    ...c,
    effects: c.effects.map((e) => {
      if (e.id !== fxId) return e;
      const def = getEffect(e.type);
      const next: ClipEffect = { ...e };
      if (patch.params) next.params = { ...e.params, ...(def ? cleanParams(def.params, patch.params) : patch.params) };
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.keys === null) delete next.keys;
      else if (patch.keys) next.keys = patch.keys;
      return next;
    }),
  }));
}

export const removeEffect = (tl: Timeline, clipId: string, fxId: string): Timeline =>
  mapClips(tl, new Set([clipId]), (c) => ({ ...c, effects: c.effects.filter((e) => e.id !== fxId) }));

/** Move an effect up (-1) or down (+1) in its clip's stack. Effects apply top to bottom. */
export function moveEffect(tl: Timeline, clipId: string, fxId: string, dir: -1 | 1): Timeline {
  return mapClips(tl, new Set([clipId]), (c) => {
    const i = c.effects.findIndex((e) => e.id === fxId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= c.effects.length) return c;
    const effects = [...c.effects];
    [effects[i], effects[j]] = [effects[j], effects[i]];
    return { ...c, effects };
  });
}

/** Back to the effect's default params (keyframes cleared). */
export function resetEffect(tl: Timeline, clipId: string, fxId: string): Timeline {
  return mapClips(tl, new Set([clipId]), (c) => ({
    ...c,
    effects: c.effects.map((e) => {
      if (e.id !== fxId) return e;
      const fresh = newEffect(e.type);
      return { ...e, params: fresh.params, keys: undefined };
    }),
  }));
}

/** Copies of a stack (new ids), for paste and presets. Unknown effects are left out. */
export const copyStack = (stack: ClipEffect[]): ClipEffect[] =>
  stack.filter((e) => getEffect(e.type)).map((e) => ({ ...newEffect(e.type, e.params), enabled: e.enabled, ...(e.keys ? { keys: structuredClone(e.keys) } : {}) }));

/** Replace (or append to) the stacks of clips with copies of `stack`. */
export function applyStackTo(tl: Timeline, ids: string[], stack: ClipEffect[], mode: "replace" | "append" = "replace"): Timeline {
  return mapClips(tl, new Set(ids), (c) => ({ ...c, effects: mode === "replace" ? copyStack(stack) : [...c.effects, ...copyStack(stack)] }));
}

/* ---------- transitions ---------- */

/** The clip linked to `id` on an audio track (its sound), if any. */
function soundOf(tl: Timeline, id: string | undefined): Clip | undefined {
  const c = id ? tl.clips.find((x) => x.id === id) : undefined;
  if (!c?.linkId) return undefined;
  return tl.clips.find((x) => x.id !== c.id && x.linkId === c.linkId && tl.tracks.find((t) => t.id === x.trackId)?.kind === "audio");
}

/**
 * Add a transition at the cut between `from` and `to` (or at one clip's edge when the other is missing). Any
 * transition already there is replaced. On a video track, a crossfade is added for the clips' linked sound too
 * (when the sound clips meet at the same cut); it can then be edited or removed on its own.
 */
export function addTransition(tl: Timeline, o: { trackId: string; from?: string; to?: string; type: string; duration?: number; align?: ClipTransition["align"] }): Timeline {
  if (isLocked(tl, o.trackId) || (!o.from && !o.to)) return tl;
  const same = (x: ClipTransition, trackId: string, from?: string, to?: string) => x.trackId === trackId && x.from === from && x.to === to;
  let list = (tl.cutTransitions ?? []).filter((x) => !same(x, o.trackId, o.from, o.to));
  list = [...list, newTransition(o.trackId, o.type, o.from, o.to, o.duration ?? 0.5, o.align ?? "center")];
  const track = tl.tracks.find((t) => t.id === o.trackId);
  if (track?.kind === "video") {
    const sa = soundOf(tl, o.from);
    const sb = soundOf(tl, o.to);
    const trackId = (sa ?? sb)?.trackId;
    const meet = sa && sb ? sa.trackId === sb.trackId && Math.abs(sa.start + sa.duration - sb.start) < EPS : !!(sa ?? sb);
    if (trackId && meet && !isLocked(tl, trackId)) {
      list = list.filter((x) => !same(x, trackId, sa?.id, sb?.id));
      list.push(newTransition(trackId, "crossfade", sa?.id, sb?.id, o.duration ?? 0.5, o.align ?? "center"));
    }
  }
  return { ...tl, cutTransitions: list };
}

export function updateTransition(tl: Timeline, id: string, patch: Partial<Pick<ClipTransition, "type" | "duration" | "align" | "easing" | "params">>): Timeline {
  const tr = tl.cutTransitions?.find((x) => x.id === id);
  if (!tr || isLocked(tl, tr.trackId)) return tl;
  const next = { ...tr, ...patch };
  if (patch.type && patch.type !== tr.type) {
    const def = getTransition(patch.type);
    next.params = def ? Object.fromEntries(def.params.map((p) => [p.key, p.default])) : {};
  }
  if (patch.params) {
    const def = getTransition(next.type);
    next.params = { ...tr.params, ...(def ? cleanParams(def.params, patch.params) : patch.params) };
  }
  if (patch.duration !== undefined) next.duration = Math.max(0.04, Math.min(10, patch.duration));
  return { ...tl, cutTransitions: tl.cutTransitions!.map((x) => (x.id === id ? next : x)) };
}

export function removeTransition(tl: Timeline, id: string): Timeline {
  const tr = tl.cutTransitions?.find((x) => x.id === id);
  if (!tr || isLocked(tl, tr.trackId)) return tl;
  return { ...tl, cutTransitions: tl.cutTransitions!.filter((x) => x.id !== id) };
}

/**
 * Where a transition dropped at time t on a track goes: the nearest cut between two touching clips, or the nearest
 * clip edge, within `tolerance` seconds. Null when nothing is close.
 */
export function placeAt(tl: Timeline, trackId: string, t: number, tolerance: number): { from?: string; to?: string } | null {
  const clips = clipsOn(tl, trackId);
  let best: { from?: string; to?: string; d: number } | null = null;
  const consider = (time: number, from?: string, to?: string) => {
    const d = Math.abs(time - t);
    if (d <= tolerance && (!best || d < best.d)) best = { from, to, d };
  };
  clips.forEach((c, i) => {
    const next = clips[i + 1];
    const end = c.start + c.duration;
    if (next && Math.abs(next.start - end) < EPS) consider(end, c.id, next.id);
    else consider(end, c.id, undefined);
    const prev = clips[i - 1];
    if (!prev || Math.abs(prev.start + prev.duration - c.start) >= EPS) consider(c.start, undefined, c.id);
  });
  if (!best) return null;
  const { from, to } = best as { from?: string; to?: string };
  return { from, to };
}

/** Transitions whose clips are gone are dropped (after deletes). */
export function pruneTransitions(tl: Timeline): Timeline {
  if (!tl.cutTransitions?.length) return tl;
  const ids = new Set(tl.clips.map((c) => c.id));
  const kept = tl.cutTransitions.filter((x) => (!x.from || ids.has(x.from)) && (!x.to || ids.has(x.to)));
  return kept.length === tl.cutTransitions.length ? tl : { ...tl, cutTransitions: kept };
}
