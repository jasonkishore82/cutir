// Phases 23 and 24: retiming maths, time stretch, multicam cuts, beat montage, audio sync.
import { RAMP_PRESETS, blendFrames, clampSpeed, rampIntegral, speedAt, speedOf, sourceAtRel, splitRamp, timeStretch, trimRampHead } from "../src/lib/retime";
import { activeCut, addCut, crossfadeOf, cutStrip, montagePlan, removeCut, segments, snapToBeats, soundSegments, videoAt } from "../src/lib/multicam";
import { downsampleMono, fft, findLag, formatTimecode, lagFromMarkers, lagFromTimecode, measureDrift, parseTimecode } from "../src/lib/sync";
import { readFileTimecode, type Reader } from "../src/lib/fileTimecode";
import type { MulticamSpec } from "../src/model/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/* ---------- retime ---------- */
const base = { sourceIn: 10, sourceOut: 20, speed: 2, duration: 5 };
check("constant speed maps time linearly", sourceAtRel(base, 0) === 10 && sourceAtRel(base, 2) === 14 && sourceAtRel(base, 5) === 20);
check("reverse counts back from the out point", sourceAtRel({ ...base, reverse: true }, 0) === 20 && sourceAtRel({ ...base, reverse: true }, 5) === 10);
check("speed is clamped between 1% and 10000%", clampSpeed(0) === 0.01 && clampSpeed(1e6) === 100 && clampSpeed(NaN) === 1 && clampSpeed(2.5) === 2.5);
const lin = { ease: false, keys: [{ t: 0, speed: 1 }, { t: 4, speed: 3 }] };
check("a straight ramp interpolates speed", near(speedAt(lin, 2), 2, 1e-9) && speedAt(lin, -1) === 1 && speedAt(lin, 9) === 3);
check("the integral of a straight ramp is the trapezoid", near(rampIntegral(lin, 4), 8, 1e-6) && near(rampIntegral(lin, 2), 3, 1e-6), [rampIntegral(lin, 4), rampIntegral(lin, 2)]);
const eased = { ease: true, keys: [{ t: 0, speed: 1 }, { t: 4, speed: 3 }] };
check("an eased ramp starts and ends slowly but covers the same ground by symmetry", near(speedAt(eased, 2), 2, 1e-9) && speedAt(eased, 0.4) < speedAt(lin, 0.4) && near(rampIntegral(eased, 4), 8, 1e-3), rampIntegral(eased, 4));
check("source time follows the ramp", near(sourceAtRel({ ...base, speed: 1, ramp: lin }, 4), 18, 1e-6));
check("a ramp held past its last key keeps its speed", near(rampIntegral(lin, 6), 8 + 6, 1e-6));
check("speedOf uses the ramp when there is one", speedOf({ speed: 1, ramp: lin }, 4) === 3 && speedOf({ speed: 2 }, 4) === 2);
const [l, r] = splitRamp(lin, 2);
check("splitting a ramp keeps the speed at the cut on both sides", near(l.keys[l.keys.length - 1].speed, 2, 1e-9) && near(r.keys[0].speed, 2, 1e-9) && r.keys[r.keys.length - 1].t === 2, [l, r]);
check("both halves cover the same source as the whole", near(rampIntegral(l, 2) + rampIntegral(r, 2), rampIntegral(lin, 4), 1e-6));
const head = trimRampHead(lin, 1);
check("trimming the head re-bases the ramp", near(head.keys[0].speed, 1.5, 1e-9) && head.keys[head.keys.length - 1].t === 3);
check("presets make a ramp over the clip", RAMP_PRESETS.every((p) => p.make(10, 1).keys.length >= 2 && p.make(10, 1).keys.every((k) => k.t >= 0 && k.t <= 10)));
check("blend frames weight the later frame", (() => { const f = blendFrames(1.0 + 0.5 / 30, 30); return near(f.a, 1, 1e-9) && near(f.b, 1 + 1 / 30, 1e-9) && near(f.w, 0.5, 1e-6); })());
check("on a frame there is nothing to blend", blendFrames(2, 30).w === 0 && blendFrames(1, 0).w === 0);

