import type { Clip } from "../../model/types";
import { round, type EditItem, type EditList, type EditTrack, type Note } from "./common";

/**
 * OpenTimelineIO (.otio, JSON). Written: Timeline > Stack > Tracks of Clips and Gaps, a LinearTimeWarp for speed and
 * markers on the stack. Cutir keeps the full clip in metadata.cutir, so a file that goes through another tool and comes
 * back (or stays in Cutir) restores effects, keyframes and the rest; other tools just see cuts and speed.
 */

type Json = Record<string, any>;

const rt = (sec: number, rate: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate, value: round(sec * rate, 4) });
const range = (start: number, dur: number, rate: number): Json => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(start, rate), duration: rt(dur, rate) });

export function exportOtio(list: EditList): { json: Json; report: Note[] } {
  const rate = list.fps;
  const tracks: Json[] = list.tracks.map((t) => {
    const children: Json[] = [];
    let at = 0;
    for (const it of t.items) {
      if (it.start > at + 1e-6) children.push({ OTIO_SCHEMA: "Gap.1", name: "", source_range: range(0, it.start - at, rate), metadata: {} });
      const effects = Math.abs(it.speed - 1) > 1e-6 ? [{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "", effect_name: "LinearTimeWarp", time_scalar: it.speed, metadata: {} }] : [];
      children.push({
        OTIO_SCHEMA: "Clip.2",
        name: it.name,
        source_range: range(it.sourceIn, it.duration * it.speed, rate),
        media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", name: it.media, target_url: it.media, metadata: {} } },
        active_media_reference_key: "DEFAULT_MEDIA",
        effects,
        markers: [],
        metadata: { cutir: { clip: it.clip, linkId: it.linkId, start: round(it.start) } },
      });
      at = it.start + it.duration;
    }
    return { OTIO_SCHEMA: "Track.1", name: t.name, kind: t.kind === "video" ? "Video" : "Audio", children, effects: [], markers: [], metadata: {} };
  });
  const markers = list.markers.map((m) => ({ OTIO_SCHEMA: "Marker.2", name: m.name, color: "YELLOW", marked_range: range(m.time, 0, rate), comment: m.note ?? "", metadata: {} }));
  const json = {
    OTIO_SCHEMA: "Timeline.1",
    name: list.name,
    global_start_time: rt(0, rate),
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", children: tracks, effects: [], markers, metadata: {} },
    metadata: { cutir: { fps: rate } },
  };
  return { json, report: [] };
}

const secs = (t: Json | undefined): number => (t && typeof t.value === "number" && typeof t.rate === "number" && t.rate > 0 ? t.value / t.rate : 0);
const schemaOf = (o: Json | undefined) => String(o?.OTIO_SCHEMA ?? "").split(".")[0];

/** Read an OpenTimelineIO file (JSON text or parsed). Throws a readable message when it is not one. */
export function parseOtio(input: string | Json, fallbackFps: number): { list: EditList; report: Note[] } {
  let root: Json;
  try {
    root = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("This is not an OpenTimelineIO file (it is not valid JSON).");
  }
  if (!root || typeof root !== "object" || !/^(Timeline|SerializableCollection|Stack)$/.test(schemaOf(root))) throw new Error("This is not an OpenTimelineIO timeline.");
  const report: Note[] = [];
  const stack: Json = schemaOf(root) === "Timeline" ? root.tracks : root;
  const fps = Number(root.metadata?.cutir?.fps) || secsRate(stack) || fallbackFps;
  const tracks: EditTrack[] = [];
  const dropped = new Map<string, number>();
  const drop = (k: string) => dropped.set(k, (dropped.get(k) ?? 0) + 1);
  const trackList: Json[] = (stack?.children ?? []).filter((c: Json) => schemaOf(c) === "Track");
  if ((stack?.children ?? []).some((c: Json) => schemaOf(c) !== "Track")) drop("items that are not tracks");
  trackList.forEach((tr, ti) => {
    const kind: "video" | "audio" = String(tr.kind).toLowerCase() === "audio" ? "audio" : "video";
    const items: EditItem[] = [];
    let at = 0;
    for (const ch of (tr.children ?? []) as Json[]) {
      const s = schemaOf(ch);
      if (s === "Gap") {
        at += secs(ch.source_range?.duration);
        continue;
      }
      if (s === "Transition") {
        drop("transitions");
        continue;
      }
      if (s === "Stack" || s === "Track") {
        drop("nested sequences");
        at += nestedLength(ch);
        continue;
      }
      if (s !== "Clip") {
        drop(`${s || "unknown"} items`);
        continue;
      }
      const refs: Json = ch.media_references ?? {};
      const ref: Json | undefined = refs[ch.active_media_reference_key] ?? ch.media_reference ?? Object.values(refs)[0];
      const url = String(ref?.target_url ?? ref?.name ?? ch.name ?? "");
      const sr = ch.source_range ?? (ref?.available_range ? ref.available_range : undefined);
      const srcLen = secs(sr?.duration);
      if (!(srcLen > 0)) {
        drop("clips with no length");
        continue;
      }
      let speed = 1;
      for (const ef of (ch.effects ?? []) as Json[]) {
        if (schemaOf(ef) === "LinearTimeWarp" && Number(ef.time_scalar) > 0) speed *= Number(ef.time_scalar);
        else if (schemaOf(ef) === "FreezeFrame") drop("freeze frames");
        else drop("effects");
      }
      const meta = ch.metadata?.cutir;
      const dur = srcLen / speed;
      const item: EditItem = { name: String(ch.name || url), media: url, start: at, duration: dur, sourceIn: secs(sr?.start_time), speed, linkId: meta?.linkId };
      if (meta?.clip && typeof meta.clip === "object" && Math.abs((meta.clip.duration ?? dur) - dur) < 1e-3) item.clip = meta.clip as Clip;
      items.push(item);
      at += dur;
    }
    if (items.length) tracks.push({ kind, name: String(tr.name || `${kind === "video" ? "V" : "A"}${ti + 1}`), items });
  });
  for (const [k, n] of dropped) report.push({ level: "warn", text: `Skipped ${n} ${k}.` });
  const markers = ((stack?.markers ?? []) as Json[]).map((m) => ({ time: secs(m.marked_range?.start_time), name: String(m.name ?? "Marker"), note: m.comment ? String(m.comment) : undefined }));
  const duration = Math.max(0, ...tracks.flatMap((t) => t.items.map((i) => i.start + i.duration)));
  if (!tracks.length) report.push({ level: "warn", text: "No clips were found in this file." });
  return { list: { name: String(root.name || "Imported timeline"), fps, duration, tracks, markers }, report };
}

function secsRate(stack: Json | undefined): number {
  for (const tr of stack?.children ?? []) for (const c of tr.children ?? []) if (c.source_range?.duration?.rate > 0) return c.source_range.duration.rate;
  return 0;
}

function nestedLength(n: Json): number {
  if (n.source_range?.duration) return secs(n.source_range.duration);
  let max = 0;
  for (const c of (n.children ?? []) as Json[]) {
    if (schemaOf(c) === "Track") max = Math.max(max, nestedLength(c));
    else max += secs(c.source_range?.duration);
  }
  return max;
}
