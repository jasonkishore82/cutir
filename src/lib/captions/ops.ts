/**
 * Captions on the document (phase 25): lines of a lyric layer as cues and back, adding caption tracks, and cutting
 * time out of the whole timeline (picture, sound and every caption track) so deleting words deletes what is said.
 */
import type { ProjectDoc, Clip, Timeline } from "../../model/types";
import { activeTimeline } from "../../model/convert";
import * as E from "../../timeline/engine";
import { uid, type Layer, type LyricLine, type Project } from "../../store/project";
import type { Cue } from "./cues";
import { applyCutsToCues, mergeRanges, type Range } from "./transcript";

const tidy = (n: number) => Math.round(n * 1000) / 1000;

export const linesToCues = (lines: LyricLine[]): Cue[] =>
  [...lines].sort((a, b) => a.start - b.start).map((l) => ({ start: l.start, end: l.end, text: l.text, ...(l.words?.length ? { words: l.words } : {}), ...(l.speaker ? { speaker: l.speaker } : {}) }));

/** Lines for cues on a layer. Where a line already exists at the same place in order, its id and look are kept. */
export function cuesToLines(cues: Cue[], layerId: string, previous: LyricLine[] = []): LyricLine[] {
  const old = [...previous].sort((a, b) => a.start - b.start);
  return cues.map((c, i) => {
    const keep = old.length === cues.length ? old[i] : undefined;
    const line: LyricLine = { id: keep?.id ?? uid(), text: c.text.replace(/\n/g, " "), start: tidy(c.start), end: tidy(c.end), layerId };
    if (c.words?.length) line.words = c.words.map((w) => ({ text: w.text, start: tidy(w.start), end: tidy(w.end) }));
    if (c.speaker) line.speaker = c.speaker;
    if (keep?.styleOverride) line.styleOverride = keep.styleOverride;
    if (keep?.transition) line.transition = keep.transition;
    return line;
  });
}

/** A project with `cues` as the lines of a layer (made if it does not exist). */
export function withLayerCues(p: Project, layerId: string, cues: Cue[], layer?: Partial<Layer>): Project {
  const exists = p.layers.some((l) => l.id === layerId);
  const layers = exists ? p.layers.map((l) => (l.id === layerId ? { ...l, ...layer } : l)) : [...p.layers, { id: layerId, name: "Captions", visible: true, locked: false, ...layer } as Layer];
  const old = p.lines.filter((l) => (l.layerId ?? p.layers[0].id) === layerId);
  const others = p.lines.filter((l) => (l.layerId ?? p.layers[0].id) !== layerId);
  const lines = [...others, ...cuesToLines(cues, layerId, old)];
  // keep lines grouped by layer, in layer order
  const rank = new Map(layers.map((l, i) => [l.id, i]));
  return { ...p, layers, lines: lines.sort((a, b) => (rank.get(a.layerId ?? layers[0].id) ?? 0) - (rank.get(b.layerId ?? layers[0].id) ?? 0)) };
}

/** Subtitle tracks of the active timeline, in layer order. */
export const captionTracks = (tl: Timeline) => tl.tracks.filter((t) => t.kind === "subtitle");

/**
 * Take `ranges` of time out of the timeline: picture and sound tracks are rippled (the gap closes) and every caption
 * track follows, losing the words that were in the cut. `picture` false leaves picture and sound alone and cuts only the captions.
 */
export function cutDoc(doc: ProjectDoc, ranges: Range[], o: { picture?: boolean } = {}): ProjectDoc {
  const rs = mergeRanges(ranges, 0);
  if (!rs.length) return doc;
  const picture = o.picture ?? true;
  return E.onActive(doc, (tl0) => {
    let tl = tl0;
    if (picture) {
      const media = tl.tracks.filter((t) => t.kind !== "subtitle").map((t) => t.id);
      // latest first, so earlier ranges are still where they were measured
      for (const r of [...rs].reverse()) tl = E.extractRange(tl, r.start, r.end, media);
    }
    const subtitle = new Set(captionTracks(tl).filter((t) => !t.locked).map((t) => t.id));
    const clips: Clip[] = [];
    for (const c of tl.clips) {
      if (!c.text || !subtitle.has(c.trackId)) {
        clips.push(c);
        continue;
      }
      const cue: Cue = { start: c.start, end: c.start + c.duration, text: c.text.text, ...(c.text.words?.length ? { words: c.text.words } : {}) };
      const [res] = applyCutsToCues([cue], rs);
      if (!res) continue; // cut away entirely
      clips.push({ ...c, start: tidy(res.start), duration: tidy(res.end - res.start), text: { ...c.text, text: res.text, ...(res.words ? { words: res.words.map((w) => ({ text: w.text, start: tidy(w.start), end: tidy(w.end) })) } : {}) } });
    }
    return { ...tl, clips };
  });
}

/** The length of the active timeline in seconds (picture, sound and captions). */
export const timelineLength = (doc: ProjectDoc) => {
  const tl = activeTimeline(doc);
  return tl.clips.reduce((m, c) => (c.fill ? m : Math.max(m, c.start + c.duration)), 0);
};
