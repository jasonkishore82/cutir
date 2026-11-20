import { activeTimeline } from "../model/convert";
import type { Aspect } from "../store/project";
import type { Clip, ProjectDoc, Subclip, Timeline, Track } from "../model/types";
import { sourceAtRel } from "../lib/retime";
import { segments, soundSegments } from "../lib/multicam";
import { trackerAt } from "../lib/track/tracker";
import * as E from "./engine";

/**
 * Compound clips, nested timelines, versions of an edit, subclips and the multicam conversions (phases 23 and 24).
 * Pure functions on the document: each returns the new document (or null when the edit is not possible).
 */

const tidy = (n: number) => Math.round(n * 1e6) / 1e6;
const withTimeline = (doc: ProjectDoc, tl: Timeline): ProjectDoc => ({ ...doc, timelines: doc.timelines.map((t) => (t.id === tl.id ? tl : t)) });

/** Whether `from` shows `target` somewhere inside it (directly or through other nested timelines). */
export function usesTimeline(doc: ProjectDoc, from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const tl = doc.timelines.find((t) => t.id === from);
  return !!tl?.clips.some((c) => c.timelineId && usesTimeline(doc, c.timelineId, target, seen));
}

/** Timelines that can be placed on `hostId` without a loop (not the host, and not one that shows the host). */
export const placeable = (doc: ProjectDoc, hostId: string): Timeline[] => doc.timelines.filter((t) => t.id !== hostId && !usesTimeline(doc, t.id, hostId));

/* ---------- compound clips ---------- */

/** Turn clips into a compound clip: they move into a new timeline and one clip showing it takes their place. */
export function makeCompound(doc: ProjectDoc, ids: string[], name = "Compound clip"): { doc: ProjectDoc; timelineId: string; clipId: string } | null {
  const tl = activeTimeline(doc);
  const sel = tl.clips.filter((c) => ids.includes(c.id) && !c.fill && !E.isLocked(tl, c.trackId));
  if (!sel.length) return null;
  const start = Math.min(...sel.map((c) => c.start));
  const end = Math.max(...sel.map((c) => E.clipEnd(c)));
  const used = tl.tracks.filter((t) => sel.some((c) => c.trackId === t.id));
  const trackMap = new Map<string, string>();
  const tracks: Track[] = used.map((t) => {
    const id = E.newId("t");
    trackMap.set(t.id, id);
    return { ...t, id, target: undefined };
  });
  const inside = new Set(sel.map((c) => c.id));
  const nestedId = E.newId("tl");
  const nested: Timeline = {
    id: nestedId,
    name,
    tracks,
    clips: sel.map((c) => ({ ...c, trackId: trackMap.get(c.trackId)!, start: tidy(c.start - start) })),
    markers: [],
    textStyle: tl.textStyle,
    transition: tl.transition,
    cutTransitions: (tl.cutTransitions ?? []).filter((x) => (!x.from || inside.has(x.from)) && (!x.to || inside.has(x.to)) && trackMap.has(x.trackId)).map((x) => ({ ...x, trackId: trackMap.get(x.trackId)! })),
  };
  // the compound clip sits on the lowest video track the selection used (or the first video track)
  const host = used.find((t) => t.kind === "video") ?? tl.tracks.find((t) => t.kind === "video");
  if (!host) return null;
  const clip: Clip = { id: E.newId("c"), trackId: host.id, name, start: tidy(start), duration: tidy(end - start), sourceIn: 0, sourceOut: tidy(end - start), speed: 1, enabled: true, effects: [], keyframes: {}, timelineId: nestedId };
  let parent: Timeline = {
    ...tl,
    clips: tl.clips.filter((c) => !inside.has(c.id)),
    cutTransitions: (tl.cutTransitions ?? []).filter((x) => !((!x.from || inside.has(x.from)) && (!x.to || inside.has(x.to)))),
  };
  parent = E.clearRange(parent, host.id, clip.start, E.clipEnd(clip));
  parent = { ...parent, clips: [...parent.clips, clip] };
  return { doc: { ...withTimeline(doc, parent), timelines: [...withTimeline(doc, parent).timelines, nested] }, timelineId: nestedId, clipId: clip.id };
}

