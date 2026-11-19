import { activeTimeline } from "../model/convert";
import { transitionWindow } from "../lib/effects";
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

/** Crossfade windows on audio tracks (phase 17): which clips fade, over which span. */
function fadeWindows(tl: Timeline): { clip: string; w: [number, number]; dir: "out" | "in" }[] {
  const out: { clip: string; w: [number, number]; dir: "out" | "in" }[] = [];
  if (!tl.cutTransitions?.length) return out;
  const clips = new Map(tl.clips.map((c) => [c.id, c]));
  for (const tr of tl.cutTransitions) {
    if (tl.tracks.find((t) => t.id === tr.trackId)?.kind !== "audio") continue;
    const w = transitionWindow(tr, clips);
    if (!w) continue;
    if (tr.from) out.push({ clip: tr.from, w, dir: "out" });
    if (tr.to) out.push({ clip: tr.to, w, dir: "in" });
  }
  return out;
}

/** Gain of an audio clip at t: its volume, times an equal-power fade inside a crossfade. */
export function clipGain(tl: Timeline, c: Clip, t: number): number {
  let g = c.volume ?? 1;
  for (const f of fadeWindows(tl)) {
    if (f.clip !== c.id || t < f.w[0] || t >= f.w[1]) continue;
    const p = (t - f.w[0]) / (f.w[1] - f.w[0]);
    g *= f.dir === "out" ? Math.cos((p * Math.PI) / 2) : Math.sin((p * Math.PI) / 2);
  }
  return g;
}

/** Audio clips playing at t (excluding the lyric song, which the transport plays), including crossfade overlaps. */
export function activeAudio(tl: Timeline, t: number): Clip[] {
  const fading = new Set(fadeWindows(tl).filter((f) => t >= f.w[0] && t < f.w[1]).map((f) => f.clip));
  return tl.clips.filter((c) => !c.fill && c.mediaId && audible(tl, c) && ((t >= c.start && t < c.start + c.duration) || fading.has(c.id)));
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
      el.volume = Math.max(0, Math.min(1, clipGain(tl, c, t)));
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

/** One clip in the export mix. `fades` are linear gain ramps (crossfades) in timeline seconds. */
export type MixInput = { url: string; start: number; duration: number; sourceIn: number; speed: number; volume: number; fades?: { from: number; to: number; dir: "in" | "out" }[] };

/** Clips that make up the exported sound: the song (when heard) and every audible audio clip. */
export function mixInputs(doc: ProjectDoc, songUrl: string | undefined, length: number, urlOf: (mediaId: string) => string | undefined): MixInput[] {
  const tl = activeTimeline(doc);
  const out: MixInput[] = [];
  const windows = fadeWindows(tl);
  if (songUrl && songAudible(doc)) out.push({ url: songUrl, start: 0, duration: length, sourceIn: 0, speed: 1, volume: 1 });
  for (const c of tl.clips) {
    if (c.fill || !c.mediaId || !audible(tl, c)) continue;
    const url = urlOf(c.mediaId);
    if (!url) continue;
    // a crossfade extends the clip into its neighbour's side of the cut
    const fades = windows.filter((f) => f.clip === c.id);
    const start = Math.min(c.start, ...fades.map((f) => f.w[0]));
    const end = Math.max(c.start + c.duration, ...fades.map((f) => f.w[1]));
    if (start >= length) continue;
    const s0 = Math.max(0, start);
    out.push({
      url,
      start: s0,
      duration: Math.min(end, length) - s0,
      sourceIn: Math.max(0, c.sourceIn + (s0 - c.start) * c.speed),
      speed: c.speed,
      volume: c.volume ?? 1,
      ...(fades.length ? { fades: fades.map((f) => ({ from: f.w[0], to: f.w[1], dir: f.dir })) } : {}),
    });
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
    for (const f of i.fades ?? []) {
      // linear ramps through the crossfade window
      gain.gain.setValueAtTime(f.dir === "out" ? i.volume : 0, f.from);
      gain.gain.linearRampToValueAtTime(f.dir === "out" ? 0 : i.volume, f.to);
    }
    src.connect(gain).connect(ctx.destination);
    src.start(i.start, i.sourceIn, i.duration * i.speed);
  }
  return ctx.startRendering();
}