// time stretch keeps pitch: a 440 Hz tone stretched to twice the length is still 440 Hz
const SR = 16000;
const tone = Float32Array.from({ length: SR }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / SR));
const crossings = (x: Float32Array) => { let c = 0; for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) c++; return c; };
const slow = timeStretch([tone], 2, SR)[0];
check("stretching to 2x makes it twice as long", near(slow.length, SR * 2, 2), slow.length);
check("and keeps the pitch (same crossings per second)", near(crossings(slow.subarray(2000, SR * 2 - 2000)) / ((slow.length - 4000) / SR), 440, 12), crossings(slow.subarray(2000, SR * 2 - 2000)) / ((slow.length - 4000) / SR));
const fast = timeStretch([tone], 0.5, SR)[0];
check("compressing to half keeps the pitch too", near(fast.length, SR / 2, 2) && near(crossings(fast.subarray(1000, fast.length - 1000)) / ((fast.length - 2000) / SR), 440, 15));
check("a ratio of 1 copies", timeStretch([tone], 1, SR)[0].every((v, i) => v === tone[i]));
check("the stretched sound is not silent or clipped", Math.max(...slow.subarray(1000, 20000)) > 0.8 && Math.max(...slow) < 1.3);

/* ---------- multicam ---------- */
const spec: MulticamSpec = { angles: [{ id: "A", name: "Wide", mediaId: "ma", offset: 0 }, { id: "B", name: "Close", mediaId: "mb", offset: 2.5 }, { id: "C", name: "Side", mediaId: "mc", offset: -1 }], cuts: [] };
check("with no cuts the first angle shows", activeCut(spec, 5).video === "A" && videoAt(spec, 5)!.angle.id === "A");
const s1 = addCut(spec, 4, "B");
const s2 = addCut(s1, 9, "C");
check("cuts are kept in time order and pick the angle", s2.cuts.length === 2 && activeCut(s2, 3).video === "A" && activeCut(s2, 4).video === "B" && activeCut(s2, 10).video === "C");
check("an angle's source time adds its offset", near(videoAt(s2, 5)!.st, 7.5, 1e-9) && near(videoAt(s2, 10)!.st, 9, 1e-9));
check("a source time never goes below zero", videoAt({ ...spec, cuts: [{ t: 0, video: "C" }] }, 0.5)!.st === 0);
check("cutting to the angle already showing records nothing", addCut(s2, 11, "C").cuts.length === 2);
check("a cut at the same time replaces the old one", addCut(s2, 4.01, "C").cuts.filter((c) => near(c.t, 4, 0.1)).length === 1 && activeCut(addCut(s2, 4.01, "C"), 5).video === "C");
check("recording over drops the later cuts", addCut(s2, 6, "A", undefined, true).cuts.every((c) => c.t <= 6) && addCut(s2, 6, "A", undefined, true).cuts.length === 2);
check("a cut can be removed", removeCut(s2, 0).cuts.length === 1);
check("segments split a range at the cuts", (() => { const g = segments(s2, 0, 12); return g.length === 3 && g[0].angle === "A" && g[1].angle === "B" && g[2].angle === "C" && g[2].to === 12; })());
check("a range inside one cut is one segment", segments(s2, 5, 2).length === 1);
check("without audio settings the sound follows the picture", (() => { const g = soundSegments(s2, 0, 12); return g.length === 3 && g[1].mediaId === "mb" && g[1].offset === 2.5; })());
const ext: MulticamSpec = { ...s2, audioMediaId: "rec", audioOffset: 0.7 };
check("a separate recorder replaces the angles' sound and merges into one stretch", (() => { const g = soundSegments(ext, 0, 12); return g.length === 1 && g[0].mediaId === "rec" && g[0].offset === 0.7 && g[0].to === 12; })());
check("a cut can name its own audio angle", soundSegments({ ...s2, cuts: [{ t: 0, video: "A", audio: "C" }] }, 0, 5)[0].mediaId === "mc");
check("beats pull a cut time", snapToBeats(4.04, [1, 4, 8], 0.1) === 4 && snapToBeats(4.5, [1, 4, 8], 0.1) === 4.5);

const beats = Array.from({ length: 17 }, (_, i) => i * 0.5); // 120 bpm
const plan = montagePlan(beats, [{ mediaId: "x", duration: 20 }, { mediaId: "y", duration: 20 }], { beatsPerCut: 4 });
check("a montage cuts on the beat, every four beats", plan.length === 4 && plan.every((c) => near(c.duration, 2, 1e-9)) && plan.every((c) => beats.includes(c.start)), plan);
check("a montage uses the sources in turn and moves through them", plan[0].mediaId === "x" && plan[1].mediaId === "y" && plan[2].mediaId === "x" && plan[2].sourceIn === 2);
check("a source that is too short is skipped for that slot", montagePlan(beats, [{ mediaId: "s", duration: 1 }], { beatsPerCut: 4 }).length === 0);
check("no beats, no montage", montagePlan([], [{ mediaId: "x", duration: 9 }]).length === 0 && montagePlan(beats, []).length === 0);
check("a montage can be limited to a range", montagePlan(beats, [{ mediaId: "x", duration: 20 }], { beatsPerCut: 2, from: 2, to: 6 }).every((c) => c.start >= 2 && c.start + c.duration <= 6.0001));