/** Put the contents of a nested clip back on the timeline as ordinary clips on new tracks, and drop the nested clip. */
export function flattenNested(doc: ProjectDoc, clipId: string): ProjectDoc | null {
  const tl = activeTimeline(doc);
  const c = tl.clips.find((x) => x.id === clipId);
  const nested = c?.timelineId ? doc.timelines.find((t) => t.id === c.timelineId) : undefined;
  if (!c || !nested || E.isLocked(tl, c.trackId)) return null;
  const win0 = c.sourceIn;
  const win1 = c.sourceIn + c.duration * c.speed;
  let next: Timeline = { ...tl, clips: tl.clips.filter((x) => x.id !== c.id) };
  const trackMap = new Map<string, string>();
  for (const t of nested.tracks) {
    if (t.kind === "subtitle") continue;
    const r = E.addTrack(next, t.kind, `${c.name ?? "Compound"} ${t.name}`);
    next = r.tl;
    trackMap.set(t.id, r.id);
  }
  const links = new Map<string, string>();
  const added: Clip[] = [];
  for (const k of nested.clips) {
    const track = trackMap.get(k.trackId);
    if (!track) continue;
    const a = Math.max(k.start, win0);
    const b = Math.min(E.clipEnd(k), win1);
    if (b - a <= 1e-4) continue;
    const linkId = k.linkId ? (links.get(k.linkId) ?? links.set(k.linkId, E.newId("l")).get(k.linkId)) : undefined;
    // the part of the inner clip inside the window, with its source range moved to match (a reversed clip counts from its out point)
    const headCut = a - k.start;
    const tailCut = E.clipEnd(k) - b;
    const piece: Clip = { ...k, id: E.newId("c"), trackId: track, linkId, start: tidy(c.start + (a - win0) / c.speed), duration: tidy((b - a) / c.speed), speed: k.speed * c.speed };
    if (headCut > 1e-6 || tailCut > 1e-6) {
      const inner = { ...k, duration: k.duration };
      const s0 = sourceAtRel(inner, headCut);
      const s1 = sourceAtRel(inner, k.duration - tailCut);
      if (k.reverse) (piece.sourceOut = tidy(s0)), (piece.sourceIn = tidy(s1));
      else (piece.sourceIn = tidy(s0)), (piece.sourceOut = tidy(s1));
      if (headCut > 1e-6) piece.keyframes = {};
    }
    added.push(piece);
  }
  next = { ...next, clips: [...next.clips, ...added] };
  let out = withTimeline(doc, next);
  // an unused nested timeline goes with it
  if (!out.timelines.some((t) => t.clips.some((x) => x.timelineId === nested.id))) out = { ...out, timelines: out.timelines.filter((t) => t.id !== nested.id) };
  return out;
}

/** A timeline placed on another as a nested clip at `at`, on a video track. Null when that would make a loop. */
export function placeTimeline(doc: ProjectDoc, timelineId: string, at: number, trackId?: string): { doc: ProjectDoc; clipId: string } | null {
  const host = activeTimeline(doc);
  const nested = doc.timelines.find((t) => t.id === timelineId);
  if (!nested || usesTimeline(doc, timelineId, host.id)) return null;
  const track = (trackId && host.tracks.find((t) => t.id === trackId && t.kind === "video")) || E.targetTrack(host, "video") || host.tracks.find((t) => t.kind === "video");
  if (!track || track.locked) return null;
  const length = Math.max(0.1, E.timelineEnd(nested));
  const clip: Clip = { id: E.newId("c"), trackId: track.id, name: nested.name, start: tidy(at), duration: tidy(length), sourceIn: 0, sourceOut: tidy(length), speed: 1, enabled: true, effects: [], keyframes: {}, timelineId };
  const cleared = E.clearRange(host, track.id, clip.start, E.clipEnd(clip));
  return { doc: withTimeline(doc, { ...cleared, clips: [...cleared.clips, clip] }), clipId: clip.id };
}

/* ---------- versions ---------- */

