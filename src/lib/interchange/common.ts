import type { Clip, MediaRef, ProjectDoc, Timeline } from "../../model/types";
import * as E from "../../timeline/engine";

/**
 * Interchange (phase 29): the part of a timeline that other editors understand. A timeline is reduced to an EditList
 * (cuts on video and audio tracks, with speed and markers), written as EDL, OpenTimelineIO or FCPXML, or built back
 * from one. Everything that does not fit is listed in a report so nothing is lost without the user knowing.
 */

export type Note = { level: "info" | "warn"; text: string };

export type EditItem = {
  name: string;
  /** File name of the media (what the other editor relinks by). */
  media: string;
  /** Timeline position, source start and length on the timeline, all in seconds. */
  start: number;
  duration: number;
  sourceIn: number;
  speed: number;
  linkId?: string;
  /** Full Cutir clip, kept in OTIO metadata so a round trip through Cutir restores effects and the like. */
  clip?: Clip;
};

export type EditTrack = { kind: "video" | "audio"; name: string; items: EditItem[] };
export type EditMarker = { time: number; name: string; note?: string };
export type EditList = { name: string; fps: number; duration: number; tracks: EditTrack[]; markers: EditMarker[] };

export const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/** What a clip carries that a plain edit list cannot. */
function extras(c: Clip): string[] {
  const out: string[] = [];
  if (c.effects.length || c.graph) out.push("effects");
  if (c.transform && Object.keys(c.transform).length) out.push("position and scale");
  if (c.anim && Object.keys(c.anim).length) out.push("animated values");
  if (c.ramp) out.push("speed ramps");
  if (c.keyframes && Object.values(c.keyframes).some((k) => k?.length)) out.push("keyframes");
  if (c.volume !== undefined && c.volume !== 1) out.push("volume changes");
  if (c.fadeIn || c.fadeOut) out.push("fades");
  if (c.reverse) out.push("reversed clips");
  if (c.matte) out.push("mattes");
  return out;
}

export function toEditList(doc: ProjectDoc, tl: Timeline, fps: number = doc.settings.fps): { list: EditList; report: Note[] } {
  const report: Note[] = [];
  const media = new Map(doc.media.map((m) => [m.id, m]));
  const tracks: EditTrack[] = [];
  const skipped = new Map<string, number>();
  const bump = (k: string, n = 1) => skipped.set(k, (skipped.get(k) ?? 0) + n);
  const lost = new Map<string, Set<string>>();
  let duration = 0;
  for (const tr of tl.tracks) {
    if (tr.kind === "subtitle") {
      bump("text clips", tl.clips.filter((c) => c.trackId === tr.id).length);
      continue;
    }
    const items: EditItem[] = [];
    for (const c of E.clipsOn(tl, tr.id)) {
      if (!c.enabled) {
        bump("disabled clips");
        continue;
      }
      if (c.timelineId) {
        bump("nested timelines");
        continue;
      }
      const m = media.get(c.mediaId ?? c.multicam?.angles[0]?.mediaId ?? "");
      if (!m) {
        bump(c.generator ? "generated clips (colours, bars)" : "clips with no media");
        continue;
      }
      if (c.multicam) bump("multicam clips (written as their first angle)");
      for (const x of extras(c)) (lost.get(x) ?? lost.set(x, new Set()).get(x)!).add(c.name ?? m.name);
      items.push({ name: c.name ?? m.name, media: m.name, start: c.start, duration: c.duration, sourceIn: c.sourceIn, speed: c.speed || 1, linkId: c.linkId, clip: c });
      duration = Math.max(duration, c.start + c.duration);
    }
    if (items.length) tracks.push({ kind: tr.kind, name: tr.name, items });
  }
  for (const [what, n] of skipped) if (n) report.push({ level: "warn", text: `Not exported: ${n} ${n === 1 && what.endsWith("s") ? what.slice(0, -1) : what}.` });
  for (const [what, names] of lost) {
    report.push({ level: "warn", text: `${what[0].toUpperCase()}${what.slice(1)} on ${names.size} clip${names.size === 1 ? "" : "s"} do not carry over to other editors (${[...names].slice(0, 3).join(", ")}${names.size > 3 ? ", ..." : ""}).` });
  }
  if (tl.cutTransitions?.length) report.push({ level: "warn", text: `${tl.cutTransitions.length} transition${tl.cutTransitions.length === 1 ? " is" : "s are"} not exported; the cuts are.` });
  if (!tracks.length) report.push({ level: "warn", text: "Nothing to export: the timeline has no video or audio clips." });
  const markers = tl.markers.filter((m) => !m.clipId && m.kind !== "beat").map((m) => ({ time: m.time, name: m.name, note: m.note }));
  return { list: { name: tl.name, fps, duration, tracks, markers }, report };
}

