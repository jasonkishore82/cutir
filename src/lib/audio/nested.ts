import type { Clip, ProjectDoc, Timeline } from "../../model/types";

/**
 * Sound inside nested clips for the live mixer (phase 23). A nested clip plays another timeline; its audio clips are
 * moved onto the host timeline as stand-in clips (placed, trimmed and sped by the nested clip's window and speed), so
 * the live mixer plays them like any others: sample-accurate, with the strip of the host track the sound goes through.
 * The export does the same with `nestedInputs`.
 */

export const NEST_SOUND_DEPTH = 4;

/**
 * `host` with the sound of its nested clips added as stand-in audio clips (ids `<nested>><inner>`). `isAudible` says
 * whether an audio clip on a timeline can be heard (track not muted, solo respected); `soundTrack` picks the host
 * track the nested sound goes through. Clips that cannot be mapped exactly (a ramped or reversed nested clip, a
 * ramped or reversed inner clip under a changed speed or trim) are left out: the export has them.
 */
export function withNestedSound(doc: ProjectDoc, host: Timeline, isAudible: (tl: Timeline, c: Clip) => boolean, soundTrack: (tl: Timeline, c: Clip) => string, depth = 0): Timeline {
  const nests = host.clips.filter((c) => c.timelineId && c.enabled && !c.fill);
  if (!nests.length || depth >= NEST_SOUND_DEPTH) return host;
  const extra: Clip[] = [];
  for (const c of nests) {
    const nested = doc.timelines.find((x) => x.id === c.timelineId);
    if (!nested || c.ramp?.keys.length || c.reverse) continue;
    // the inner timeline with its own nested sound resolved first (so nesting inside nesting works)
    const inner = withNestedSound(doc, nested, isAudible, soundTrack, depth + 1);
    const win0 = c.sourceIn;
    const win1 = c.sourceIn + c.duration * c.speed;
    const map = (tn: number) => c.start + (tn - win0) / c.speed;
    const trackId = soundTrack(host, c);
    for (const i of inner.clips) {
      if (i.fill || !i.mediaId || i.multicam || !isAudible(inner, i)) continue;
      const a = Math.max(i.start, win0);
      const b = Math.min(i.start + i.duration, win1);
      if (b - a <= 1e-3) continue;
      const trimmed = a > i.start + 1e-6 || b < i.start + i.duration - 1e-6;
      if ((i.ramp?.keys.length || i.reverse) && (trimmed || c.speed !== 1)) continue;
      const speed = i.speed * c.speed;
      extra.push({
        ...i,
        id: `${c.id}>${i.id}`,
        trackId,
        start: map(a),
        duration: (b - a) / c.speed,
        sourceIn: i.reverse || i.ramp?.keys.length ? i.sourceIn : i.sourceIn + (a - i.start) * i.speed,
        sourceOut: i.reverse || i.ramp?.keys.length ? i.sourceOut : i.sourceIn + (b - i.start) * i.speed,
        speed,
        // the inner track's own level carries over (its pan and processors do not: the stand-in goes through the host strip)
        volume: (i.volume ?? 1) * (c.volume ?? 1) * (inner.tracks.find((x) => x.id === i.trackId)?.gain ?? 1),
        fadeIn: a <= i.start + 1e-6 && i.fadeIn ? i.fadeIn / c.speed : undefined,
        fadeOut: b >= i.start + i.duration - 1e-6 && i.fadeOut ? i.fadeOut / c.speed : undefined,
        anim: undefined,
        linkId: undefined,
        timelineId: undefined,
      } as Clip);
    }
  }
  return extra.length ? { ...host, clips: [...host.clips, ...extra] } : host;
}