/** A copy of a timeline (new ids everywhere, references between its clips kept) under a new name. */
export function duplicateTimeline(doc: ProjectDoc, id: string, name?: string): { doc: ProjectDoc; timelineId: string } | null {
  const src = doc.timelines.find((t) => t.id === id);
  if (!src) return null;
  const trackMap = new Map(src.tracks.map((t) => [t.id, E.newId("t")]));
  const clipMap = new Map(src.clips.map((c) => [c.id, E.newId("c")]));
  const linkMap = new Map<string, string>();
  const copy: Timeline = structuredClone(src);
  const tid = E.newId("tl");
  copy.id = tid;
  copy.name = name ?? `${src.name} copy`;
  copy.tracks = copy.tracks.map((t) => ({ ...t, id: trackMap.get(t.id)!, target: undefined }));
  copy.clips = copy.clips.map((c) => {
    const r: Clip = { ...c, id: clipMap.get(c.id)!, trackId: trackMap.get(c.trackId)! };
    if (c.linkId) r.linkId = linkMap.get(c.linkId) ?? linkMap.set(c.linkId, E.newId("l")).get(c.linkId);
    if (c.matte) r.matte = { ...c.matte, clipId: clipMap.get(c.matte.clipId) ?? c.matte.clipId };
    if (c.follow) r.follow = { ...c.follow, clipId: clipMap.get(c.follow.clipId) ?? c.follow.clipId };
    return r;
  });
  copy.cutTransitions = copy.cutTransitions?.map((x) => ({ ...x, id: E.newId("tr"), trackId: trackMap.get(x.trackId) ?? x.trackId, from: x.from ? clipMap.get(x.from) : undefined, to: x.to ? clipMap.get(x.to) : undefined }));
  copy.markers = copy.markers.map((m) => ({ ...m, id: E.newId("mk"), clipId: m.clipId ? clipMap.get(m.clipId) : undefined }));
  return { doc: { ...doc, timelines: [...doc.timelines, copy] }, timelineId: tid };
}

const ASPECT_RATIO: Record<Aspect, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 };
export const aspectRatio = (a: Aspect) => ASPECT_RATIO[a];

/**
 * The horizontal position (frame fraction) of a picture so the point at picture fraction `px` sits in the middle of the
 * frame, when the picture is scaled to cover a frame `ratio` times narrower (ratio = picture width / frame width).
 * The picture never moves far enough to show an edge.
 */
export function reframeX(px: number, ratio: number): number {
  if (ratio <= 1) return 0.5;
  const reach = (ratio - 1) / 2;
  return 0.5 + Math.max(-reach, Math.min(reach, (0.5 - px) * ratio));
}

/** The scale-to-cover ratio of a picture of `pw/ph` in a frame of `fw/fh`: how many frame widths wide the picture is. */
export const coverRatio = (picAspect: number, frameAspect: number) => Math.max(1, picAspect / frameAspect);

/**
 * Make a version of a timeline in another frame shape: picture clips fill the new frame (a crop), centred, or following
 * their tracker when they have one (the point stays in the middle). The crop is plain position keyframes, so it can be adjusted by hand.
 */
export function reframeTimeline(doc: ProjectDoc, timelineId: string, to: Aspect): ProjectDoc | null {
  const tl = doc.timelines.find((t) => t.id === timelineId);
  if (!tl) return null;
  const fa = aspectRatio(to);
  const clips = tl.clips.map((c) => {
    const m = doc.media.find((x) => x.id === c.mediaId);
    if (c.fill || !m || (m.kind !== "video" && m.kind !== "image")) return c;
    const pa = m.width && m.height ? m.width / m.height : aspectRatio(doc.settings.aspect);
    const ratio = coverRatio(pa, fa);
    const tr = c.trackers?.[0];
    const next: Clip = { ...c, transform: { ...(c.transform ?? {}), fit: "cover", scale: 1, x: reframeX(tr ? tr.x : 0.5, ratio) } };
    if (tr && tr.samples.length > 1 && ratio > 1) {
      // follow the tracked point, one key every quarter second
      const keys = [];
      for (let t = 0; t <= c.duration + 1e-6; t += 0.25) keys.push({ t: tidy(Math.min(t, c.duration)), v: tidy(reframeX(trackerAt(tr, t).x, ratio)) });
      next.anim = { ...(c.anim ?? {}), x: keys };
    }
    return next;
  });
  return withTimeline(doc, { ...tl, aspect: to, clips });
}

