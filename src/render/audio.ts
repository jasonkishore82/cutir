import { activeTimeline } from "../model/convert";
import { transitionWindow } from "../lib/effects";
import { evalNumber, type Key } from "../lib/keyframes/engine";
import type { Clip, MasterStrip, ProjectDoc, Timeline, Track } from "../model/types";
import { mixTracks, type MasterMix, type TrackMix } from "../lib/audio/mix";
import { PROCESSORS, dbToGain, filterBands, type AudioProcessor, type Channels } from "../lib/audio/dsp";

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

/** The clip's own fade-in and fade-out at timeline time t, 0..1 (equal power). */
export function clipFade(c: Clip, t: number): number {
  let f = 1;
  const rel = t - c.start;
  if (c.fadeIn && rel < c.fadeIn) f *= Math.sin((Math.max(0, rel) / c.fadeIn) * (Math.PI / 2));
  const left = c.start + c.duration - t;
  if (c.fadeOut && left < c.fadeOut) f *= Math.sin((Math.max(0, left) / c.fadeOut) * (Math.PI / 2));
  return f;
}

/** Gain of an audio clip at t: its volume, times an equal-power fade inside a crossfade. */
export function clipGain(tl: Timeline, c: Clip, t: number): number {
  let g = c.anim?.volume?.length ? evalNumber(c.anim.volume as Key[], t - c.start, c.volume ?? 1) : c.volume ?? 1;
  g *= clipFade(c, t);
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

/** One mixer strip in the live graph: clips and the song feed `input`; then the processors, gain, pan and a meter. */
type LiveStrip = { input: GainNode; chain: AudioNode[]; gain: GainNode; pan: StereoPannerNode; meter: AnalyserNode; key: string };
export type Meter = { peak: number };

/** The live version of a processor chain: only the processors that map onto Web Audio nodes (see PROCESSORS[...].live). */
function liveNodes(ctx: BaseAudioContext, list: AudioProcessor[] | undefined): AudioNode[] {
  const out: AudioNode[] = [];
  for (const p of list ?? []) {
    if (!p.enabled) continue;
    if (p.type === "eq" || p.type === "highpass" || p.type === "lowpass") {
      for (const b of filterBands(p, ctx.sampleRate)) {
        const f = ctx.createBiquadFilter();
        f.type = b.type as BiquadFilterType;
        f.frequency.value = b.freq;
        f.Q.value = b.q;
        f.gain.value = b.gain;
        out.push(f);
      }
    } else if (p.type === "compressor" || p.type === "limiter") {
      const v = (k: string) => p.params[k] ?? PROCESSORS[p.type].params.find((s) => s.key === k)?.default ?? 0;
      const c = ctx.createDynamicsCompressor();
      if (p.type === "limiter") {
        c.threshold.value = v("ceiling");
        c.knee.value = 0;
        c.ratio.value = 20;
        c.attack.value = 0.001;
        c.release.value = v("release") / 1000;
        out.push(c);
      } else {
        c.threshold.value = v("threshold");
        c.knee.value = v("knee");
        c.ratio.value = v("ratio");
        c.attack.value = v("attack") / 1000;
        c.release.value = v("release") / 1000;
        out.push(c);
        const mk = ctx.createGain();
        mk.gain.value = dbToGain(v("makeup"));
        out.push(mk);
      }
    }
  }
  return out;
}

export class AudioMixer {
  private els = new Map<string, HTMLAudioElement>();
  private srcNodes = new Map<string, { node: MediaElementAudioSourceNode; gain: GainNode; to?: LiveStrip }>();
  private urlOf: (mediaId: string) => string | undefined;
  private song: HTMLAudioElement | null;
  private ctx: AudioContext | null = null;
  private master: { input: GainNode; chain: AudioNode[]; meter: AnalyserNode; key: string } | null = null;
  private strips = new Map<string, LiveStrip>();
  private songNode: { node: MediaElementAudioSourceNode; to?: LiveStrip } | null = null;
  private buf = new Float32Array(1024);

  /** `song` is the transport's audio element: it goes through the mixer too, so its track strip, meter and master apply. */
  constructor(urlOf: (mediaId: string) => string | undefined, song: HTMLAudioElement | null = null) {
    this.urlOf = urlOf;
    this.song = song;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext();
    } catch {
      return null;
    }
    const input = this.ctx.createGain();
    const meter = this.ctx.createAnalyser();
    meter.fftSize = 1024;
    input.connect(meter).connect(this.ctx.destination);
    this.master = { input, chain: [], meter, key: "" };
    return this.ctx;
  }

  private strip(id: string): LiveStrip | null {
    const ctx = this.context();
    if (!ctx || !this.master) return null;
    let s = this.strips.get(id);
    if (!s) {
      const meter = ctx.createAnalyser();
      meter.fftSize = 1024;
      s = { input: ctx.createGain(), chain: [], gain: ctx.createGain(), pan: ctx.createStereoPanner(), meter, key: "\0" };
      this.strips.set(id, s);
    }
    return s;
  }

  /** Reconnect a strip when its processors changed. */
  private wire(s: LiveStrip, list: AudioProcessor[] | undefined) {
    const key = JSON.stringify(list ?? []);
    if (key === s.key) return;
    s.key = key;
    s.input.disconnect();
    for (const n of s.chain) n.disconnect();
    s.gain.disconnect();
    s.pan.disconnect();
    s.meter.disconnect();
    s.chain = liveNodes(this.ctx!, list);
    let prev: AudioNode = s.input;
    for (const n of s.chain) (prev.connect(n), (prev = n));
    prev.connect(s.gain);
    s.gain.connect(s.pan);
    s.pan.connect(s.meter);
    s.meter.connect(this.master!.input);
  }

  private wireMaster(m: MasterStrip | undefined) {
    const master = this.master!;
    const key = JSON.stringify(m ?? {});
    master.input.gain.value = dbToGain(m?.gainDb ?? 0);
    if (key === master.key) return;
    master.key = key;
    master.input.disconnect();
    for (const n of master.chain) n.disconnect();
    master.chain = [];
    let prev: AudioNode = master.input;
    if (m?.ceiling !== undefined) {
      const lim = this.ctx!.createDynamicsCompressor();
      lim.threshold.value = m.ceiling;
      lim.knee.value = 0;
      lim.ratio.value = 20;
      lim.attack.value = 0.001;
      lim.release.value = 0.08;
      master.chain.push(lim);
      prev = prev.connect(lim);
    }
    prev.connect(master.meter);
  }

  /** Peak level 0..1 (and above) of every strip and the master, read from the live graph. */
  levels(): { master: Meter; tracks: Map<string, Meter> } {
    const read = (a: AnalyserNode): Meter => {
      a.getFloatTimeDomainData(this.buf);
      let p = 0;
      for (let i = 0; i < this.buf.length; i++) p = Math.max(p, Math.abs(this.buf[i]));
      return { peak: p };
    };
    const tracks = new Map<string, Meter>();
    for (const [id, s] of this.strips) tracks.set(id, read(s.meter));
    return { master: this.master ? read(this.master.meter) : { peak: 0 }, tracks };
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
        this.srcNodes.get(id)?.node.disconnect();
        this.srcNodes.delete(id);
        el.removeAttribute("src");
        el.load();
        this.els.delete(id);
      }
    }
    const ctx = playing ? this.context() : this.ctx;
    if (ctx && ctx.state === "suspended" && playing) void ctx.resume().catch(() => {});
    if (ctx && this.master) {
      this.wireMaster(tl.master);
      // strips follow the tracks: gain and pan (with their automation), processors
      for (const track of tl.tracks) {
        if (track.kind !== "audio") continue;
        const s = this.strip(track.id);
        if (!s) continue;
        this.wire(s, track.processors);
        const g = (track.gain ?? 1) * (track.anim?.gain?.length ? evalNumber(track.anim.gain as Key[], t, 1) : 1);
        s.gain.gain.value = g;
        s.pan.pan.value = Math.max(-1, Math.min(1, track.anim?.pan?.length ? evalNumber(track.anim.pan as Key[], t, track.pan ?? 0) : track.pan ?? 0));
      }
      // the song feeds the strip of its track
      if (this.song && !this.songNode) {
        try {
          this.songNode = { node: ctx.createMediaElementSource(this.song) };
        } catch {
          /* already attached elsewhere */
        }
      }
      if (this.songNode) {
        const songTrack = tl.clips.find((c) => c.fill && tl.tracks.find((x) => x.id === c.trackId)?.kind === "audio")?.trackId;
        const strip = (songTrack && this.strip(songTrack)) || this.strip("song");
        if (strip && this.songNode.to !== strip) {
          this.songNode.node.disconnect();
          this.songNode.node.connect(strip.input);
          this.songNode.to = strip;
        }
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
      const gain = Math.max(0, clipGain(tl, c, t));
      const strip = ctx ? this.strip(c.trackId) : null;
      if (ctx && strip) {
        // through the graph: the clip's own gain node feeds its track strip (so volume can go above 1)
        let n = this.srcNodes.get(c.id);
        if (!n) {
          n = { node: ctx.createMediaElementSource(el), gain: ctx.createGain() };
          n.node.connect(n.gain);
          this.srcNodes.set(c.id, n);
        }
        if (n.to !== strip) {
          n.gain.disconnect();
          n.gain.connect(strip.input);
          n.to = strip;
        }
        n.gain.gain.value = gain;
      } else el.volume = Math.min(1, gain);
      const target = c.sourceIn + (t - c.start) * c.speed;
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
    for (const n of this.srcNodes.values()) n.node.disconnect();
    this.srcNodes.clear();
  }
}

