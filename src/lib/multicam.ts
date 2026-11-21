/** Multicam (phase 24): which angle is on at a time, recording cuts, the sound that goes with them, and beat-driven assembly. Pure functions. */
import type { MulticamAngle, MulticamCut, MulticamSpec } from "../model/types";

/** The cut in force at multicam time `mt` (the last one at or before it; the first angle before any cut). */
export function activeCut(spec: MulticamSpec, mt: number): MulticamCut {
  let cur: MulticamCut = { t: 0, video: spec.angles[0]?.id ?? "" };
  for (const c of [...spec.cuts].sort((a, b) => a.t - b.t)) {
    if (c.t <= mt + 1e-9) cur = c;
    else break;
  }
  return cur;
}

export const angleOf = (spec: MulticamSpec, id: string | undefined): MulticamAngle | undefined => spec.angles.find((a) => a.id === id) ?? spec.angles[0];

/** The angle showing at multicam time `mt` and the source time to read from it. */
export function videoAt(spec: MulticamSpec, mt: number): { angle: MulticamAngle; st: number } | null {
  const a = angleOf(spec, activeCut(spec, mt).video);
  return a ? { angle: a, st: Math.max(0, mt + a.offset) } : null;
}

/** Switch to an angle at multicam time `mt`. A cut at (nearly) the same time is replaced; `eraseAfter` drops later cuts (recording over them). */
export function addCut(spec: MulticamSpec, mt: number, video: string, audio?: string, eraseAfter = false): MulticamSpec {
  const t = Math.max(0, Math.round(mt * 1000) / 1000);
  const keep = spec.cuts.filter((c) => Math.abs(c.t - t) > 0.02 && (!eraseAfter || c.t < t));
  // if the angle already showing is the one being cut to, there is nothing to record
  const cur = activeCut({ ...spec, cuts: keep }, t);
  const same = cur.video === video && (cur.audio ?? undefined) === audio && keep.length > 0;
  const cuts = same ? keep : [...keep, { t, video, ...(audio ? { audio } : {}) }];
  return { ...spec, cuts: cuts.sort((a, b) => a.t - b.t) };
}

export const removeCut = (spec: MulticamSpec, index: number): MulticamSpec => ({ ...spec, cuts: spec.cuts.filter((_, i) => i !== index) });

/** Pull a time toward the nearest beat when one is within `tolerance` seconds. */
export function snapToBeats(t: number, beats: number[], tolerance: number): number {
  let best = t;
  let d = tolerance;
  for (const b of beats) {
    const e = Math.abs(b - t);
    if (e <= d) (d = e), (best = b);
  }
  return best;
}

export type Segment = { from: number; to: number; angle: string };

/** The stretches of multicam time between cuts, up to `length` (seconds of multicam time from `start`). */
export function segments(spec: MulticamSpec, start: number, length: number): Segment[] {
  const end = start + length;
  const marks = [start, ...spec.cuts.map((c) => c.t).filter((t) => t > start + 1e-6 && t < end - 1e-6), end].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 1; i < marks.length; i++) {
    if (marks[i] - marks[i - 1] < 1e-4) continue;
    out.push({ from: marks[i - 1], to: marks[i], angle: activeCut(spec, marks[i - 1]).video });
  }
  return out;
}

/** Distinct colour for an angle (by its place in the clip), shared by the timeline strip and the angle viewer. */
export const angleColor = (spec: MulticamSpec, id: string | undefined) => `hsl(${(Math.max(0, spec.angles.findIndex((a) => a.id === id)) * 67 + 200) % 360} 65% 55%)`;

/** The stretches of a multicam clip as drawn on the timeline: seconds from the clip's start, the angle, its number and colour. Empty for a retimed (ramped) clip. */
export function cutStrip(spec: MulticamSpec, clip: { sourceIn: number; duration: number; speed: number; ramp?: unknown }): { from: number; to: number; name: string; number: number; color: string; audioOnly?: string }[] {
  if (clip.ramp) return [];
  return segments(spec, clip.sourceIn, clip.duration * clip.speed).map((s) => {
    const cut = activeCut(spec, s.from);
    const a = angleOf(spec, s.angle);
    const sound = cut.audio && cut.audio !== cut.video ? angleOf(spec, cut.audio)?.name : undefined;
    return { from: (s.from - clip.sourceIn) / clip.speed, to: (s.to - clip.sourceIn) / clip.speed, name: a?.name ?? "", number: spec.angles.findIndex((x) => x.id === s.angle) + 1, color: angleColor(spec, s.angle), ...(sound ? { audioOnly: sound } : {}) };
  });
}