/* ---------- subclips ---------- */

export function makeSubclip(doc: ProjectDoc, name: string, mediaId: string, from: number, to: number): ProjectDoc | null {
  if (!doc.media.some((m) => m.id === mediaId) || to - from < 0.05) return null;
  const sub: Subclip = { id: E.newId("sc"), name, mediaId, in: tidy(Math.max(0, from)), out: tidy(to) };
  return { ...doc, subclips: [...(doc.subclips ?? []), sub] };
}

export const removeSubclip = (doc: ProjectDoc, id: string): ProjectDoc => ({ ...doc, subclips: (doc.subclips ?? []).filter((s) => s.id !== id) });

/** The edit source a subclip stands for (the media range), to place with the usual insert and overwrite edits. */
export function subclipSource(doc: ProjectDoc, sub: Subclip): E.Source | null {
  const m = doc.media.find((x) => x.id === sub.mediaId);
  if (!m || m.kind === "subtitle") return null;
  return { mediaId: m.id, name: sub.name, kind: m.kind, in: sub.in, out: Math.min(sub.out, m.duration ?? sub.out), withAudio: m.kind === "video" && m.hasAudio !== false };
}

/* ---------- multicam ---------- */

export type AngleInput = { mediaId: string; name: string; offset: number };

/** A multicam clip from synced angles at `at` on a video track, `length` seconds of multicam time. */
export function makeMulticam(doc: ProjectDoc, angles: AngleInput[], at: number, length: number, trackId?: string, audio?: { mediaId: string; offset: number }): { doc: ProjectDoc; clipId: string } | null {
  const tl = activeTimeline(doc);
  const track = (trackId && tl.tracks.find((t) => t.id === trackId && t.kind === "video")) || E.targetTrack(tl, "video") || tl.tracks.find((t) => t.kind === "video");
  if (!track || track.locked || angles.length < 2) return null;
  const spec = { angles: angles.map((a, i) => ({ id: `ang${i + 1}`, name: a.name, mediaId: a.mediaId, offset: a.offset })), cuts: [], ...(audio ? { audioMediaId: audio.mediaId, audioOffset: audio.offset } : {}) };
  const clip: Clip = { id: E.newId("c"), trackId: track.id, name: "Multicam", mediaId: angles[0].mediaId, start: tidy(at), duration: tidy(length), sourceIn: 0, sourceOut: tidy(length), speed: 1, enabled: true, effects: [], keyframes: {}, multicam: spec };
  const cleared = E.clearRange(tl, track.id, clip.start, E.clipEnd(clip));
  return { doc: withTimeline(doc, { ...cleared, clips: [...cleared.clips, clip] }), clipId: clip.id };
}