/* ---------- offline mix for export ---------- */

/** A clip's gain sampled over [from, to] in timeline seconds: 20 points per second, 100 per second inside fades. */
function sampleGain(c: Clip, from: number, to: number): { t: number; v: number }[] {
  const times = new Set<number>();
  const n = Math.max(1, Math.ceil((to - from) * 20));
  for (let i = 0; i <= n; i++) times.add(from + ((to - from) * i) / n);
  for (const [a, b] of [[c.start, c.start + (c.fadeIn ?? 0)], [c.start + c.duration - (c.fadeOut ?? 0), c.start + c.duration]]) {
    if (b <= a) continue;
    for (let t = a; t <= b + 1e-9; t += 0.01) if (t >= from && t <= to) times.add(t);
    if (a >= from && a <= to) times.add(a);
    if (b >= from && b <= to) times.add(b);
  }
  return [...times].sort((x, y) => x - y).map((t) => ({ t, v: (c.anim?.volume?.length ? evalNumber(c.anim.volume as Key[], t - c.start, c.volume ?? 1) : c.volume ?? 1) * clipFade(c, t) }));
}

export type MixInput = { trackId: string; url: string; start: number; duration: number; sourceIn: number; speed: number; volume: number; reverse?: boolean; /** Source end, needed to place a reversed clip. */ sourceOut?: number; fades?: { from: number; to: number; dir: "in" | "out" }[]; gainCurve?: { t: number; v: number }[] };

