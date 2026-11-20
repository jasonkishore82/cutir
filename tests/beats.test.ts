// Beats: browser DSP on a synthetic click track, the manual grid, and storing results as timeline markers (src/lib/beats.ts, energy.ts).
import { analyzeSamples, energyAt, energyCurve, tempoOf } from "../src/lib/energy";
import { applyBeatResult, manualBeats, type BeatResult } from "../src/lib/beats";
import { viewToDoc, IDS } from "../src/model/convert";
import { defaultProject } from "../src/store/project";
import type { Clip, ProjectDoc } from "../src/model/types";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
}

/* ---------- click track ---------- */

/** A click track: short decaying noise bursts, every 4th louder, after `lead` seconds of silence. */
function clicks(bpm: number, seconds: number, sr: number, lead: number, quietFrom = Infinity) {
  const out = new Float32Array(Math.round(seconds * sr));
  const period = 60 / bpm;
  const times: number[] = [];
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let k = 0; lead + k * period < seconds - 0.1; k++) {
    const t = lead + k * period;
    times.push(t);
    const amp = (k % 4 === 0 ? 1 : 0.5) * (t >= quietFrom ? 0.3 : 1);
    const s0 = Math.round(t * sr);
    for (let i = 0; i < 0.03 * sr && s0 + i < out.length; i++) {
      const env = Math.exp(-i / (0.004 * sr));
      out[s0 + i] += amp * env * (0.6 * rand() + 0.4 * Math.sin((2 * Math.PI * 80 * i) / sr) * (k % 4 === 0 ? 1.5 : 0.3));
    }
  }
  return { samples: out, times };
}

const sr = 22050;
const { samples, times } = clicks(120, 30, sr, 0.37, 20);
const res = analyzeSamples(samples, sr);
check("tempo within 1 BPM of 120", Math.abs(res.tempo - 120) < 1, res.tempo);
const errs = res.beats.map((b) => Math.min(...times.map((t) => Math.abs(t - b.time))));
const worst = Math.max(...errs);
check("every beat within 30 ms of a click", worst < 0.03, { worst, first: res.beats.slice(0, 4) });
check("found nearly every click", res.beats.length >= times.length - 2 && res.beats.length <= times.length + 1, [res.beats.length, times.length]);
const downs = res.beats.filter((b) => b.downbeat);
check("downbeats on the accented clicks", downs.length > 0 && downs.every((b) => times.some((t, k) => k % 4 === 0 && Math.abs(t - b.time) < 0.03)), downs.slice(0, 3));
check("first downbeat is the first accented click", Math.abs(res.firstDownbeat - 0.37) < 0.03, res.firstDownbeat);
check("strengths 0..1, accents stronger", res.beats.every((b) => b.strength >= 0 && b.strength <= 1) && downs[0].strength > res.beats.find((b) => !b.downbeat)!.strength, res.beats.slice(0, 4));
check("energy at 20/s, 0..1", res.energy.rate === 20 && Math.abs(res.energy.values.length - 600) <= 1 && res.energy.values.every((v) => v >= 0 && v <= 1), res.energy.values.length);
const loud = energyAt(res.energy, 10.4);
const quiet = energyAt(res.energy, 25.4);
check("energy lower in the quiet part", quiet < loud, [loud, quiet]);
check("energyAt outside the curve is 0", energyAt(res.energy, -1) === 0 && energyAt(res.energy, 999) === 0 && energyAt(undefined, 1) === 0);
check("energy of silence is 0", energyCurve(new Float32Array(sr), sr).values.every((v) => v === 0));
check("tempoOf regression", Math.abs(tempoOf([0, 0.5, 1.0, 1.5, 2.0]) - 120) < 1e-6);

// a slower song
const waltz = clicks(90, 24, sr, 1.0);
const w = analyzeSamples(waltz.samples, sr);
check("90 BPM within 1 BPM", Math.abs(w.tempo - 90) < 1, w.tempo);

// a drum loop over a noise and pad bed: kick on 1 and 3, snare on 2 and 4, hi-hats on every eighth
function drums(bpm: number, seconds: number) {
  const out = new Float32Array(seconds * sr);
  const p = 60 / bpm;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const beats: number[] = [];
  for (let i = 0; i < out.length; i++) out[i] = 0.05 * rand() + 0.1 * Math.sin((2 * Math.PI * 220 * i) / sr) * Math.sin((2 * Math.PI * 0.3 * i) / sr);
  for (let k = 0; 0.2 + (k * p) / 2 < seconds - 0.2; k++) {
    const t = 0.2 + (k * p) / 2;
    if (k % 2 === 0) beats.push(t);
    const s0 = Math.round(t * sr);
    for (let i = 0; i < 0.08 * sr && s0 + i < out.length; i++) {
      let v = 0.15 * rand() * Math.exp(-i / (0.002 * sr));
      if (k % 4 === 0) v += 0.9 * Math.sin((2 * Math.PI * 60 * i) / sr) * Math.exp(-i / (0.03 * sr));
      if (k % 4 === 2) v += 0.5 * rand() * Math.exp(-i / (0.01 * sr));
      out[s0 + i] += v;
    }
  }
  return { out, beats };
}
for (const bpm of [75, 128, 165]) {
  const d = drums(bpm, 30);
  const r = analyzeSamples(d.out, sr);
  const e = Math.max(...r.beats.map((b) => Math.min(...d.beats.map((t) => Math.abs(t - b.time)))));
  check(`drum loop ${bpm} BPM: tempo within 1, beats within 30 ms, none missed`, Math.abs(r.tempo - bpm) < 1 && e < 0.03 && r.beats.length === d.beats.length, [r.tempo, e, r.beats.length, d.beats.length]);
}

