import { applyChain, applyProcessor, dbToGain, limit, type AudioProcessor, type Channels } from "./dsp";

/** The mix of the audio tracks (phase 21): tracks are summed through gain, pan and a reverb send, then the master. Pure, so the export and the tests share it. */

export type TrackMix = {
  id: string;
  /** Stereo (or mono) samples of the track with its clips already placed on the timeline. */
  channels: Channels;
  gain: number;
  /** -1 (left) to 1 (right). */
  pan: number;
  /** Reverb send, 0..1. */
  send: number;
  processors?: AudioProcessor[];
  /** Automation sampled as [seconds, value]: a gain multiplier and a pan position. */
  gainCurve?: [number, number][];
  panCurve?: [number, number][];
};

export type MasterMix = { gainDb: number; processors?: AudioProcessor[]; /** Hold the peak under this ceiling (dB) after the gain. */ ceiling?: number };

/** Equal-power pan gains, 1 each at the centre so a centred track keeps its level. */
export const panGains = (pan: number): [number, number] => {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
};

const curveAt = (curve: [number, number][], t: number, fallback: number) => {
  if (!curve.length) return fallback;
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) {
      const [t0, v0] = curve[i - 1];
      const [t1, v1] = curve[i];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return curve[curve.length - 1][1];
};

/** Mix tracks into one stereo buffer of `length` samples. Mute and solo are decided before: only audible tracks are passed. */
export function mixTracks(tracks: TrackMix[], master: MasterMix, sr: number, length: number): Channels {
  const out: Channels = [new Float32Array(length), new Float32Array(length)];
  const bus: Channels = [new Float32Array(length), new Float32Array(length)];
  let anySend = false;
  for (const t of tracks) {
    const ch: Channels = t.channels.map((c) => Float32Array.from(c.subarray(0, length)));
    if (ch.length === 1) ch.push(Float32Array.from(ch[0]));
    applyChain(ch, sr, t.processors);
    const n = Math.min(length, ch[0].length);
    for (let i = 0; i < n; i++) {
      const sec = i / sr;
      const g = t.gain * (t.gainCurve?.length ? curveAt(t.gainCurve, sec, 1) : 1);
      const [pl, pr] = panGains(t.panCurve?.length ? curveAt(t.panCurve, sec, t.pan) : t.pan);
      const l = ch[0][i] * g * pl;
      const r = ch[1][i] * g * pr;
      out[0][i] += l;
      out[1][i] += r;
      if (t.send > 0) {
        bus[0][i] += l * t.send;
        bus[1][i] += r * t.send;
        anySend = true;
      }
    }
  }
  if (anySend) {
    applyProcessor(bus, sr, { id: "send", type: "reverb", enabled: true, params: { size: 60, damping: 50, mix: 100 } });
    for (let c = 0; c < 2; c++) for (let i = 0; i < length; i++) out[c][i] += bus[c][i];
  }
  applyChain(out, sr, master.processors);
  const mg = dbToGain(master.gainDb);
  if (mg !== 1) for (const c of out) for (let i = 0; i < length; i++) c[i] *= mg;
  if (master.ceiling !== undefined) limit(out, sr, master.ceiling, 80);
  return out;
}
