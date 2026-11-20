import { sourceAtRel, splitRamp, trimRampHead } from "../lib/retime";
import type { Clip, Marker, ProjectDoc, Timeline, Track, TrackKind } from "../model/types";
import { isBeat } from "../model/types";
import { beatsOf } from "../model/convert";

/**
 * The editing engine for multi-track timelines (phases 13 and 14).
 *
 * Every function is pure: it takes a Timeline and returns a new one (or the same object when nothing changes), so
 * each edit becomes one phase 11 operation when the store folds it into the document. Shared rules:
 *
 * - Locked tracks are never changed. An edit that would have to change one does nothing.
 * - Clips with the same `linkId` (a video and its sound) move, trim, slip and delete together.
 * - Fill clips (the lyric project's song and background, `fill: true`) cover the whole timeline and are left alone.
 * - Times are seconds. Edits that take a frame rate round to whole frames.
 */

export type EditCtx = {
  fps: number;
  /** Length of a media file in source seconds, to stop trims and slips at the ends of the source. */
  mediaDuration?: (mediaId: string) => number | undefined;
};

const EPS = 1e-6;
export const clipEnd = (c: Clip) => c.start + c.duration;
const tidy = (n: number) => Math.round(n * 1e6) / 1e6;
export const toFrame = (t: number, fps: number) => Math.round(t * fps) / fps;
const frameLen = (ctx: EditCtx) => 1 / ctx.fps;

let seq = 0;
/** New ids for clips, tracks and markers created by edits. */
export const newId = (p: string) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ---------- lookups ---------- */

export const trackOf = (tl: Timeline, id: string) => tl.tracks.find((t) => t.id === id);
export const isLocked = (tl: Timeline, trackId: string) => !!trackOf(tl, trackId)?.locked;
export const editable = (c: Clip) => !c.fill;
export const clipsOn = (tl: Timeline, trackId: string) => tl.clips.filter((c) => c.trackId === trackId && editable(c)).sort((a, b) => a.start - b.start);
const byId = (tl: Timeline) => new Map(tl.clips.map((c) => [c.id, c]));
const sourceLimit = (c: Clip, ctx: EditCtx) => (c.mediaId ? ctx.mediaDuration?.(c.mediaId) : undefined);

/** The ids plus every clip linked to them. */
export function withLinked(tl: Timeline, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const links = new Set(tl.clips.filter((c) => set.has(c.id) && c.linkId).map((c) => c.linkId!));
  for (const c of tl.clips) if (c.linkId && links.has(c.linkId)) set.add(c.id);
  return [...set];
}

/** Tracks in display order: subtitle at the top, then video (top track first), then audio. */
export function displayOrder(tl: Timeline): Track[] {
  const of = (k: TrackKind) => tl.tracks.filter((t) => t.kind === k);
  return [...of("subtitle").reverse(), ...of("video").reverse(), ...of("audio")];
}

/** End of the last clip, ignoring fill clips. */
export const timelineEnd = (tl: Timeline) => tl.clips.reduce((m, c) => (editable(c) ? Math.max(m, clipEnd(c)) : m), 0);

/* ---------- windowing (only clips in view are drawn) ---------- */

/** Clips of a track that overlap [t0, t1]. Uses a binary search on a start-sorted list, so it stays fast on long timelines. */
export function visibleClips(sorted: Clip[], t0: number, t1: number, maxLen = Infinity): Clip[] {
  // first clip that could still overlap t0: start >= t0 - maxLen
  let lo = 0;
  let hi = sorted.length;
  const from = t0 - maxLen;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].start < from) lo = mid + 1;
    else hi = mid;
  }
  const out: Clip[] = [];
  for (let i = lo; i < sorted.length && sorted[i].start <= t1; i++) if (clipEnd(sorted[i]) >= t0) out.push(sorted[i]);
  return out;
}

/* ---------- tracks ---------- */

export function addTrack(tl: Timeline, kind: TrackKind, name?: string): { tl: Timeline; id: string } {
  const n = tl.tracks.filter((t) => t.kind === kind).length + 1;
  const prefix = kind === "video" ? "V" : kind === "audio" ? "A" : "S";
  const track: Track = { id: newId("t"), kind, name: name ?? `${prefix}${n}`, muted: false, locked: false, solo: false, height: kind === "audio" ? 56 : 44, hidden: false };
  // new video/subtitle tracks go on top (end of their kind), audio tracks at the bottom (end too)
  const lastOfKind = tl.tracks.map((t) => t.kind).lastIndexOf(kind);
  const tracks = [...tl.tracks];
  tracks.splice(lastOfKind + 1 || tracks.length, 0, track);
  return { tl: { ...tl, tracks }, id: track.id };
}

/** Remove a track and its clips. The last subtitle track and locked tracks stay. */
export function removeTrack(tl: Timeline, id: string): Timeline {
  const t = trackOf(tl, id);
  if (!t || t.locked) return tl;
  if (t.kind === "subtitle" && tl.tracks.filter((x) => x.kind === "subtitle").length === 1) return tl;
  return { ...tl, tracks: tl.tracks.filter((x) => x.id !== id), clips: tl.clips.filter((c) => c.trackId !== id) };
}

