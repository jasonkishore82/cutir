import { z } from "zod";
import { defineTool } from "./registry";
import { num, seconds } from "./schema";
import { activeTimeline } from "../../model/convert";
import type { ClipTransform, ProjectDoc, Timeline, Track } from "../../model/types";
import * as E from "../../timeline/engine";
import { sourceOf, withPoolMedia } from "../../timeline/ui";
import { useMedia, type MediaItem } from "../../store/media";

/**
 * Timeline tools (phases 13 to 15): clips on video and audio tracks, tracks, markers and the in/out range.
 * They work on the whole document (`applyDoc`), apply as one undo step like every tool, and never change locked
 * tracks. Clips are referred to by id (see the project summary); media by its library name or id.
 */

const on = (doc: ProjectDoc, fn: (tl: Timeline) => Timeline) => E.onActive(doc, fn);
const tl = (doc: ProjectDoc) => activeTimeline(doc);

/** A library item by id or (case-insensitive, extension optional) name. */
function findMedia(ref: string): MediaItem {
  const items = useMedia.getState().items;
  const k = ref.trim().toLowerCase();
  const it =
    items.find((i) => i.id === ref) ??
    items.find((i) => i.name.toLowerCase() === k) ??
    items.find((i) => i.name.toLowerCase().replace(/\.[a-z0-9]+$/, "") === k.replace(/\.[a-z0-9]+$/, "")) ??
    items.find((i) => i.name.toLowerCase().includes(k));
  if (!it) throw new Error(`no media "${ref}" in the library. Library: ${items.map((i) => i.name).slice(0, 20).join(", ") || "(empty)"}`);
  return it;
}

/** A track by id, by name, or by kind ("video" / "audio" = the insert target of that kind). */
function findTrack(t: Timeline, ref: string | undefined, kind: "video" | "audio"): Track {
  if (!ref || ref === kind) {
    const target = E.targetTrack(t, kind);
    if (!target) throw new Error(`there is no unlocked ${kind} track; add one with add_track`);
    return target;
  }
  const k = ref.trim().toLowerCase();
  const tr = t.tracks.find((x) => x.id === ref) ?? t.tracks.find((x) => x.name.toLowerCase() === k);
  if (!tr) throw new Error(`no track "${ref}". Tracks: ${t.tracks.filter((x) => x.kind !== "subtitle").map((x) => `${x.name} (${x.kind})`).join(", ")}`);
  return tr;
}

function clipIds(t: Timeline, ids: string[]): string[] {
  const missing = ids.filter((id) => !t.clips.some((c) => c.id === id));
  if (missing.length) throw new Error(`no clip ${missing.join(", ")} on the timeline (clip ids are in the project summary)`);
  return ids;
}

const ids = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v])).describe("clip id or list of clip ids");

export const addClip = defineTool({
  name: "add_clip",
  group: "timeline",
  description: "Put a file from the media library on the timeline. mode overwrite (default) replaces what is there; insert pushes later clips; append adds after the last clip; top uses a free track above.",
  hint: "media = library name or id; track = track name, or video / audio for the target track; at = seconds; in/out = part of the source in seconds",
  params: z.object({
    media: z.string().min(1),
    at: seconds.optional(),
    track: z.string().optional(),
    in: seconds.optional(),
    out: seconds.optional(),
    mode: z.enum(["overwrite", "insert", "append", "top"]).default("overwrite"),
  }),
  normalize: (a) => (a && typeof a === "object" && "file" in a && !("media" in a) ? { ...(a as object), media: (a as { file: unknown }).file } : a),
  applyDoc: (doc, a) => {
    const item = findMedia(a.media);
    const src0 = sourceOf(item);
    if (!src0) throw new Error(`${item.name} is a ${item.kind} file; only video, audio and images go on tracks`);
    const src = { ...src0, in: a.in ?? src0.in, out: a.out ?? src0.out };
    if (src.out <= src.in) throw new Error("out must be after in");
    const kind = item.kind === "audio" ? "audio" : "video";
    let placed: string[] = [];
    const next = on(withPoolMedia(doc, item), (t) => {
      const track = findTrack(t, a.track, kind);
      if (track.kind !== kind) throw new Error(`${item.name} needs a ${kind} track, ${track.name} is a ${track.kind} track`);
      const targets = kind === "video" ? { video: track.id, audio: E.targetTrack(t, "audio")?.id } : { audio: track.id };
      const at = a.at ?? 0;
      const r =
        a.mode === "insert" ? E.insertEdit(t, src, at, targets) : a.mode === "append" ? E.appendEdit(t, src, targets) : a.mode === "top" ? E.placeOnTop(t, src, at, targets) : E.overwriteEdit(t, src, at, targets);
      placed = r.ids;
      return r.tl;
    });
    if (!placed.length) throw new Error("nothing was placed: the track is locked");
    return { doc: next, summary: `${item.name} placed (${a.mode}) as ${placed.join(", ")}` };
  },
});