/** Clips that make up the exported sound: the song (when heard) and every audible audio clip. */
export function mixInputs(doc: ProjectDoc, songUrl: string | undefined, length: number, urlOf: (mediaId: string) => string | undefined): MixInput[] {
  const tl = activeTimeline(doc);
  const out: MixInput[] = [];
  const windows = fadeWindows(tl);
  const songTrack = tl.clips.find((c) => c.fill && tl.tracks.find((t) => t.id === c.trackId)?.kind === "audio")?.trackId ?? "song";
  if (songUrl && songAudible(doc)) out.push({ trackId: songTrack, url: songUrl, start: 0, duration: length, sourceIn: 0, speed: 1, volume: 1 });
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
    const e0 = Math.min(end, length);
    out.push({
      trackId: c.trackId,
      url,
      start: s0,
      duration: e0 - s0,
      sourceIn: Math.max(0, c.sourceIn + (s0 - c.start) * c.speed),
      sourceOut: c.sourceOut,
      speed: c.speed,
      volume: c.volume ?? 1,
      ...(c.reverse ? { reverse: true } : {}),
      ...(c.anim?.volume?.length || c.fadeIn || c.fadeOut ? { gainCurve: sampleGain(c, s0, e0) } : {}),
      ...(fades.length ? { fades: fades.map((f) => ({ from: f.w[0], to: f.w[1], dir: f.dir })) } : {}),
    });
  }
  return out;
}

/** The strip settings of every audio track and the master, with automation sampled 10 times a second. */
export function mixPlan(doc: ProjectDoc, length: number, masterOverride?: Partial<MasterStrip>): { tracks: Map<string, Omit<TrackMix, "channels">>; master: MasterMix } {
  const tl = activeTimeline(doc);
  const lane = (keys: unknown, fallback: number) => {
    if (!Array.isArray(keys) || !keys.length) return undefined;
    const pts: [number, number][] = [];
    for (let t = 0; t <= length + 0.05; t += 0.1) pts.push([t, evalNumber(keys as Key[], t, fallback)]);
    return pts;
  };
  const tracks = new Map<string, Omit<TrackMix, "channels">>();
  for (const t of tl.tracks as Track[]) {
    if (t.kind !== "audio") continue;
    tracks.set(t.id, { id: t.id, gain: t.gain ?? 1, pan: t.pan ?? 0, send: t.send ?? 0, processors: t.processors, gainCurve: lane(t.anim?.gain, 1), panCurve: lane(t.anim?.pan, t.pan ?? 0) });
  }
  const m = { ...(tl.master ?? { gainDb: 0 }), ...(masterOverride ?? {}) };
  return { tracks, master: { gainDb: m.gainDb, processors: m.processors, ceiling: m.ceiling } };
}