/* ---------- sync ---------- */
check("the FFT round trip returns the input", (() => { const re = Float64Array.from([1, 2, 3, 4, 0, 0, 0, 0]); const im = new Float64Array(8); fft(re, im); fft(re, im, true); return near(re[0], 1, 1e-9) && near(re[3], 4, 1e-9) && near(im[1], 0, 1e-9); })());
const SYNC = 4000;
let seed = 3;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
};
const event = Float32Array.from({ length: SYNC * 12 }, () => rnd());
// camera heard the event from 0; the recorder started 3.25 s later and is shorter, with its own noise
const rec = Float32Array.from({ length: SYNC * 6 }, (_, i) => event[i + Math.round(3.25 * SYNC)] * 0.6 + rnd() * 0.15);
const lag = findLag(event, rec, SYNC);
check("cross-correlation finds where the recorder starts", near(lag.lag, 3.25, 0.002) && lag.confidence > 8, lag);
const early = Float32Array.from({ length: SYNC * 6 }, (_, i) => (i < SYNC * 2 ? rnd() : event[i - SYNC * 2]) * 0.8);
const lag2 = findLag(event, early, SYNC);
check("a recording that started before the camera has a negative lag", near(lag2.lag, -2, 0.002), lag2);
check("unrelated sound gives a low confidence", findLag(event, Float32Array.from({ length: SYNC * 5 }, () => rnd()), SYNC).confidence < lag.confidence / 2);
check("the lag search can be limited", Math.abs(findLag(event, rec, SYNC, 1).lag - 3.25) > 0.5);
check("downsampling averages and removes the mean", (() => { const d = downsampleMono([new Float32Array(48000).fill(0.5)], 48000, 4000); return d.length === 4000 && Math.abs(d[10]) < 1e-6; })());
check("marker and timecode lags", lagFromMarkers(12, 4) === 8 && lagFromTimecode(100, 103.5) === 3.5);
check("timecode parsing and formatting", parseTimecode("01:02:03:15", 30) === 3723.5 && parseTimecode("nonsense") === null && formatTimecode(3723.5, 30) === "01:02:03:15");

/* ---------- drift ---------- */
{
  const SR = 4000;
  // band-limited like real sound (a 4 kHz copy of speech or music has little above a few hundred Hz)
  const white = Float32Array.from({ length: SR * 120 + 8 }, () => rnd());
  const noise = Float32Array.from({ length: SR * 120 }, (_, i) => { let s = 0; for (let k = 0; k < 8; k++) s += white[i + k]; return s / 8; });
  const slide = (s: number, from = 3) => Float32Array.from({ length: SR * 100 }, (_, i) => noise[Math.round(from * SR + i * (1 + s))] ?? 0);
  const steady = slide(0);
  const d0 = await measureDrift(noise, steady, SR, 3);
  check("no drift is measured as none", d0.reliable && Math.abs(d0.ppm) < 150 && Math.abs(d0.speed - 1) < 2e-4, d0);
  const d1 = await measureDrift(noise, slide(0.0003), SR, 3);
  check("a recorder 300 ppm off is found and the speed that fixes it is given", d1.reliable && near(d1.ppm, 300, 80) && near(d1.speed, 1 / 1.0003, 1e-4) && near(d1.total, 0.03, 0.008), d1);
  const d2 = await measureDrift(noise, Float32Array.from({ length: SR * 100 }, () => rnd()), SR, 3);
  check("unrelated sound is not trusted", !d2.reliable, d2);
  check("a short clip is not trusted", !(await measureDrift(noise, steady.subarray(0, SR * 10), SR, 3)).reliable);
}