/* ---------- manual grid ---------- */

const g = manualBeats(120, 1.25, 5, 4);
check("manual: source manual, tempo kept", g.analysis.source === "manual" && g.analysis.tempo === 120 && g.analysis.firstDownbeat === 1.25 && g.analysis.beatsPerBar === 4);
check("manual: backfilled to 0", Math.abs(g.beats[0].time - 0.25) < 1e-9 && g.beats[0].time >= 0, g.beats[0]);
check("manual: steady 0.5 s grid up to the end", g.beats.every((b, i) => i === 0 || Math.abs(b.time - g.beats[i - 1].time - 0.5) < 1e-6) && g.beats[g.beats.length - 1].time <= 5, g.beats.map((b) => b.time));
const gd = g.beats.filter((b) => b.downbeat).map((b) => b.time);
check("manual: downbeat every 4th from the first downbeat", JSON.stringify(gd) === JSON.stringify([1.25, 3.25]), gd);
check("manual: strength 1 on downbeats, 0.6 others", g.beats.every((b) => b.strength === (b.downbeat ? 1 : 0.6)));
check("manual: nonsense tempo gives no beats", manualBeats(0, 0, 10).beats.length === 0);

/* ---------- applyBeatResult ---------- */

const result: BeatResult = {
  analysis: { tempo: 120, firstDownbeat: 1, beatsPerBar: 4, source: "browser", energy: { rate: 20, values: [0, 0.5, 1] } },
  beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((time) => ({ time, downbeat: time === 1 || time === 3, strength: time === 1 ? 1 : 0.5 })),
};

function docWithClip(): ProjectDoc {
  const doc = viewToDoc({ ...defaultProject(), audio: { name: "song.mp3", kind: "audio", mediaId: "pool-1" } });
  const tl = doc.timelines[0];
  const clip: Clip = {
    id: "c-x", trackId: IDS.audioTrack, mediaId: "pm-pool-2", start: 10, duration: 1.5, sourceIn: 2, sourceOut: 5, speed: 2, enabled: true, effects: [], keyframes: {},
  };
  return {
    ...doc,
    media: [...doc.media, { id: "pm-pool-2", name: "other.mp3", kind: "audio", fileKey: "m/pool-2", poolId: "pool-2" }],
    timelines: [{ ...tl, clips: [...tl.clips, clip], markers: [{ id: "u1", time: 10.6, name: "Chorus", color: "#fff" }, { id: "old", time: 11, name: "Beat", color: "#000", kind: "beat", sourceMediaId: "pm-pool-2" }, { id: "foreign", time: 3, name: "Beat", color: "#000", kind: "beat", sourceMediaId: "m-song" }] }],
  };
}

const before = docWithClip();
const frozen = JSON.stringify(before);
const after = applyBeatResult(before, "pool-2", result);
check("input doc untouched", JSON.stringify(before) === frozen);
check("analysis stored on the media (pool id resolves)", after.media.find((m) => m.id === "pm-pool-2")?.analysis?.tempo === 120 && !after.media.find((m) => m.id === IDS.audioMedia)?.analysis);
const mk = after.timelines[0].markers;
const mine = mk.filter((m) => m.sourceMediaId === "pm-pool-2");
// source 2..5 at speed 2 from timeline 10: source 2 -> 10, 2.5 -> 10.25 ... 4.5 -> 11.25; 5 (sourceOut) is outside
check("trimmed, offset, sped-up clip: source -> timeline", JSON.stringify(mine.map((m) => m.time)) === JSON.stringify([10, 10.25, 10.5, 10.75, 11, 11.25]), mine.map((m) => m.time));
check("old beat markers of this media replaced", !mk.some((m) => m.id === "old"));
check("user marker and other media's beats kept", mk.some((m) => m.id === "u1") && mk.some((m) => m.id === "foreign"));
check("markers sorted by time", mk.every((m, i) => i === 0 || mk[i - 1].time <= m.time), mk.map((m) => m.time));
check("beat marker fields", mine.every((m) => m.kind === "beat" && typeof m.strength === "number" && !m.clipId) && mine.find((m) => m.time === 10.5)?.downbeat === true && mine.find((m) => m.time === 10.5)?.name === "Bar 2");
check("bar numbers count downbeats of the song", mine.find((m) => m.time === 10)?.name === "Beat" && mine.find((m) => m.time === 11)?.name === "Beat");
check("applying twice is the same", JSON.stringify(applyBeatResult(after, "pool-2", result)) === JSON.stringify(after));
check("unknown media is a no-op", applyBeatResult(before, "nope", result) === before);

// the lyric project's song: a fill clip, reached by its pool id
const song = applyBeatResult(docWithClip(), "pool-1", result);
const songBeats = song.timelines[0].markers.filter((m) => m.sourceMediaId === IDS.audioMedia);
check("lyric song gets every beat at source time", songBeats.length === result.beats.length && songBeats[2].time === 1 && songBeats[2].downbeat === true, songBeats.map((m) => m.time));
check("old song beats replaced", !song.timelines[0].markers.some((m) => m.id === "foreign"));
check("song analysis with energy", song.media.find((m) => m.id === IDS.audioMedia)?.analysis?.energy?.values.length === 3);

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
