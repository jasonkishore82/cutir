import { activeTimeline } from "../model/convert";
import type { Clip, ProjectDoc, Timeline } from "../model/types";

/**
 * Sound of the timeline's audio tracks in the viewer.
 *
 * The song (the lyric project's audio, played by the transport) is the master clock. Every other audio clip under the
 * playhead plays through its own media element, started at the right source time and nudged back whenever it drifts
 * from the clock. Nothing plays while scrubbing (paused), so seeking never makes noise.
 *
 * Export does not use this: it mixes the same clips offline (see mixdown), with the same audibility rules.
 */

/** Whether a clip on an audio track is heard: track not muted, and if any audio track is soloed, its track is. */
export function audible(tl: Timeline, c: Clip): boolean {
  const track = tl.tracks.find((t) => t.id === c.trackId);
  if (!track || track.kind !== "audio" || !c.enabled) return false;
  const anySolo = tl.tracks.some((t) => t.kind === "audio" && t.solo);
  return !track.muted && !track.hidden && (!anySolo || track.solo);
}

/** Audio clips playing at t (excluding the lyric song, which the transport plays). */
export function activeAudio(tl: Timeline, t: number): Clip[] {
  return tl.clips.filter((c) => !c.fill && c.mediaId && audible(tl, c) && t >= c.start && t < c.start + c.duration);
}

/** Whether the lyric song should be heard (its track can be muted or left out by a solo). */
export function songAudible(doc: ProjectDoc): boolean {
  const tl = activeTimeline(doc);
  const song = tl.clips.find((c) => c.fill && tl.tracks.find((t) => t.id === c.trackId)?.kind === "audio");
  return song ? audible(tl, song) : true;
}

const DRIFT = 0.08; // seconds before a clip is put back in step with the clock

export class AudioMixer {
  private els = new Map<string, HTMLAudioElement>();
  private urlOf: (mediaId: string) => string | undefined;

  constructor(urlOf: (mediaId: string) => string | undefined) {
    this.urlOf = urlOf;
  }

  /** Call once per frame with the clock time, whether the transport is playing and its rate. */
  update(doc: ProjectDoc, t: number, playing: boolean, rate: number) {
    const tl = activeTimeline(doc);
    const live = playing && rate > 0 ? activeAudio(tl, t) : [];
    const keep = new Set(live.map((c) => c.id));
    for (const [id, el] of this.els) {
      if (keep.has(id)) continue;
      el.pause();
      if (!tl.clips.some((c) => c.id === id)) {
        el.removeAttribute("src");
        el.load();
        this.els.delete(id);
      }
    }
    for (const c of live) {
      const url = this.urlOf(c.mediaId!);
      if (!url) continue;
      let el = this.els.get(c.id);
      if (!el) {
        el = new Audio();
        el.preload = "auto";
        el.src = url;
        this.els.set(c.id, el);
      } else if (el.src !== url) el.src = url;
      const target = c.sourceIn + (t - c.start) * c.speed;
      el.volume = Math.max(0, Math.min(1, c.volume ?? 1));
      const r = Math.max(0.0625, Math.min(16, c.speed * rate));
      if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
      if (el.paused || Math.abs(el.currentTime - target) > DRIFT) {
        try {
          el.currentTime = Math.max(0, target);
        } catch {
          /* not seekable yet */
        }
      }
      if (el.paused) void el.play().catch(() => {});
    }
  }

  stop() {
    for (const el of this.els.values()) el.pause();
  }

  dispose() {
    for (const el of this.els.values()) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    this.els.clear();
  }
}

/* ---------- offline mix for export ---------- */

export type MixInput = { url: string; start: number; duration: number; sourceIn: number; speed: number; volume: number };

/** Clips that make up the exported sound: the song (when heard) and every audible audio clip. */
export function mixInputs(doc: ProjectDoc, songUrl: string | undefined, length: number, urlOf: (mediaId: string) => string | undefined): MixInput[] {
  const tl = activeTimeline(doc);
  const out: MixInput[] = [];
  if (songUrl && songAudible(doc)) out.push({ url: songUrl, start: 0, duration: length, sourceIn: 0, speed: 1, volume: 1 });
  for (const c of tl.clips) {
    if (c.fill || !c.mediaId || !audible(tl, c)) continue;
    const url = urlOf(c.mediaId);
    if (url && c.start < length) out.push({ url, start: c.start, duration: Math.min(c.duration, length - c.start), sourceIn: c.sourceIn, speed: c.speed, volume: c.volume ?? 1 });
  }
  return out;
}

/** Render the inputs into one stereo buffer of `length` seconds. Files used by several clips are decoded once. */
export async function mixdown(inputs: MixInput[], length: number, sampleRate = 48000, signal?: AbortSignal): Promise<AudioBuffer | null> {
  if (!inputs.length || length <= 0) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(length * sampleRate), sampleRate);
  const decoded = new Map<string, AudioBuffer>();
  for (const i of inputs) {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    if (!decoded.has(i.url)) {
      try {
        const data = await (await fetch(i.url)).arrayBuffer();
        decoded.set(i.url, await ctx.decodeAudioData(data));
      } catch {
        continue; // a file without readable sound (e.g. a silent video) adds nothing
      }
    }
    const buf = decoded.get(i.url)!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = i.speed;
    const gain = ctx.createGain();
    gain.gain.value = i.volume;
    src.connect(gain).connect(ctx.destination);
    src.start(i.start, i.sourceIn, i.duration * i.speed);
  }
  return ctx.startRendering();
}