export type SoundSegment = { from: number; to: number; /** An angle's media, or the separate recorder. */ mediaId: string; /** Add to multicam time for the media's source time. */ offset: number; /** Seconds of multicam time this stretch fades in over (a crossfade from the stretch before). */ fadeIn?: number; fadeOut?: number };

export const DEFAULT_CROSSFADE = 0.12;

/** Where the sound comes from for each stretch: the cut's audio angle, else the separate recorder (when there is one), else the video angle. */
export function soundSegments(spec: MulticamSpec, start: number, length: number, crossfade = 0): SoundSegment[] {
  const out: SoundSegment[] = [];
  const end = start + length;
  const marks = [start, ...spec.cuts.map((c) => c.t).filter((t) => t > start + 1e-6 && t < end - 1e-6), end].sort((a, b) => a - b);
  for (let i = 1; i < marks.length; i++) {
    if (marks[i] - marks[i - 1] < 1e-4) continue;
    const cut = activeCut(spec, marks[i - 1]);
    let mediaId: string | undefined;
    let offset = 0;
    if (cut.audio) {
      const a = angleOf(spec, cut.audio);
      mediaId = a?.mediaId;
      offset = a?.offset ?? 0;
    } else if (spec.audioMediaId) {
      mediaId = spec.audioMediaId;
      offset = spec.audioOffset ?? 0;
    } else {
      const a = angleOf(spec, cut.video);
      mediaId = a?.mediaId;
      offset = a?.offset ?? 0;
    }
    if (!mediaId) continue;
    const prev = out[out.length - 1];
    if (prev && prev.mediaId === mediaId && prev.offset === offset && Math.abs(prev.to - marks[i - 1]) < 1e-6) prev.to = marks[i];
    else out.push({ from: marks[i - 1], to: marks[i], mediaId, offset });
  }
  // a crossfade straddles each change of source: the one before runs on a little, the next starts a little early
  if (crossfade > 0) {
    const len = out.map((s) => s.to - s.from);
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1], b = out[i];
      if (Math.abs(a.to - b.from) > 1e-6) continue;
      const h = Math.min(crossfade / 2, len[i - 1] / 2, len[i] / 2);
      if (h <= 1e-4) continue;
      a.to += h;
      a.fadeOut = 2 * h;
      b.from -= h;
      b.fadeIn = 2 * h;
    }
  }
  return out;
}

/** The crossfade length a multicam clip uses. */
export const crossfadeOf = (spec: MulticamSpec) => Math.max(0, Math.min(2, spec.crossfade ?? DEFAULT_CROSSFADE));

/* ---------- beat montage ---------- */

export type MontageSource = { mediaId: string; duration: number };
export type MontageCut = { start: number; duration: number; mediaId: string; sourceIn: number };

/**
 * A first-draft montage: one clip per `beatsPerCut` beats between `from` and `to`, taking the sources in turn and
 * moving through each one so repeats show new material. Cuts land exactly on beats.
 */
export function montagePlan(beats: number[], sources: MontageSource[], o: { beatsPerCut?: number; from?: number; to?: number } = {}): MontageCut[] {
  const per = Math.max(1, Math.round(o.beatsPerCut ?? 4));
  const from = o.from ?? 0;
  const to = o.to ?? Infinity;
  const b = beats.filter((t) => t >= from - 1e-6 && t <= to + 1e-6).sort((x, y) => x - y);
  if (b.length < per + 1 || !sources.length) return [];
  const used = new Map<string, number>();
  const out: MontageCut[] = [];
  let s = 0;
  for (let i = 0; i + per < b.length; i += per) {
    const start = b[i];
    const duration = b[i + per] - start;
    if (duration <= 0.05) continue;
    const src = sources[s % sources.length];
    s++;
    if (src.duration < duration) continue; // too short for this slot
    let at = used.get(src.mediaId) ?? 0;
    if (at + duration > src.duration) at = 0; // wrap round
    used.set(src.mediaId, at + duration);
    out.push({ start, duration, mediaId: src.mediaId, sourceIn: at });
  }
  return out;
}