const baseName = (s: string) => {
  let t = s;
  try {
    t = decodeURIComponent(s);
  } catch {
    /* keep as is */
  }
  return t.replace(/^file:\/\/(localhost)?/, "").split(/[\\/]/).pop() || s;
};

/** Add a timeline built from an edit list to a copy of the project. Media is matched by file name; what is missing becomes an offline item. */
export function fromEditList(doc: ProjectDoc, list: EditList): { doc: ProjectDoc; timelineId: string; report: Note[] } {
  const report: Note[] = [];
  const base = doc.timelines.find((t) => t.id === doc.activeTimelineId) ?? doc.timelines[0];
  let tl: Timeline = { id: E.newId("tl"), name: list.name || "Imported timeline", tracks: [], clips: [], markers: [], textStyle: base.textStyle, transition: base.transition };
  tl = E.addTrack(tl, "subtitle").tl;
  const media = [...doc.media];
  const offline = new Set<string>();
  const find = (name: string, kind: "video" | "audio"): MediaRef => {
    const n = baseName(name).toLowerCase();
    const hit = media.find((m) => m.name.toLowerCase() === n && (kind === "audio" ? m.kind !== "image" : m.kind !== "audio"));
    if (hit) return hit;
    const made: MediaRef = { id: E.newId("m"), name: baseName(name), kind, fileKey: "", note: "Offline: this file came with an imported edit. Relink it to play." };
    media.push(made);
    offline.add(made.name);
    return made;
  };
  for (const lt of list.tracks) {
    const added = E.addTrack(tl, lt.kind, lt.name);
    tl = added.tl;
    for (const it of lt.items) {
      const m = find(it.media, lt.kind);
      const kept = it.clip;
      const clip: Clip = {
        ...(kept ?? {}),
        id: E.newId("c"),
        trackId: added.id,
        name: it.name,
        mediaId: m.id,
        start: round(it.start),
        duration: round(it.duration),
        sourceIn: round(it.sourceIn),
        sourceOut: round(it.sourceIn + it.duration * it.speed),
        speed: it.speed,
        enabled: true,
        effects: kept?.effects ?? [],
        keyframes: kept?.keyframes ?? {},
        linkId: it.linkId,
      };
      // references to other clips or timelines of the old project mean nothing here
      delete clip.matte;
      delete clip.follow;
      delete clip.timelineId;
      delete clip.multicam;
      tl = { ...tl, clips: [...tl.clips, clip] };
    }
  }
  // a link only holds when both halves arrived
  const linkCount = new Map<string, number>();
  tl.clips.forEach((c) => c.linkId && linkCount.set(c.linkId, (linkCount.get(c.linkId) ?? 0) + 1));
  const remap = new Map<string, string>();
  tl = {
    ...tl,
    clips: tl.clips.map((c) => (c.linkId && (linkCount.get(c.linkId) ?? 0) > 1 ? { ...c, linkId: remap.get(c.linkId) ?? remap.set(c.linkId, E.newId("l")).get(c.linkId) } : { ...c, linkId: undefined })),
    markers: list.markers.map((m) => ({ id: E.newId("mk"), time: m.time, name: m.name, color: "#facc15", note: m.note })),
  };
  if (offline.size) report.push({ level: "warn", text: `${offline.size} file${offline.size === 1 ? " is" : "s are"} not in this project and show as offline: ${[...offline].slice(0, 5).join(", ")}${offline.size > 5 ? ", ..." : ""}. Import them to relink by name.` });
  report.push({ level: "info", text: `Built "${tl.name}": ${tl.clips.length} clip${tl.clips.length === 1 ? "" : "s"} on ${list.tracks.length} track${list.tracks.length === 1 ? "" : "s"}${list.markers.length ? `, ${list.markers.length} marker${list.markers.length === 1 ? "" : "s"}` : ""}.` });
  return { doc: { ...doc, media, timelines: [...doc.timelines, tl] }, timelineId: tl.id, report };
}

export function download(name: string, data: BlobPart, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
