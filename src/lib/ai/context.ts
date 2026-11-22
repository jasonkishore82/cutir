import type { Clip, ProjectDoc } from "../../model/types";
import { activeTimeline } from "../../model/convert";

/**
 * What the model is told about the timeline (phase 28): the selection, the playhead, the visible range and a compact
 * summary, not the whole project. A long edit stays short: tracks as counts, clips only near the playhead.
 */

export type ContextInput = {
  selected: string[];
  playhead: number;
  view?: { t0: number; t1: number } | null;
  /** Most clips listed, after the selected ones. */
  maxClips?: number;
  /** Extra text for the end of a clip's row (effects, keyframes). */
  extra?: (clip: Clip) => string;
};

const t1 = (n: number) => (Math.round(n * 100) / 100).toString();

export function timelineContext(doc: ProjectDoc, o: ContextInput): string {
  const tl = activeTimeline(doc);
  const clips = tl.clips.filter((c) => !c.fill && !c.text);
  const length = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const trackName = (id: string) => tl.tracks.find((t) => t.id === id)?.name ?? "?";
  const mediaName = (id?: string) => doc.media.find((m) => m.id === id)?.name ?? "";
  const row = (c: (typeof clips)[number]) => `${c.id} | ${trackName(c.trackId)} | ${t1(c.start)}-${t1(c.start + c.duration)} | ${mediaName(c.mediaId)}${c.speed !== 1 ? ` | speed ${t1(c.speed)}` : ""}${o.extra?.(c) ?? ""}`;

  const perTrack = tl.tracks
    .filter((t) => t.kind !== "subtitle")
    .map((t) => `${t.name} (${t.kind}${t.locked ? ", locked" : ""}${t.muted ? ", muted" : ""}): ${clips.filter((c) => c.trackId === t.id).length} clips`)
    .join("; ");

  const selected = o.selected.map((id) => clips.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c);
  const lines = [
    `TIMELINE: "${tl.name}", ${t1(length)}s, ${doc.settings.fps} fps, ${tl.aspect ?? doc.settings.aspect}. ${perTrack || "no tracks"}.`,
    `PLAYHEAD: ${t1(o.playhead)}s.${o.view ? ` VISIBLE: ${t1(o.view.t0)}s to ${t1(o.view.t1)}s.` : ""}${tl.inPoint !== undefined || tl.outPoint !== undefined ? ` IN/OUT: ${tl.inPoint !== undefined ? t1(tl.inPoint) : "-"} to ${tl.outPoint !== undefined ? t1(tl.outPoint) : "-"}.` : ""}`,
  ];
  if (selected.length) lines.push(`SELECTED CLIPS ("this clip", "these clips"; id | track | start-end | media):\n${selected.map(row).join("\n")}`);
  else lines.push("SELECTED CLIPS: none selected.");

  // the other clips: those in view or at the playhead first, so "the second clip" and "this one" have something to point at
  const max = o.maxClips ?? 24;
  const lo = o.view?.t0 ?? o.playhead - 15;
  const hi = o.view?.t1 ?? o.playhead + 15;
  const mid = (lo + hi) / 2;
  const chosen = new Set(selected.map((c) => c.id));
  const rest = clips
    .filter((c) => !chosen.has(c.id))
    .sort((a, b) => Number(c_in(b, lo, hi)) - Number(c_in(a, lo, hi)) || Math.abs(a.start - mid) - Math.abs(b.start - mid))
    .slice(0, max);
  rest.sort((a, b) => a.start - b.start);
  if (rest.length) lines.push(`CLIPS (id | track | start-end | media; ${rest.length} of ${clips.length - selected.length} other clips, nearest the view first):\n${rest.map(row).join("\n")}`);
  const marks = tl.markers.filter((m) => !m.kind || m.kind === "user").slice(0, 12).map((m) => `${t1(m.time)}s ${m.name}`);
  if (marks.length) lines.push(`MARKERS: ${marks.join(", ")}`);
  return lines.join("\n");
}

const c_in = (c: { start: number; duration: number }, lo: number, hi: number) => c.start < hi && c.start + c.duration > lo;