/** One track's clips placed on the timeline, as stereo samples. */
async function renderTrack(inputs: MixInput[], length: number, sr: number, decode: (url: string) => Promise<AudioBuffer | null>, reversed: (url: string, buf: AudioBuffer) => AudioBuffer, signal?: AbortSignal): Promise<Channels> {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(length * sr)), sr);
  for (const i of inputs) {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    let buf = await decode(i.url);
    if (!buf) continue; // a file without readable sound (e.g. a silent video) adds nothing
    let offset = i.sourceIn;
    if (i.reverse) {
      // the reversed buffer starts at the original's end: the clip's source out point comes first
      buf = reversed(i.url, buf);
      offset = Math.max(0, buf.duration - (i.sourceOut ?? buf.duration));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = i.speed;
    const gain = ctx.createGain();
    gain.gain.value = i.volume;
    if (i.gainCurve?.length) {
      gain.gain.setValueAtTime(i.gainCurve[0].v, Math.max(0, i.gainCurve[0].t));
      for (const pt of i.gainCurve.slice(1)) gain.gain.linearRampToValueAtTime(pt.v, Math.max(0, pt.t));
    }
    for (const f of i.fades ?? []) {
      // linear ramps through the crossfade window
      gain.gain.setValueAtTime(f.dir === "out" ? i.volume : 0, f.from);
      gain.gain.linearRampToValueAtTime(f.dir === "out" ? 0 : i.volume, f.to);
    }
    src.connect(gain).connect(ctx.destination);
    src.start(i.start, offset, i.duration * i.speed);
  }
  const rendered = await ctx.startRendering();
  return [rendered.getChannelData(0), rendered.getChannelData(1)];
}

/** Render the inputs into one stereo mix of `length` seconds: each track on its own, then gain, pan, processors, sends and the master. */
export async function mixdownChannels(inputs: MixInput[], length: number, sampleRate = 48000, signal?: AbortSignal, plan?: ReturnType<typeof mixPlan>): Promise<Channels | null> {
  if (!inputs.length || length <= 0) return null;
  const decodeCtx = new OfflineAudioContext(2, 1, sampleRate);
  const decoded = new Map<string, AudioBuffer | null>();
  const revs = new Map<string, AudioBuffer>();
  const decode = async (url: string) => {
    if (!decoded.has(url)) {
      try {
        decoded.set(url, await decodeCtx.decodeAudioData(await (await fetch(url)).arrayBuffer()));
      } catch {
        decoded.set(url, null);
      }
    }
    return decoded.get(url)!;
  };
  const reversed = (url: string, buf: AudioBuffer) => {
    let r = revs.get(url);
    if (!r) {
      r = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: buf.length, sampleRate: buf.sampleRate });
      for (let c = 0; c < buf.numberOfChannels; c++) r.copyToChannel(Float32Array.from(buf.getChannelData(c)).reverse(), c);
      revs.set(url, r);
    }
    return r;
  };
  const byTrack = new Map<string, MixInput[]>();
  for (const i of inputs) byTrack.set(i.trackId, [...(byTrack.get(i.trackId) ?? []), i]);
  const strips: TrackMix[] = [];
  for (const [id, list] of byTrack) {
    const channels = await renderTrack(list, length, sampleRate, decode, reversed, signal);
    const s = plan?.tracks.get(id);
    strips.push({ id, channels, gain: s?.gain ?? 1, pan: s?.pan ?? 0, send: s?.send ?? 0, processors: s?.processors, gainCurve: s?.gainCurve, panCurve: s?.panCurve });
  }
  return mixTracks(strips, plan?.master ?? { gainDb: 0 }, sampleRate, Math.ceil(length * sampleRate));
}

/** Render the mix to an AudioBuffer (the export). */
export async function mixdown(inputs: MixInput[], length: number, sampleRate = 48000, signal?: AbortSignal, plan?: ReturnType<typeof mixPlan>): Promise<AudioBuffer | null> {
  const ch = await mixdownChannels(inputs, length, sampleRate, signal, plan);
  if (!ch) return null;
  const buf = new AudioBuffer({ numberOfChannels: 2, length: ch[0].length, sampleRate });
  buf.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(ch[1] as Float32Array<ArrayBuffer>, 1);
  return buf;
}
