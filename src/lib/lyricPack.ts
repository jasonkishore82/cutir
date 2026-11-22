import type { Clip, TitleSpec, Timeline } from "../model/types";
import { addTrack, newId } from "../timeline/engine";
import { DEFAULT_ANIMATOR, titleOf } from "./titles";

/**
 * The lyric pack (phase 19). Lyric mode binds a subtitle track (the lines you synced with tap-sync, or imported from an
 * LRC/SRT file) to the title engine's text animator: every line becomes a title clip with the same words, start and
 * length, drawn with a pack's look and animation. The subtitle track stays as the timing source, switched off in the
 * picture; converting again after a retime replaces the generated clips, so the titles follow the sync.
 */

export type LyricPack = {
  id: string;
  name: string;
  description: string;
  look: Partial<TitleSpec>;
  animator: { preset: TitleSpec["animator"]["preset"]; unit: TitleSpec["animator"]["unit"]; /** Seconds the sweep takes at most. */ duration: number; /** Share of the line's length the sweep may use. */ share: number; outDuration: number };
};

const BASE: Partial<TitleSpec> = { size: 0.07, x: 0.5, y: 0.82, width: 0.86, align: "center", autoFit: true, weight: 800, stroke: "#000000", strokeWidth: 0.004, shadow: true, shadowBlur: 0.012 };

export const LYRIC_PACKS: LyricPack[] = [
  { id: "karaoke", name: "Karaoke fill", description: "Words fill with gold across the line, like a karaoke screen", look: { ...BASE, color: "#ffd84a", color2: "#ffffff", gradient: false }, animator: { preset: "karaoke-fill", unit: "word", duration: 4, share: 0.9, outDuration: 0.2 } },
  { id: "word-pop", name: "Word pop", description: "Each word pops in as the line starts", look: { ...BASE, font: "Anton", weight: 400, size: 0.09, y: 0.5, color: "#ffffff" }, animator: { preset: "word-pop", unit: "word", duration: 1.2, share: 0.6, outDuration: 0.15 } },
  { id: "typewriter", name: "Typewriter", description: "Letters appear one after another", look: { ...BASE, font: "Courier New", weight: 700, color: "#f2f2f2", align: "left", x: 0.5 }, animator: { preset: "typewriter", unit: "char", duration: 3, share: 0.8, outDuration: 0 } },
  { id: "wave", name: "Wave", description: "Letters ripple in", look: { ...BASE, color: "#8be9fd" }, animator: { preset: "wave", unit: "char", duration: 2, share: 0.7, outDuration: 0.2 } },
  { id: "blur-in", name: "Blur in", description: "Soft focus pull, letter by letter", look: { ...BASE, weight: 500, size: 0.06, color: "#f5f5f5" }, animator: { preset: "blur-in", unit: "char", duration: 1.2, share: 0.5, outDuration: 0.3 } },
  { id: "line-slide", name: "Line slide", description: "Each line slides up into place", look: { ...BASE, weight: 600, color: "#ffffff" }, animator: { preset: "line-slide", unit: "line", duration: 0.7, share: 0.4, outDuration: 0.25 } },
];

export const packById = (id: string) => LYRIC_PACKS.find((p) => p.id === id);

const PREFIX = "Lyrics";
/** A generated track and its clips are recognised by this name, so converting again replaces them. */
export const trackName = (p: LyricPack) => `${PREFIX}: ${p.name}`;
const isGenerated = (name: string | undefined) => !!name && name.startsWith(`${PREFIX}: `);

/** The title for one line. The sweep takes at most `animator.duration` and at most `share` of the line's length. */
export function lineTitle(text: string, duration: number, pack: LyricPack): TitleSpec {
  const sweep = Math.max(0.1, Math.min(pack.animator.duration, duration * pack.animator.share));
  return titleOf({
    ...pack.look,
    text,
    runs: [],
    animator: { ...DEFAULT_ANIMATOR, preset: pack.animator.preset, unit: pack.animator.unit, duration: sweep, outDuration: Math.min(pack.animator.outDuration, duration / 3) },
  });
}

/** Subtitle (or any text) clips of a track, in time order. Blank lines are skipped. */
export const lyricClips = (tl: Timeline, trackId: string): Clip[] => tl.clips.filter((c) => c.trackId === trackId && c.text?.text?.trim()).sort((a, b) => a.start - b.start);

export type LyricResult = { tl: Timeline; created: number; trackId: string };

/**
 * Turn the lines of a subtitle track into title clips on a video track named after the pack. The source lines are
 * switched off so they are not drawn twice; they stay as the timing source. Converting again (a new pack, or after a
 * retime) replaces the generated clips and switches the source lines off again.
 */
export function lyricsToTitles(tl: Timeline, sourceTrackId: string, pack: LyricPack): LyricResult {
  const source = tl.tracks.find((t) => t.id === sourceTrackId);
  if (!source) throw new Error("that track does not exist");
  if (source.kind !== "subtitle") throw new Error(`"${source.name}" is not a subtitle track. Pick the track that holds the lyrics.`);
  const lines = lyricClips(tl, sourceTrackId);
  if (!lines.length) throw new Error(`"${source.name}" has no lines yet. Sync or import the lyrics first.`);

  // reuse the track made by an earlier conversion of this source, whatever pack it used
  const marker = source.id;
  let cur = tl;
  let target = cur.tracks.find((t) => t.lyricsOf === marker);
  if (!target) {
    const r = addTrack(cur, "video");
    cur = r.tl;
    target = cur.tracks.find((t) => t.id === r.id)!;
  }
  const targetId = target.id;
  cur = {
    ...cur,
    tracks: cur.tracks.map((t) => (t.id === targetId ? { ...t, name: trackName(pack), lyricsOf: marker } : t)),
    // drop earlier generated clips, keep anything the user added on that track by hand
    clips: cur.clips.filter((c) => !(c.trackId === targetId && isGenerated(c.name))),
  };

  const made: Clip[] = lines.map((l) => ({
    id: newId("c"),
    trackId: targetId,
    name: `${PREFIX}: ${l.text!.text.replace(/\s+/g, " ").slice(0, 24)}`,
    start: l.start,
    duration: l.duration,
    sourceIn: 0,
    sourceOut: l.duration,
    speed: 1,
    enabled: true,
    effects: [],
    keyframes: {},
    generator: { type: "title", title: lineTitle(l.text!.text, l.duration, pack) },
  }));
  const lineIds = new Set(lines.map((l) => l.id));
  cur = { ...cur, clips: [...cur.clips.map((c) => (lineIds.has(c.id) ? { ...c, enabled: false } : c)), ...made] };
  return { tl: cur, created: made.length, trackId: targetId };
}

/** Give the lines their own picture back and remove the generated titles. */
export function removeLyricTitles(tl: Timeline, sourceTrackId: string): Timeline {
  const gen = tl.tracks.filter((t) => t.lyricsOf === sourceTrackId).map((t) => t.id);
  if (!gen.length) return tl;
  return {
    ...tl,
    clips: tl.clips.filter((c) => !(gen.includes(c.trackId) && isGenerated(c.name))).map((c) => (c.trackId === sourceTrackId ? { ...c, enabled: true } : c)),
  };
}