/** Replace a multicam clip with ordinary clips, one per stretch between cuts (video) and per sound source (audio), so every cut is a normal edit. */
export function commitMulticam(doc: ProjectDoc, clipId: string): ProjectDoc | null {
  const tl = activeTimeline(doc);
  const c = tl.clips.find((x) => x.id === clipId);
  if (!c?.multicam || E.isLocked(tl, c.trackId)) return null;
  const spec = c.multicam;
  const base = { speed: c.speed, enabled: true, effects: [] as Clip["effects"], keyframes: {}, volume: c.volume };
  const out: Clip[] = [];
  for (const seg of segments(spec, c.sourceIn, c.duration * c.speed)) {
    const a = spec.angles.find((x) => x.id === seg.angle)!;
    const media = doc.media.find((m) => m.id === a.mediaId);
    let srcIn = seg.from + a.offset;
    let start = c.start + (seg.from - c.sourceIn) / c.speed;
    let duration = (seg.to - seg.from) / c.speed;
    if (srcIn < 0) (start += -srcIn / c.speed), (duration -= -srcIn / c.speed), (srcIn = 0);
    if (duration <= 1e-3) continue;
    const srcOut = Math.min(media?.duration ?? Infinity, srcIn + duration * c.speed);
    out.push({ ...base, id: E.newId("c"), trackId: c.trackId, name: a.name, mediaId: a.mediaId, start: tidy(start), duration: tidy(duration), sourceIn: tidy(srcIn), sourceOut: tidy(srcOut), transform: c.transform, anim: undefined });
  }
  // the sound goes on the first audio track (or none when there is none)
  const audioTrack = tl.tracks.find((t) => t.kind === "audio" && !t.locked);
  if (audioTrack) {
    for (const s of soundSegments(spec, c.sourceIn, c.duration * c.speed)) {
      const media = doc.media.find((m) => m.id === s.mediaId);
      let srcIn = s.from + s.offset;
      let start = c.start + (s.from - c.sourceIn) / c.speed;
      let duration = (s.to - s.from) / c.speed;
      if (srcIn < 0) (start += -srcIn / c.speed), (duration -= -srcIn / c.speed), (srcIn = 0);
      if (duration <= 1e-3) continue;
      out.push({ ...base, id: E.newId("c"), trackId: audioTrack.id, name: media?.name, mediaId: s.mediaId, start: tidy(start), duration: tidy(duration), sourceIn: tidy(srcIn), sourceOut: tidy(Math.min(media?.duration ?? Infinity, srcIn + duration * c.speed)) });
    }
  }
  const rest = tl.clips.filter((x) => x.id !== c.id);
  return withTimeline(doc, { ...tl, clips: [...rest, ...out] });
}

/** Where a clip must start so its media lines up with the anchor's, given the lag of the clip's media inside the anchor's media (seconds). */
export function syncedStart(anchor: Clip, clip: Clip, lag: number): number {
  // the clip's media second 0 is the anchor's media second `lag`; both play at speed 1 in a sync
  const origin = anchor.start + (lag - anchor.sourceIn) / anchor.speed;
  return tidy(origin + clip.sourceIn / clip.speed);
}

/** Move clips to their synced positions and link each to the anchor (so they move, trim and delete together). */
export function applySync(tl: Timeline, anchorId: string, lags: { clipId: string; lag: number }[], link = true): Timeline {
  const anchor = tl.clips.find((c) => c.id === anchorId);
  if (!anchor) return tl;
  const linkId = anchor.linkId ?? E.newId("l");
  const byId = new Map(lags.map((l) => [l.clipId, l.lag]));
  return {
    ...tl,
    clips: tl.clips.map((c) => {
      if (c.id === anchorId) return link ? { ...c, linkId } : c;
      const lag = byId.get(c.id);
      if (lag === undefined || E.isLocked(tl, c.trackId)) return c;
      return { ...c, start: Math.max(0, syncedStart(anchor, c, lag)), ...(link ? { linkId } : {}) };
    }),
  };
}

/** The angle offsets for a multicam from lags of each angle's media inside the first angle's media (the first has lag 0). */
export const offsetsFromLags = (lags: number[]): number[] => lags.map((l) => tidy(-l));

/* ---------- retiming a clip ---------- */

/** Duration of a clip that shows `span` seconds of source at constant speed `s`. */
export const durationFor = (span: number, s: number) => Math.round((span / s) * 1e6) / 1e6;

/** Change retiming fields of clips (and their linked partners). Longer clips clear whatever they now overlap on their track. */
export function retimeClips(tl: Timeline, ids: string[], patch: (c: Clip) => Partial<Clip>): Timeline {
  let next = tl;
  for (const id of E.withLinked(tl, ids)) {
    const c = next.clips.find((x) => x.id === id);
    if (!c || c.fill || E.isLocked(next, c.trackId)) continue;
    const merged = { ...c, ...patch(c) };
    next = { ...next, clips: next.clips.map((x) => (x.id === id ? merged : x)) };
    if (merged.duration > c.duration) next = E.clearRange(next, c.trackId, E.clipEnd(c), E.clipEnd(merged), new Set([id]));
  }
  return next;
}