/* ---------- crossfade between sound sources ---------- */
{
  const spec: MulticamSpec = { angles: [{ id: "a", name: "A", mediaId: "ma", offset: 0 }, { id: "b", name: "B", mediaId: "mb", offset: 1 }], cuts: [{ t: 0, video: "a" }, { t: 4, video: "b" }] };
  const hard = soundSegments(spec, 0, 8);
  check("without a crossfade the stretches meet exactly", hard.length === 2 && hard[0].to === 4 && hard[1].from === 4 && hard[0].fadeOut === undefined);
  const x = soundSegments(spec, 0, 8, 0.2);
  check("a crossfade overlaps the two stretches around the cut", near(x[0].to, 4.1, 1e-9) && near(x[1].from, 3.9, 1e-9) && near(x[0].fadeOut!, 0.2, 1e-9) && near(x[1].fadeIn!, 0.2, 1e-9), x);
  check("the clip's outer edges are not extended", x[0].from === 0 && x[1].to === 8);
  const tiny = soundSegments({ ...spec, cuts: [{ t: 0, video: "a" }, { t: 0.1, video: "b" }] }, 0, 8, 1);
  check("a crossfade never grows past half of a short stretch", tiny[0].to <= 0.1 + 0.05 + 1e-9 && tiny[1].from >= 0.1 - 0.05 - 1e-9, tiny);
  check("the same source across a cut is not crossfaded", (() => { const s = soundSegments({ ...spec, audioMediaId: "rec", audioOffset: 0 }, 0, 8, 0.2); return s.length === 1 && s[0].fadeIn === undefined; })());
  check("the crossfade length has a default and limits", crossfadeOf(spec) === 0.12 && crossfadeOf({ ...spec, crossfade: 9 }) === 2 && crossfadeOf({ ...spec, crossfade: 0 }) === 0);
  const strip = cutStrip({ ...spec, cuts: [{ t: 0, video: "a" }, { t: 4, video: "b", audio: "a" }] }, { sourceIn: 2, duration: 4, speed: 2 });
  check("the timeline strip lists each stretch in clip time", strip.length === 2 && strip[0].from === 0 && strip[0].to === 1 && strip[1].from === 1 && strip[1].to === 4 && strip[1].number === 2 && strip[1].audioOnly === "A", strip);
  check("a retimed clip draws no strip", cutStrip(spec, { sourceIn: 0, duration: 4, speed: 1, ramp: {} }).length === 0);
}

/* ---------- timecode from files ---------- */
{
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const str = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const box = (type: string, ...parts: number[][]) => { const body = parts.flat(); return [...be(8 + body.length), ...str(type), ...body]; };
  const readerOf = (bytes: number[]): Reader => async (o, l) => Uint8Array.from(bytes.slice(o, o + l));
  // MOV: ftyp, mdat with the 4-byte frame counter, moov > trak > mdia > minf > stbl > stsd(tmcd) + stco
  const frames = ((1 * 3600 + 2 * 60 + 3) * 25) + 7; // 01:02:03:07 at 25 fps
  const ftyp = box("ftyp", str("qt  "), be(0));
  const mdat = box("mdat", be(frames));
  const dataAt = ftyp.length + 8;
  const stsd = box("stsd", be(0), be(1), be(34 - 2), str("tmcd"), [0, 0, 0, 0, 0, 0], [0, 1], be(0), be(0), be(25000), be(1000), [25, 0]);
  const stco = box("stco", be(0), be(1), be(dataAt));
  const moov = box("moov", box("trak", box("mdia", box("minf", box("stbl", stsd, stco)))));
  const mov = [...ftyp, ...mdat, ...moov];
  const tc = await readFileTimecode(readerOf(mov), mov.length);
  check("MOV timecode track is read", tc !== null && near(tc, 3723 + 7 / 25, 0.001), tc);
  check("a file with no timecode track gives none", (await readFileTimecode(readerOf([...ftyp, ...mdat, ...box("moov", box("trak", box("mdia")))]), ftyp.length + mdat.length + 16)) === null);
  // Broadcast WAV: fmt + bext (time reference in samples) + data
  const bext = new Array(346).fill(0);
  const ref = 48000 * 36000 + 24000; // 10:00:00.5 at 48 kHz
  bext.splice(338, 8, ...le(ref >>> 0), ...le(Math.floor(ref / 4294967296)));
  const fmt = [...str("fmt "), ...le(16), 1, 0, 1, 0, ...le(48000), ...le(96000), 2, 0, 16, 0];
  const wavBody = [...str("WAVE"), ...fmt, ...str("bext"), ...le(346), ...bext, ...str("data"), ...le(4), 0, 0, 0, 0];
  const wav = [...str("RIFF"), ...le(wavBody.length), ...wavBody];
  const wtc = await readFileTimecode(readerOf(wav), wav.length);
  check("Broadcast WAV time reference is read", wtc !== null && near(wtc, 36000.5, 0.001), wtc);
  check("a plain WAV has no timecode", (await readFileTimecode(readerOf([...str("RIFF"), ...le(20), ...str("WAVE"), ...fmt, ...str("data"), ...le(0)]), 44)) === null);
  check("garbage gives none rather than an error", (await readFileTimecode(readerOf([1, 2, 3]), 3)) === null);
}

if (fails) process.exit(1);
console.log("all passed");