export const trimClip = defineTool({
  name: "trim_clip",
  group: "timeline",
  description: "Trim the start or end of a clip, by seconds (by, + = later) or to a time (to). ripple: later clips follow so no gap opens.",
  params: z.object({ clip: z.string(), edge: z.enum(["start", "end"]), by: num(-36000, 36000).optional(), to: seconds.optional(), ripple: z.boolean().default(false) }),
  applyDoc: (doc, a) => {
    const t = tl(doc);
    const c = t.clips.find((x) => x.id === clipIds(t, [a.clip])[0])!;
    const cur = a.edge === "start" ? c.start : E.clipEnd(c);
    const dt = a.to !== undefined ? a.to - cur : a.by ?? 0;
    const next = on(doc, (x) => E.trimEdge(x, c.id, a.edge, dt, a.ripple, { fps: doc.settings.fps, mediaDuration: (id) => doc.media.find((m) => m.id === id)?.duration }));
    return { doc: next, summary: `${c.id} ${a.edge} trimmed${a.ripple ? " (ripple)" : ""}` };
  },
});

export const moveClips = defineTool({
  name: "move_clips",
  group: "timeline",
  description: "Move clips (and their linked sound) by seconds, or so the first starts at a time; optionally onto another track of the same kind.",
  params: z.object({ clips: ids, by: num(-36000, 36000).optional(), to: seconds.optional(), track: z.string().optional() }),
  applyDoc: (doc, a) => {
    const t = tl(doc);
    const list = clipIds(t, a.clips);
    const group = t.clips.filter((c) => list.includes(c.id));
    const first = Math.min(...group.map((c) => c.start));
    const dt = a.to !== undefined ? a.to - first : a.by ?? 0;
    let shift = 0;
    let kind: Track["kind"] | undefined;
    if (a.track) {
      const from = t.tracks.find((x) => x.id === group[0].trackId)!;
      const to = findTrack(t, a.track, from.kind === "audio" ? "audio" : "video");
      if (to.kind !== from.kind) throw new Error(`clips on ${from.kind} tracks can only move to another ${from.kind} track`);
      const order = E.displayOrder(t).filter((x) => x.kind === from.kind);
      shift = order.indexOf(from) - order.indexOf(to);
      kind = from.kind;
    }
    const next = on(doc, (x) => E.moveClips(x, list, dt, shift, kind));
    if (next === doc) throw new Error("nothing moved: a clip or the destination track is locked, or it is already there");
    return { doc: next, summary: `${list.length} clip(s) moved` };
  },
});

export const cutAt = defineTool({
  name: "cut_at",
  group: "timeline",
  description: "Cut (blade) clips at a time: the given clips, or every clip under that time on unlocked tracks.",
  params: z.object({ time: seconds, clips: ids.optional() }),
  applyDoc: (doc, a) => ({ doc: on(doc, (x) => E.blade(x, a.time, a.clips ? clipIds(x, a.clips) : undefined)), summary: `cut at ${a.time}s` }),
});

export const deleteClips = defineTool({
  name: "delete_clips",
  group: "timeline",
  description: "Delete clips (with their linked sound). ripple closes the gaps they leave.",
  params: z.object({ clips: ids, ripple: z.boolean().default(false) }),
  applyDoc: (doc, a) => ({ doc: on(doc, (x) => (a.ripple ? E.rippleDelete(x, clipIds(x, a.clips)) : E.deleteClips(x, clipIds(x, a.clips)))), summary: `${a.clips.length} clip(s) deleted${a.ripple ? " (ripple)" : ""}` }),
});

const BLENDS = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add", "difference"] as const;