/** Move a track to `index` among the tracks of its kind (0 = bottom-most). */
export function moveTrack(tl: Timeline, id: string, index: number): Timeline {
  const t = trackOf(tl, id);
  if (!t) return tl;
  const same = tl.tracks.filter((x) => x.kind === t.kind && x.id !== id);
  const i = Math.max(0, Math.min(same.length, index));
  same.splice(i, 0, t);
  let k = 0;
  return { ...tl, tracks: tl.tracks.map((x) => (x.kind === t.kind ? same[k++] : x)) };
}

export function setTrack(tl: Timeline, id: string, patch: Partial<Omit<Track, "id" | "kind">>): Timeline {
  return { ...tl, tracks: tl.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/** Make a track the insert target for its kind (one per kind). */
export function setTarget(tl: Timeline, id: string): Timeline {
  const t = trackOf(tl, id);
  if (!t) return tl;
  return { ...tl, tracks: tl.tracks.map((x) => (x.kind === t.kind ? { ...x, target: x.id === id } : x)) };
}

/** The lyric project's own background and song tracks (see model/convert.ts IDS): never the default target. */
const LYRIC_TRACKS = new Set(["v-bg", "a-song"]);

/**
 * The target track of a kind: the marked one; else a plain unlocked track (not the lyric background or song track),
 * the top-most for video and the first for audio; else any unlocked track of that kind.
 */
export function targetTrack(tl: Timeline, kind: TrackKind): Track | undefined {
  const of = tl.tracks.filter((t) => t.kind === kind);
  const marked = of.find((t) => t.target && !t.locked);
  if (marked) return marked;
  const plain = of.filter((t) => !t.locked && !LYRIC_TRACKS.has(t.id) && !tl.clips.some((c) => c.trackId === t.id && c.fill));
  return (kind === "video" ? plain[plain.length - 1] : plain[0]) ?? of.find((t) => !t.locked);
}

/* ---------- snapping ---------- */

/** What edges snap to. `markers` = user markers (on unless false); `beats` = beat markers (off unless true). */
export type SnapSource = { playhead?: number; markers?: boolean; beats?: boolean; edges?: boolean; grid?: number };

/** Index of the first item with `time >= t` in a list sorted by time (binary search). */
export function lowerBound(list: { time: number }[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Items of a time-sorted list inside [t0, t1] (binary search; for drawing only what is in view). */
export function inWindow<T extends { time: number }>(list: T[], t0: number, t1: number): T[] {
  return list.slice(lowerBound(list, t0), lowerBound(list, t1 + EPS));
}

/**
 * The nearest beat to t within `tolerance` seconds, else t unchanged. `beats` must be sorted by time.
 * On a tie between a beat and a downbeat the downbeat wins.
 */
export function snapToBeat(beats: { time: number; downbeat?: boolean }[], t: number, tolerance: number): number {
  if (!beats.length) return t;
  const i = lowerBound(beats, t);
  let best: { time: number; downbeat?: boolean } | undefined;
  for (const b of [beats[i - 1], beats[i]]) {
    if (!b || Math.abs(b.time - t) > tolerance + EPS) continue;
    const d = Math.abs(b.time - t);
    const bd = best ? Math.abs(best.time - t) : Infinity;
    if (d < bd - EPS || (Math.abs(d - bd) <= EPS && b.downbeat && !best?.downbeat)) best = b;
  }
  return best ? best.time : t;
}

/** Times that edges snap to. `exclude` = clips being dragged (they do not snap to themselves). */
export function snapPoints(tl: Timeline, src: SnapSource, exclude: Iterable<string> = [], range?: [number, number]): number[] {
  const ex = new Set(exclude);
  const pts: number[] = [0];
  if (src.playhead !== undefined) pts.push(src.playhead);
  if (src.edges !== false) for (const c of tl.clips) if (editable(c) && !ex.has(c.id)) pts.push(c.start, clipEnd(c));
  if (src.markers !== false) for (const m of tl.markers) if (!m.clipId && !isBeat(m)) pts.push(m.time);
  if (src.beats) {
    const all = beatsOf(tl);
    const near = range ? inWindow(all, range[0] - 1, range[1] + 1) : all;
    // downbeats first: snapTime and snapDelta keep the first of equally near points
    for (const b of near) if (b.downbeat) pts.push(b.time);
    for (const b of near) if (!b.downbeat) pts.push(b.time);
  }
  if (tl.inPoint !== undefined) pts.push(tl.inPoint);
  if (tl.outPoint !== undefined) pts.push(tl.outPoint);
  if (src.grid && range) for (let t = Math.ceil(range[0] / src.grid) * src.grid; t <= range[1]; t += src.grid) pts.push(t);
  return pts;
}

/**
 * Beat ticks worth drawing at a zoom level: every beat when they are at least `minPx` apart, else every downbeat,
 * else every n-th downbeat, so ticks never crowd. `beats` sorted by time.
 */
export function thinBeats<T extends { time: number; downbeat: boolean }>(beats: T[], pps: number, minPx = 4): T[] {
  if (beats.length < 2) return beats;
  const span = beats[beats.length - 1].time - beats[0].time;
  const gap = span / (beats.length - 1); // typical beat spacing
  if (gap * pps >= minPx) return beats;
  const downs = beats.filter((b) => b.downbeat);
  if (downs.length < 2) {
    const every = Math.ceil(minPx / Math.max(gap * pps, 1e-9));
    return beats.filter((_, i) => i % every === 0);
  }
  const barGap = (downs[downs.length - 1].time - downs[0].time) / (downs.length - 1);
  const every = Math.max(1, Math.ceil(minPx / Math.max(barGap * pps, 1e-9)));
  return every === 1 ? downs : downs.filter((_, i) => i % every === 0);
}

/** Snap a single time. Returns the snapped time and the point it snapped to (for drawing a guide). */
export function snapTime(t: number, points: number[], threshold: number): { t: number; at?: number } {
  let best: number | undefined;
  for (const p of points) if (Math.abs(p - t) <= threshold && (best === undefined || Math.abs(p - t) < Math.abs(best - t))) best = p;
  return best === undefined ? { t } : { t: best, at: best };
}

/** Adjust a move so the nearest of `edges` (moved by dt) lands on a snap point. */
export function snapDelta(edges: number[], dt: number, points: number[], threshold: number): { dt: number; at?: number } {
  let best: { d: number; at: number } | undefined;
  for (const e of edges) {
    for (const p of points) {
      const d = p - (e + dt);
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: p };
    }
  }
  return best ? { dt: dt + best.d, at: best.at } : { dt };
}

/* ---------- selection ---------- */

/** Clips touching the time range on the given tracks (marquee selection). Locked tracks are skipped. */
export function clipsInRange(tl: Timeline, t0: number, t1: number, trackIds: string[]): string[] {
  const [a, b] = t0 <= t1 ? [t0, t1] : [t1, t0];
  const tracks = new Set(trackIds.filter((id) => !isLocked(tl, id)));
  return tl.clips.filter((c) => editable(c) && tracks.has(c.trackId) && c.start < b && clipEnd(c) > a).map((c) => c.id);
}

/* ---------- the core primitive: make room on a track ---------- */

function splitAt(c: Clip, t: number): [Clip, Clip] {
  const rel = t - c.start;
  const at = sourceAtRel(c, rel); // the source time at the cut, whatever the retiming
  const [lr, rr] = c.ramp?.keys.length ? splitRamp(c.ramp, rel) : [undefined, undefined];
  const ramp = (r?: typeof c.ramp) => (r ? { ramp: r } : {});
  // a reversed clip plays from its out point back: the left part keeps the later source, the right part the earlier
  const left: Clip = c.reverse
    ? { ...c, duration: tidy(rel), sourceIn: tidy(at), ...ramp(lr) }
    : { ...c, duration: tidy(rel), sourceOut: tidy(at), ...ramp(lr) };
  const right: Clip = c.reverse
    ? { ...c, id: newId("c"), start: tidy(t), duration: tidy(clipEnd(c) - t), sourceOut: tidy(at), ...ramp(rr) }
    : { ...c, id: newId("c"), start: tidy(t), duration: tidy(clipEnd(c) - t), sourceIn: tidy(at), ...ramp(rr) };
  return [left, right];
}

/**
 * Clear [a, b) on a track: clips inside are removed, clips across an edge are trimmed, a clip across the whole
 * range is split around it. Clips in `except` are left alone. Used by overwrite, move and lift.
 */
export function clearRange(tl: Timeline, trackId: string, a: number, b: number, except: Set<string> = new Set()): Timeline {
  if (b - a <= EPS || isLocked(tl, trackId)) return tl;
  const out: Clip[] = [];
  let changed = false;
  for (const c of tl.clips) {
    if (c.trackId !== trackId || !editable(c) || except.has(c.id) || clipEnd(c) <= a + EPS || c.start >= b - EPS) {
      out.push(c);
      continue;
    }
    changed = true;
    if (c.start >= a - EPS && clipEnd(c) <= b + EPS) continue; // fully inside: removed
    if (c.start < a && clipEnd(c) > b) {
      const [left, rest] = splitAt(c, a);
      const [, right] = splitAt(rest, b);
      out.push(left, { ...right, linkId: undefined }); // the partner was not cut, so only the left piece stays linked
    } else if (c.start < a) out.push(splitAt(c, a)[0]);
    else out.push({ ...splitAt(c, b)[1], id: c.id });
  }
  return changed ? { ...tl, clips: out } : tl;
}

/* ---------- move, copy, delete (phase 13) ---------- */

/**
 * Move clips by dt seconds and, for clips of `shiftKind`, by `trackShift` tracks of that kind (+ = up the display).
 * Linked clips come along. Moved clips overwrite what they land on. Nothing happens if any clip involved (or a
 * destination track) is locked, or a destination track does not exist.
 */
export function moveClips(tl: Timeline, ids: string[], dt: number, trackShift = 0, shiftKind?: TrackKind): Timeline {
  const group = withLinked(tl, ids)
    .map((id) => byId(tl).get(id)!)
    .filter((c) => c && editable(c));
  if (!group.length || group.some((c) => isLocked(tl, c.trackId))) return tl;
  const minStart = Math.min(...group.map((c) => c.start));
  const d = Math.max(dt, -minStart); // never before 0
  const dest = new Map<string, string>();
  for (const c of group) {
    const t = trackOf(tl, c.trackId)!;
    if (!trackShift || (shiftKind && t.kind !== shiftKind)) {
      dest.set(c.id, c.trackId);
      continue;
    }
    const same = tl.tracks.filter((x) => x.kind === t.kind);
    // display order for video/subtitle is reversed (top track = last); audio goes downward
    const dir = t.kind === "audio" ? -1 : 1;
    const target = same[same.findIndex((x) => x.id === t.id) + dir * trackShift];
    if (!target || target.locked) return tl;
    dest.set(c.id, target.id);
  }
  if (Math.abs(d) < EPS && group.every((c) => dest.get(c.id) === c.trackId)) return tl;
  const moving = new Set(group.map((c) => c.id));
  let next: Timeline = { ...tl, clips: tl.clips.filter((c) => !moving.has(c.id)) };
  for (const c of group) {
    const start = tidy(c.start + d);
    next = clearRange(next, dest.get(c.id)!, start, start + c.duration);
  }
  return { ...next, clips: [...next.clips, ...group.map((c) => ({ ...c, start: tidy(c.start + d), trackId: dest.get(c.id)! }))] };
}

/** Copies of clips (and their linked clips) placed so the earliest starts at `at`; they overwrite what is there. */
export function duplicateClips(tl: Timeline, ids: string[], at: number): { tl: Timeline; ids: string[] } {
  const group = withLinked(tl, ids)
    .map((id) => byId(tl).get(id)!)
    .filter((c) => c && editable(c) && !isLocked(tl, c.trackId));
  if (!group.length) return { tl, ids: [] };
  const minStart = Math.min(...group.map((c) => c.start));
  const links = new Map<string, string>();
  const copies = group.map((c) => {
    const linkId = c.linkId ? (links.get(c.linkId) ?? links.set(c.linkId, newId("l")).get(c.linkId)) : undefined;
    return { ...c, id: newId("c"), linkId, start: tidy(at + (c.start - minStart)) };
  });
  let next = tl;
  for (const c of copies) next = clearRange(next, c.trackId, c.start, clipEnd(c));
  return { tl: { ...next, clips: [...next.clips, ...copies] }, ids: copies.map((c) => c.id) };
}

/** Remove clips and leave the gaps (lift). Locked clips stay. */
export function deleteClips(tl: Timeline, ids: string[]): Timeline {
  const kill = new Set(withLinked(tl, ids).filter((id) => {
    const c = byId(tl).get(id);
    return c && editable(c) && !isLocked(tl, c.trackId);
  }));
  return kill.size ? { ...tl, clips: tl.clips.filter((c) => !kill.has(c.id)) } : tl;
}

/** Remove clips and close the gaps they leave on their tracks. */
export function rippleDelete(tl: Timeline, ids: string[]): Timeline {
  const map = byId(tl);
  const kill = withLinked(tl, ids)
    .map((id) => map.get(id)!)
    .filter((c) => c && editable(c) && !isLocked(tl, c.trackId));
  if (!kill.length) return tl;
  const gone = new Set(kill.map((c) => c.id));
  const byTrack = new Map<string, Clip[]>();
  for (const c of kill) byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c]);
  return {
    ...tl,
    clips: tl.clips
      .filter((c) => !gone.has(c.id))
      .map((c) => {
        const removed = byTrack.get(c.trackId);
        if (!removed || !editable(c)) return c;
        const shift = removed.filter((r) => clipEnd(r) <= c.start + EPS).reduce((s, r) => s + r.duration, 0);
        return shift ? { ...c, start: tidy(c.start - shift) } : c;
      }),
  };
}

/* ---------- blade (phase 14) ---------- */

/**
 * Cut clips at time t. With `ids`, only those clips (and their linked clips); otherwise every clip under t on
 * unlocked tracks. Text clips are cut with the lyric "Split at playhead" instead, which divides the words.
 */
export function blade(tl: Timeline, t: number, ids?: string[]): Timeline {
  const only = ids ? new Set(withLinked(tl, ids)) : null;
  const newLinks = new Map<string, string>();
  const out: Clip[] = [];
  let changed = false;
  for (const c of tl.clips) {
    const cut = editable(c) && !c.text && !isLocked(tl, c.trackId) && (!only || only.has(c.id)) && t > c.start + EPS && t < clipEnd(c) - EPS;
    if (!cut) {
      out.push(c);
      continue;
    }
    changed = true;
    const [left, right] = splitAt(c, t);
    if (c.linkId) {
      if (!newLinks.has(c.linkId)) newLinks.set(c.linkId, newId("l"));
      right.linkId = newLinks.get(c.linkId);
    }
    out.push(left, right);
  }
  return changed ? { ...tl, clips: out } : tl;
}

/* ---------- trimming (phase 14) ---------- */

export type Edge = "start" | "end";

/** How far an edge of one clip may move: [min dt, max dt]. */
function edgeRange(tl: Timeline, c: Clip, edge: Edge, ripple: boolean, ctx: EditCtx): [number, number] {
  const f = frameLen(ctx);
  const lim = sourceLimit(c, ctx);
  const track = clipsOn(tl, c.trackId);
  const i = track.findIndex((x) => x.id === c.id);
  // how fast the source passes on average (a ramp has no single speed), and which end of the source an edge eats into
  const sp = c.ramp?.keys.length && c.duration > 0 ? Math.max(1e-3, (c.sourceOut - c.sourceIn) / c.duration) : c.speed;
  const rev = !!c.reverse;
  if (edge === "end") {
    let max = rev ? c.sourceIn / sp : lim === undefined ? Infinity : (lim - c.sourceOut) / sp;
    if (!ripple && track[i + 1]) max = Math.min(max, track[i + 1].start - clipEnd(c));
    return [f - c.duration, max];
  }
  // start edge
  let min = rev ? (lim === undefined ? -Infinity : -(lim - c.sourceOut) / sp) : -c.sourceIn / sp;
  if (!ripple) min = Math.max(min, track[i - 1] ? clipEnd(track[i - 1]) - c.start : -c.start);
  return [min, c.duration - f];
}

/** A clip with its end moved by d (positive: longer), source range following the retiming. */
function trimmedEnd(c: Clip, d: number): Clip {
  const duration = tidy(c.duration + d);
  const next = { ...c, duration };
  const far = sourceAtRel(next, duration); // where the source ends now
  return c.reverse ? { ...next, sourceIn: tidy(far) } : { ...next, sourceOut: tidy(far) };
}

/** A clip with its head moved by d (positive: shorter); `move` also moves its start (a normal trim, not a ripple). */
function trimmedHead(c: Clip, d: number, move: boolean): Clip {
  const at = sourceAtRel(c, d);
  const ramp = c.ramp?.keys.length ? { ramp: d >= 0 ? trimRampHead(c.ramp, d) : c.ramp } : {};
  const base = { ...c, duration: tidy(c.duration - d), ...(move ? { start: tidy(c.start + d) } : {}), ...ramp };
  return c.reverse ? { ...base, sourceOut: tidy(at) } : { ...base, sourceIn: tidy(at) };
}

/**
 * Trim an edge by dt. Normal trim stops at neighbours and at the ends of the source. Ripple trim moves the later
 * clips on the same track(s) to follow, so no gap opens or closes (the clip keeps its start when trimming its head).
 */
export function trimEdge(tl: Timeline, id: string, edge: Edge, dt: number, ripple: boolean, ctx: EditCtx): Timeline {
  const map = byId(tl);
  const group = withLinked(tl, [id]).map((x) => map.get(x)!).filter((c) => c && editable(c));
  if (!group.length || group.some((c) => isLocked(tl, c.trackId))) return tl;
  let lo = -Infinity;
  let hi = Infinity;
  for (const c of group) {
    const [a, b] = edgeRange(tl, c, edge, ripple, ctx);
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
  }
  const d = tidy(Math.min(hi, Math.max(lo, dt)));
  if (Math.abs(d) < EPS || lo > hi) return tl;

  const touched = new Set(group.map((c) => c.id));
  const tracks = new Set(group.map((c) => c.trackId));
  // ripple: how far clips after the edited one move (end edge: +d; head ripple keeps start, shortens by d)
  const shift = edge === "end" ? d : -d;
  return {
    ...tl,
    clips: tl.clips.map((c) => {
      if (touched.has(c.id)) {
        if (edge === "end") return trimmedEnd(c, d);
        if (ripple) return trimmedHead(c, d, false);
        return trimmedHead(c, d, true);
      }
      if (ripple && tracks.has(c.trackId) && editable(c)) {
        const ref = group.find((g) => g.trackId === c.trackId)!;
        if (c.start >= clipEnd(ref) - EPS) return { ...c, start: tidy(c.start + shift) };
      }
      return c;
    }),
  };
}

/** Roll the cut between two touching clips on a track: one gets longer, the other shorter, total length unchanged. */
export function roll(tl: Timeline, leftId: string, rightId: string, dt: number, ctx: EditCtx): Timeline {
  const map = byId(tl);
  const L = map.get(leftId);
  const R = map.get(rightId);
  if (!L || !R || L.trackId !== R.trackId || isLocked(tl, L.trackId) || Math.abs(clipEnd(L) - R.start) > EPS) return tl;
  const f = frameLen(ctx);
  const limL = sourceLimit(L, ctx);
  const max = Math.min(R.duration - f, limL === undefined ? Infinity : (limL - L.sourceOut) / L.speed);
  const min = Math.max(f - L.duration, -R.sourceIn / R.speed);
  const d = tidy(Math.min(max, Math.max(min, dt)));
  if (Math.abs(d) < EPS || min > max) return tl;
  return {
    ...tl,
    clips: tl.clips.map((c) =>
      c.id === L.id
        ? { ...c, duration: tidy(c.duration + d), sourceOut: tidy(c.sourceOut + d * c.speed) }
        : c.id === R.id
          ? { ...c, start: tidy(c.start + d), duration: tidy(c.duration - d), sourceIn: tidy(c.sourceIn + d * c.speed) }
          : c
    ),
  };
}

/** Slip: show a different part of the source; the clip keeps its place and length. Linked clips slip too. */
export function slip(tl: Timeline, id: string, dt: number, ctx: EditCtx): Timeline {
  const map = byId(tl);
  const group = withLinked(tl, [id]).map((x) => map.get(x)!).filter((c) => c && editable(c) && (c.mediaId || c.generator));
  if (!group.length || group.some((c) => isLocked(tl, c.trackId))) return tl;
  let lo = -Infinity;
  let hi = Infinity;
  for (const c of group) {
    lo = Math.max(lo, -c.sourceIn / c.speed);
    const lim = sourceLimit(c, ctx);
    if (lim !== undefined) hi = Math.min(hi, (lim - c.sourceOut) / c.speed);
  }
  const d = tidy(Math.min(hi, Math.max(lo, dt)));
  if (Math.abs(d) < EPS || lo > hi) return tl;
  const ids = new Set(group.map((c) => c.id));
  return { ...tl, clips: tl.clips.map((c) => (ids.has(c.id) ? { ...c, sourceIn: tidy(c.sourceIn + d * c.speed), sourceOut: tidy(c.sourceOut + d * c.speed) } : c)) };
}

/**
 * Slide: move a clip along its track keeping its length and content; touching neighbours absorb the change (the one
 * before gets longer or shorter at its end, the one after at its start). With a gap on a side the clip moves within it.
 */
export function slide(tl: Timeline, id: string, dt: number, ctx: EditCtx): Timeline {
  const c = byId(tl).get(id);
  if (!c || !editable(c) || isLocked(tl, c.trackId)) return tl;
  const f = frameLen(ctx);
  const track = clipsOn(tl, c.trackId);
  const i = track.findIndex((x) => x.id === id);
  const prev = track[i - 1];
  const next = track[i + 1];
  const prevTouch = prev && Math.abs(clipEnd(prev) - c.start) < EPS;
  const nextTouch = next && Math.abs(next.start - clipEnd(c)) < EPS;
  let lo = prev ? (prevTouch ? f - prev.duration : clipEnd(prev) - c.start) : -c.start;
  let hi = next ? (nextTouch ? next.duration - f : next.start - clipEnd(c)) : Infinity;
  if (prevTouch) {
    const lim = sourceLimit(prev, ctx);
    if (lim !== undefined) hi = Math.min(hi, (lim - prev.sourceOut) / prev.speed);
  }
  if (nextTouch) lo = Math.max(lo, -next.sourceIn / next.speed);
  const d = tidy(Math.min(hi, Math.max(lo, dt)));
  if (Math.abs(d) < EPS || lo > hi) return tl;
  return {
    ...tl,
    clips: tl.clips.map((x) => {
      if (x.id === id) return { ...x, start: tidy(x.start + d) };
      if (prevTouch && x.id === prev.id) return { ...x, duration: tidy(x.duration + d), sourceOut: tidy(x.sourceOut + d * x.speed) };
      if (nextTouch && x.id === next.id) return { ...x, start: tidy(x.start + d), duration: tidy(x.duration - d), sourceIn: tidy(x.sourceIn + d * x.speed) };
      return x;
    }),
  };
}

/* ---------- the smart pointer ---------- */

export type Tool = "select" | "trim" | "blade" | "hand" | "zoom";
export type PointerMode = "move" | "trim-start" | "trim-end" | "ripple-start" | "ripple-end" | "roll" | "slip" | "slide" | "blade" | "hand" | "zoom";

/**
 * What a press on a clip does, from where the pointer is. `x` = pixels from the clip's left edge, `y` = 0..1 from
 * its top. Selection tool: edges trim, the body moves. Trim tool: right at a cut between two touching clips rolls,
 * near an edge ripples, the top (name) band slides, the rest slips.
 */
export function pointerMode(tl: Timeline, clipId: string, x: number, y: number, pps: number, tool: Tool): PointerMode {
  if (tool === "blade" || tool === "hand" || tool === "zoom") return tool;
  const c = byId(tl).get(clipId);
  if (!c) return "move";
  const w = c.duration * pps;
  const edge = Math.min(8, w / 4);
  const nearStart = x <= edge;
  const nearEnd = x >= w - edge;
  if (tool === "select") return nearStart ? "trim-start" : nearEnd ? "trim-end" : "move";
  const track = clipsOn(tl, c.trackId);
  const i = track.findIndex((t) => t.id === clipId);
  const cut = Math.min(3, w / 6);
  if (x <= cut && track[i - 1] && Math.abs(clipEnd(track[i - 1]) - c.start) < EPS) return "roll";
  if (x >= w - cut && track[i + 1] && Math.abs(track[i + 1].start - clipEnd(c)) < EPS) return "roll";
  if (nearStart) return "ripple-start";
  if (nearEnd) return "ripple-end";
  return y < 0.3 ? "slide" : "slip";
}

/* ---------- placing media (phase 14) ---------- */

/** What is being edited in: a pool item and the part of it to use. */
export type Source = {
  mediaId: string;
  name: string;
  kind: "video" | "audio" | "image";
  /** Source seconds. */
  in: number;
  out: number;
  /** A video file whose sound should come along on the audio target. */
  withAudio?: boolean;
};

export type Targets = { video?: string; audio?: string };

/** The clip(s) a source makes at `at` (video + linked audio when the source has sound). */
function sourceClips(src: Source, at: number, targets: Targets, speed = 1): Clip[] {
  const len = tidy((src.out - src.in) / speed);
  const base = { start: tidy(at), duration: len, sourceIn: src.in, sourceOut: src.out, speed, enabled: true, effects: [], keyframes: {}, mediaId: src.mediaId, name: src.name };
  const out: Clip[] = [];
  const pic = src.kind === "audio" ? undefined : targets.video;
  const snd = src.kind === "audio" ? targets.audio : src.withAudio ? targets.audio : undefined;
  const linkId = pic && snd ? newId("l") : undefined;
  if (pic) out.push({ ...base, id: newId("c"), trackId: pic, linkId });
  if (snd) out.push({ ...base, id: newId("c"), trackId: snd, linkId });
  return out;
}

const usable = (tl: Timeline, targets: Targets): Targets => ({
  video: targets.video && !isLocked(tl, targets.video) ? targets.video : undefined,
  audio: targets.audio && !isLocked(tl, targets.audio) ? targets.audio : undefined,
});

/** Overwrite: the source replaces whatever is on the target tracks over its length. */
export function overwriteEdit(tl: Timeline, src: Source, at: number, targets: Targets, speed = 1): { tl: Timeline; ids: string[] } {
  const clips = sourceClips(src, at, usable(tl, targets), speed);
  if (!clips.length) return { tl, ids: [] };
  let next = tl;
  for (const c of clips) next = clearRange(next, c.trackId, c.start, clipEnd(c));
  return { tl: { ...next, clips: [...next.clips, ...clips] }, ids: clips.map((c) => c.id) };
}

/**
 * Insert: everything at or after `at` on every unlocked track moves later by the source length (clips across `at`
 * are cut), then the source goes in the gap. Locked tracks do not move.
 */
export function insertEdit(tl: Timeline, src: Source, at: number, targets: Targets): { tl: Timeline; ids: string[] } {
  const clips = sourceClips(src, at, usable(tl, targets));
  if (!clips.length) return { tl, ids: [] };
  const len = clips[0].duration;
  let next = blade(tl, at);
  next = {
    ...next,
    clips: next.clips.map((c) => (editable(c) && !isLocked(next, c.trackId) && c.start >= at - EPS ? { ...c, start: tidy(c.start + len) } : c)),
  };
  return { tl: { ...next, clips: [...next.clips, ...clips] }, ids: clips.map((c) => c.id) };
}

/** Replace: the clip keeps its place and length but shows the new source from its in point. */
export function replaceEdit(tl: Timeline, clipId: string, src: Source, ctx: EditCtx): Timeline {
  const c = byId(tl).get(clipId);
  if (!c || !editable(c) || isLocked(tl, c.trackId)) return tl;
  const lim = ctx.mediaDuration?.(src.mediaId);
  let duration = c.duration;
  if (lim !== undefined) duration = Math.min(duration, (lim - src.in) / c.speed);
  if (duration <= EPS) return tl;
  return {
    ...tl,
    clips: tl.clips.map((x) => (x.id === clipId ? { ...x, mediaId: src.mediaId, name: src.name, generator: undefined, duration: tidy(duration), sourceIn: src.in, sourceOut: tidy(src.in + duration * c.speed) } : x)),
  };
}

/** Place on top: on the first unlocked track of the kind (from the target up) that is free there, or a new track. */
export function placeOnTop(tl: Timeline, src: Source, at: number, targets: Targets): { tl: Timeline; ids: string[] } {
  const kind: TrackKind = src.kind === "audio" ? "audio" : "video";
  const len = src.out - src.in;
  const of = tl.tracks.filter((t) => t.kind === kind);
  const from = Math.max(0, of.findIndex((t) => t.id === (kind === "video" ? targets.video : targets.audio)));
  const free = of.slice(from).find((t) => !t.locked && !tl.clips.some((c) => c.trackId === t.id && editable(c) && c.start < at + len - EPS && clipEnd(c) > at + EPS));
  let next = tl;
  let trackId = free?.id;
  if (!trackId) {
    const r = addTrack(tl, kind);
    next = r.tl;
    trackId = r.id;
  }
  return overwriteEdit(next, { ...src, withAudio: false }, at, kind === "video" ? { video: trackId } : { audio: trackId });
}

/** Fit to fill: the source range is sped up or slowed down to fill [tlIn, tlOut]. */
export function fitToFill(tl: Timeline, src: Source, tlIn: number, tlOut: number, targets: Targets): { tl: Timeline; ids: string[] } {
  if (tlOut - tlIn <= EPS) return { tl, ids: [] };
  return overwriteEdit(tl, src, tlIn, targets, (src.out - src.in) / (tlOut - tlIn));
}

/** Append: after the last clip of the target track(s). */
export function appendEdit(tl: Timeline, src: Source, targets: Targets): { tl: Timeline; ids: string[] } {
  const ends = [targets.video, targets.audio].filter(Boolean).map((id) => Math.max(0, ...clipsOn(tl, id!).map(clipEnd)));
  return overwriteEdit(tl, src, Math.max(0, ...ends), targets);
}

/** Marks for three- and four-point edits. Missing ones are worked out from the others. */
export type Marks = { srcIn?: number; srcOut?: number; tlIn?: number; tlOut?: number };

/**
 * Resolve three- or four-point marks into a source range and a timeline position. With no timeline in point the
 * playhead is used; with no source marks the whole source. Four points with different lengths ask for fit to fill.
 */
export function resolveMarks(m: Marks, srcDuration: number, playhead: number): { in: number; out: number; at: number; fitTo?: number } {
  const tlIn = m.tlIn ?? (m.tlOut === undefined ? playhead : undefined);
  const tlLen = tlIn !== undefined && m.tlOut !== undefined ? m.tlOut - tlIn : undefined;
  let sIn = m.srcIn;
  let sOut = m.srcOut;
  if (sIn === undefined && sOut === undefined) {
    sIn = 0;
    sOut = tlLen !== undefined ? Math.min(srcDuration, tlLen) : srcDuration;
  } else if (sIn === undefined) sIn = Math.max(0, sOut! - (tlLen ?? sOut!));
  else if (sOut === undefined) sOut = Math.min(srcDuration, sIn + (tlLen ?? srcDuration - sIn));
  const len = sOut! - sIn;
  if (tlIn === undefined) return { in: sIn, out: sOut!, at: m.tlOut! - len }; // backtimed from the timeline out point
  const fourPoint = m.srcIn !== undefined && m.srcOut !== undefined && tlLen !== undefined && Math.abs(tlLen - len) > EPS;
  return { in: sIn, out: sOut!, at: tlIn, fitTo: fourPoint ? m.tlOut : undefined };
}

/* ---------- ranges, joins, markers (phase 14) ---------- */

/** Lift: clear [a, b) on the given tracks (default: all unlocked), leaving a gap. */
export function liftRange(tl: Timeline, a: number, b: number, trackIds?: string[]): Timeline {
  let next = tl;
  for (const t of tl.tracks) if (!t.locked && (!trackIds || trackIds.includes(t.id))) next = clearRange(next, t.id, a, b);
  return next;
}

/** Extract: lift [a, b) and close the gap on those tracks. */
export function extractRange(tl: Timeline, a: number, b: number, trackIds?: string[]): Timeline {
  const lifted = liftRange(tl, a, b, trackIds);
  const len = b - a;
  const tracks = new Set(tl.tracks.filter((t) => !t.locked && (!trackIds || trackIds.includes(t.id))).map((t) => t.id));
  return { ...lifted, clips: lifted.clips.map((c) => (editable(c) && tracks.has(c.trackId) && c.start >= b - EPS ? { ...c, start: tidy(c.start - len) } : c)) };
}

/** Join through edit: two touching pieces of the same source that continue each other become one clip again. */
export function joinThroughEdit(tl: Timeline, leftId: string, rightId: string): Timeline {
  const map = byId(tl);
  const L = map.get(leftId);
  const R = map.get(rightId);
  const ok =
    L && R && L.trackId === R.trackId && !isLocked(tl, L.trackId) && L.mediaId && L.mediaId === R.mediaId && L.speed === R.speed &&
    Math.abs(clipEnd(L) - R.start) < EPS && Math.abs(L.sourceOut - R.sourceIn) < EPS;
  if (!ok) return tl;
  return { ...tl, clips: tl.clips.filter((c) => c.id !== R!.id).map((c) => (c.id === L!.id ? { ...c, duration: tidy(c.duration + R!.duration), sourceOut: R!.sourceOut } : c)) };
}

export function addMarker(tl: Timeline, time: number, m: Partial<Omit<Marker, "id" | "time">> = {}): { tl: Timeline; id: string } {
  const marker: Marker = { id: newId("mk"), time: tidy(Math.max(0, time)), name: m.name ?? "", color: m.color ?? "#5b9dff", ...(m.note ? { note: m.note } : {}), ...(m.clipId ? { clipId: m.clipId } : {}) };
  return { tl: { ...tl, markers: [...tl.markers, marker].sort((a, b) => a.time - b.time) }, id: marker.id };
}
export const updateMarker = (tl: Timeline, id: string, patch: Partial<Omit<Marker, "id">>): Timeline => ({ ...tl, markers: tl.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
export const removeMarker = (tl: Timeline, id: string): Timeline => ({ ...tl, markers: tl.markers.filter((m) => m.id !== id) });

/** Ruler markers placed by the user (not on a clip, not beats), sorted by time. */
export const userMarkers = (tl: Timeline): Marker[] => tl.markers.filter((m) => !m.clipId && !isBeat(m)).sort((a, b) => a.time - b.time);

/** The next (dir 1) or previous (dir -1) user marker on the ruler from t (beats are skipped). */
export function nearMarker(tl: Timeline, t: number, dir: 1 | -1): Marker | undefined {
  const ruler = userMarkers(tl);
  return dir > 0 ? ruler.find((m) => m.time > t + EPS) : [...ruler].reverse().find((m) => m.time < t - EPS);
}

/** Set or clear the timeline in and out points (null clears). Keeps in before out. */
export function setRange(tl: Timeline, inPoint?: number | null, outPoint?: number | null): Timeline {
  const next = { ...tl };
  if (inPoint !== undefined) inPoint === null ? delete next.inPoint : (next.inPoint = tidy(Math.max(0, inPoint)));
  if (outPoint !== undefined) outPoint === null ? delete next.outPoint : (next.outPoint = tidy(Math.max(0, outPoint)));
  if (next.inPoint !== undefined && next.outPoint !== undefined && next.outPoint < next.inPoint) [next.inPoint, next.outPoint] = [next.outPoint, next.inPoint];
  return next;
}

/* ---------- documents ---------- */

/** Apply a timeline edit to the active timeline of a document. */
export function onActive(doc: ProjectDoc, fn: (tl: Timeline) => Timeline): ProjectDoc {
  const i = doc.timelines.findIndex((t) => t.id === doc.activeTimelineId);
  const idx = i < 0 ? 0 : i;
  const next = fn(doc.timelines[idx]);
  if (next === doc.timelines[idx]) return doc;
  const timelines = [...doc.timelines];
  timelines[idx] = next;
  return { ...doc, timelines };
}