export const setClip = defineTool({
  name: "set_clip",
  group: "timeline",
  description: "Place a video or image clip in the frame (x, y in percent, 50/50 = centre; scale 1 = fitted; rotation in degrees; opacity 0-1), or set an audio clip's volume (0-2), speed or whether it is enabled.",
  params: z.object({
    clips: ids,
    x: num(-100, 200).optional(),
    y: num(-100, 200).optional(),
    scale: num(0.01, 10).optional(),
    rotation: num(-360, 360).optional(),
    opacity: num(0, 1).optional(),
    blend: z.enum(BLENDS).optional(),
    fit: z.enum(["contain", "cover", "fill"]).optional(),
    volume: num(0, 2).optional(),
    enabled: z.boolean().optional(),
  }),
  applyDoc: (doc, a) => {
    const t = tl(doc);
    const list = new Set(clipIds(t, a.clips));
    const tf: Partial<ClipTransform> = {};
    if (a.x !== undefined) tf.x = a.x / 100;
    if (a.y !== undefined) tf.y = a.y / 100;
    for (const k of ["scale", "rotation", "opacity", "blend", "fit"] as const) if (a[k] !== undefined) (tf as Record<string, unknown>)[k] = a[k];
    const next = on(doc, (x) => ({
      ...x,
      clips: x.clips.map((c) => {
        if (!list.has(c.id) || E.isLocked(x, c.trackId)) return c;
        const out = { ...c };
        if (Object.keys(tf).length) out.transform = { ...(c.transform ?? {}), ...tf };
        if (a.volume !== undefined) out.volume = a.volume;
        if (a.enabled !== undefined) out.enabled = a.enabled;
        return out;
      }),
    }));
    return { doc: next, summary: `${list.size} clip(s) updated` };
  },
});

export const addTrackTool = defineTool({
  name: "add_track",
  group: "timeline",
  description: "Add a video or audio track.",
  params: z.object({ kind: z.enum(["video", "audio"]), name: z.string().optional() }),
  applyDoc: (doc, a) => {
    let id = "";
    const next = on(doc, (x) => {
      const r = E.addTrack(x, a.kind, a.name);
      id = r.id;
      return r.tl;
    });
    return { doc: next, summary: `${a.kind} track added (${id})` };
  },
});

export const setTrackTool = defineTool({
  name: "set_track",
  group: "timeline",
  description: "Change a video or audio track: rename, mute, solo, lock, hide, or make it the insert target.",
  params: z.object({ track: z.string(), name: z.string().optional(), muted: z.boolean().optional(), solo: z.boolean().optional(), locked: z.boolean().optional(), hidden: z.boolean().optional(), target: z.boolean().optional() }),
  applyDoc: (doc, a) => {
    const t = tl(doc);
    const k = a.track.toLowerCase();
    const tr = t.tracks.find((x) => x.id === a.track) ?? t.tracks.find((x) => x.name.toLowerCase() === k);
    if (!tr || tr.kind === "subtitle") throw new Error(`no video or audio track "${a.track}"`);
    const { track: _t, target, ...patch } = a;
    void _t;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    let next = on(doc, (x) => E.setTrack(x, tr.id, clean));
    if (target) next = on(next, (x) => E.setTarget(x, tr.id));
    return { doc: next, summary: `track ${tr.name}: ${Object.keys(clean).concat(target ? ["target"] : []).join(", ")}` };
  },
});

export const addMarkerTool = defineTool({
  name: "add_marker",
  group: "timeline",
  description: "Add a marker on the ruler (or on a clip) at a time.",
  params: z.object({ time: seconds, name: z.string().optional(), color: z.string().optional(), note: z.string().optional(), clip: z.string().optional() }),
  applyDoc: (doc, a) => ({ doc: on(doc, (x) => E.addMarker(x, a.time, { name: a.name, color: a.color, note: a.note, clipId: a.clip }).tl), summary: `marker at ${a.time}s` }),
});

export const setRangeTool = defineTool({
  name: "set_range",
  group: "timeline",
  description: "Set the timeline in and out points (seconds), or clear them.",
  params: z.object({ in: seconds.optional(), out: seconds.optional(), clear: z.boolean().default(false) }),
  applyDoc: (doc, a) => ({
    doc: on(doc, (x) => (a.clear ? E.setRange(x, null, null) : E.setRange(x, a.in, a.out))),
    summary: a.clear ? "in/out cleared" : `in/out ${a.in ?? "-"} to ${a.out ?? "-"}`,
  }),
});

export const timelineTools = [addClip, trimClip, moveClips, cutAt, deleteClips, setClip, addTrackTool, setTrackTool, addMarkerTool, setRangeTool];
