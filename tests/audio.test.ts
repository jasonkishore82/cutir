// Phase 21: audio processors, loudness, silence detection and the track mix.
import { applyFades, biquad, biquadResponseDb, compress, compressorCurveDb, dbToGain, deess, delay, denoise, detectSilence, gate, gainToDb, keepRanges, limit, normalizeGain, peakOf, reverb, reverseChannels, runBiquad, applyProcessor, processorDefaults, PROCESSORS } from "../src/lib/audio/dsp";
import { LOUDNESS_TARGETS, matchGain, measureLoudness, truePeakDb } from "../src/lib/audio/loudness";
import { mixTracks, panGains } from "../src/lib/audio/mix";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const SR = 48000;
const sine = (hz: number, sec: number, amp = 0.5, sr = SR) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// filters
const lp = biquad("lowpass", SR, 1000);
check("low pass: passes 100 Hz, cuts 10 kHz", near(biquadResponseDb(lp, SR, 100), 0, 0.5) && biquadResponseDb(lp, SR, 10000) < -30);
const hp = biquad("highpass", SR, 1000);
check("high pass cuts 100 Hz", biquadResponseDb(hp, SR, 100) < -30 && near(biquadResponseDb(hp, SR, 10000), 0, 0.5));
check("peaking band boosts its centre by its gain", near(biquadResponseDb(biquad("peaking", SR, 1000, 1, 6), SR, 1000), 6, 0.2));
check("low shelf boosts the lows", near(biquadResponseDb(biquad("lowshelf", SR, 200, 0.707, 8), SR, 20), 8, 0.7));
const tone = sine(5000, 0.2);
runBiquad(tone, lp);
check("running a low pass lowers a high tone", rms(tone.subarray(2000)) < 0.02);

// dynamics
check("compressor curve: below threshold unchanged, above reduced", compressorCurveDb(-40, -20, 4, 0) === -40 && near(compressorCurveDb(0, -20, 4, 0), -15, 1e-9));
const loud = sine(440, 0.5, 0.9);
const quiet = sine(440, 0.5, 0.05);
const lc = [Float32Array.from(loud)];
compress(lc, SR, { threshold: -30, ratio: 8, attack: 1, release: 50, knee: 0, makeup: 0 });
check("compressor lowers a loud signal", rms(lc[0].subarray(8000)) < rms(loud) * 0.6, rms(lc[0]));
const qc = [Float32Array.from(quiet)];
compress(qc, SR, { threshold: -10, ratio: 8, attack: 1, release: 50, knee: 0, makeup: 0 });
check("compressor leaves a quiet signal alone", near(rms(qc[0]), rms(quiet), 0.002));
const lim = [sine(440, 0.3, 1.5), sine(440, 0.3, 1.5)];
limit(lim, SR, -6);
check("limiter holds the ceiling", peakOf(lim) <= dbToGain(-6) + 1e-4, gainToDb(peakOf(lim)));
const noisy = [Float32Array.from({ length: SR }, (_, i) => (i < SR / 2 ? 0.001 * Math.sin(i) : 0.5 * Math.sin(i * 0.05)))];
const gated = [Float32Array.from(noisy[0])];
gate(gated, SR, { threshold: -40, range: 60, attack: 2, release: 50 });
check("gate silences the quiet half and keeps the loud half", rms(gated[0].subarray(5000, 20000)) < 0.0002 && rms(gated[0].subarray(30000)) > 0.3);
const dn = [Float32Array.from(noisy[0])];
denoise(dn, SR, { amount: 20, sensitivity: 6 });
check("noise reduction lowers the noise floor", rms(dn[0].subarray(5000, 20000)) < rms(noisy[0].subarray(5000, 20000)) * 0.5);
const ess = [sine(8000, 0.3, 0.6)];
const ess0 = rms(ess[0]);
deess(ess, SR, { freq: 6000, threshold: -30, ratio: 6 });
check("de-esser lowers a loud high tone", rms(ess[0].subarray(5000)) < ess0 * 0.7);
const vox = [sine(200, 0.3, 0.6)];
deess(vox, SR, { freq: 6000, threshold: -30, ratio: 6 });
check("de-esser leaves low tones alone", near(rms(vox[0].subarray(5000)), rms(sine(200, 0.3, 0.6)), 0.02));

// time effects
const imp = [new Float32Array(SR)];
imp[0][0] = 1;
delay(imp, SR, { time: 100, feedback: 0.5, mix: 1 });
check("delay echoes the impulse 100 ms later, quieter", near(imp[0][4800], 1, 1e-6) && near(imp[0][9600], 0.5, 1e-6), [imp[0][4800], imp[0][9600]]);
const rv = [new Float32Array(SR)];
rv[0][0] = 1;
reverb(rv, SR, { size: 0.5, damping: 0.5, mix: 1 });
check("reverb leaves a tail after the impulse", rms(rv[0].subarray(4000, 30000)) > 1e-4);
const stereoDry = [sine(300, 0.2), sine(300, 0.2)];
applyProcessor(stereoDry, SR, { id: "x", type: "reverb", enabled: false, params: { ...processorDefaults("reverb") } });
check("a disabled processor does nothing", rms(stereoDry[0]) === rms(sine(300, 0.2)));
check("every processor has defaults inside its range", Object.values(PROCESSORS).every((p) => p.params.every((s) => s.default >= s.min && s.default <= s.max)));

// loudness
const m1 = measureLoudness([sine(1000, 5, 0.1), sine(1000, 5, 0.1)], SR);
check("a -20 dBFS stereo 1 kHz sine measures about -20 LUFS", near(m1.integrated, -20, 0.6), m1.integrated);
const m2 = measureLoudness([sine(1000, 5, 0.2), sine(1000, 5, 0.2)], SR);
check("doubling the level adds 6 LU", near(m2.integrated - m1.integrated, 6.02, 0.1), m2.integrated - m1.integrated);
check("true peak is at least the sample peak", m2.truePeak >= m2.samplePeak - 1e-6);
check("true peak sees an inter-sample peak", truePeakDb([Float32Array.from([0, 0, 0.7, 0.7, 0, 0])]) > gainToDb(0.7) + 0.3);
check("silence measures -Infinity", measureLoudness([new Float32Array(SR * 2)], SR).integrated === -Infinity);
const g = matchGain(m1, LOUDNESS_TARGETS[0]);
const matched = [sine(1000, 5, 0.1 * dbToGain(g.gainDb)), sine(1000, 5, 0.1 * dbToGain(g.gainDb))];
check("match gain reaches the target", near(measureLoudness(matched, SR).integrated, -14, 0.3), measureLoudness(matched, SR).integrated);
check("match gain flags a peak over the ceiling", matchGain({ ...m1, integrated: -30, truePeak: -2 }, { lufs: -14, truePeak: -1 }).limited);
// gated loudness ignores a long quiet passage
const withGap = [Float32Array.from([...sine(1000, 4, 0.2), ...new Float32Array(SR * 6)])];
check("the gate ignores silence in the integrated value", near(measureLoudness(withGap, SR).integrated, measureLoudness([sine(1000, 4, 0.2)], SR).integrated, 0.5));

// clip helpers
const ramp = [Float32Array.from({ length: 1000 }, (_, i) => i / 1000)];
reverseChannels(ramp);
check("reverse flips the samples", ramp[0][0] > 0.99 && ramp[0][999] < 0.01);
const faded = [new Float32Array(48000).fill(1)];
applyFades(faded, SR, 0.1, 0.1);
check("fades ramp the ends and leave the middle", faded[0][0] === 0 && faded[0][24000] === 1 && faded[0][47999] === 0 && faded[0][2400] > 0.6 && faded[0][2400] < 0.8, faded[0][2400]);
check("normalize brings the peak to the target", near(peakOf([Float32Array.from([0.25, -0.1])]) * normalizeGain([Float32Array.from([0.25, -0.1])], -6), dbToGain(-6), 1e-6));
check("normalizing silence does nothing", normalizeGain([new Float32Array(10)]) === 1);

// silence
const speech = Float32Array.from([...sine(300, 1, 0.3), ...new Float32Array(SR), ...sine(300, 1, 0.3), ...new Float32Array(Math.round(SR * 0.2)), ...sine(300, 0.5, 0.3)]);
const sil = detectSilence(speech, SR, -45, 0.4);
check("silence detection finds only the long gap", sil.length === 1 && near(sil[0][0], 1, 0.03) && near(sil[0][1], 2, 0.03), sil);
const keep = keepRanges(sil, speech.length / SR, 0.1);
check("keep ranges leave padding at the cuts", keep.length === 2 && near(keep[0][1], 1.1, 0.03) && near(keep[1][0], 1.9, 0.03), keep);
check("no silence keeps everything", keepRanges([], 3).length === 1);
check("a trailing silence is detected", detectSilence(Float32Array.from([...sine(300, 1, 0.3), ...new Float32Array(SR)]), SR, -45, 0.4).length === 1);

// mix
const [pl, pr] = panGains(0);
check("centre pan keeps level", near(pl, 1, 1e-9) && near(pr, 1, 1e-9));
check("hard left silences the right", panGains(-1)[1] < 1e-9 && panGains(1)[0] < 1e-9);
const one = sine(440, 0.5, 0.3);
const mixed = mixTracks([{ id: "a", channels: [one, one], gain: 0.5, pan: 0, send: 0 }, { id: "b", channels: [one, one], gain: 0.5, pan: 0, send: 0 }], { gainDb: 0 }, SR, one.length);
check("two half-gain copies sum to the original", near(rms(mixed[0]), rms(one), 1e-3), [rms(mixed[0]), rms(one)]);
const left = mixTracks([{ id: "a", channels: [one], gain: 1, pan: -1, send: 0 }], { gainDb: 0 }, SR, one.length);
check("a track panned left makes sound only on the left (a mono track is doubled)", rms(left[0]) > 0.2 && rms(left[1]) < 1e-6);
const mg = mixTracks([{ id: "a", channels: [one, one], gain: 1, pan: 0, send: 0 }], { gainDb: -6 }, SR, one.length);
check("master gain applies", near(rms(mg[0]) / rms(one), dbToGain(-6), 0.01));
const ceil = mixTracks([{ id: "a", channels: [sine(440, 0.3, 0.9), sine(440, 0.3, 0.9)], gain: 1, pan: 0, send: 0 }], { gainDb: 12, ceiling: -1 }, SR, 14400);
check("the master ceiling holds the peak", peakOf(ceil) <= dbToGain(-1) + 1e-4, gainToDb(peakOf(ceil)));
const curved = mixTracks([{ id: "a", channels: [one, one], gain: 1, pan: 0, send: 0, gainCurve: [[0, 1], [0.5, 0]] }], { gainDb: 0 }, SR, one.length);
check("gain automation fades the track out", rms(curved[0].subarray(0, 2000)) > 0.2 && rms(curved[0].subarray(one.length - 500)) < 0.01);
const sent = mixTracks([{ id: "a", channels: [sine(440, 0.1, 0.3), sine(440, 0.1, 0.3)], gain: 1, pan: 0, send: 0.8 }], { gainDb: 0 }, SR, SR);
check("a send adds reverb after the track stops", rms(sent[0].subarray(10000, 30000)) > 1e-4);
const eqd = mixTracks([{ id: "a", channels: [sine(8000, 0.2), sine(8000, 0.2)], gain: 1, pan: 0, send: 0, processors: [{ id: "p", type: "lowpass", enabled: true, params: { freq: 1000 } }] }], { gainDb: 0 }, SR, 9600);
check("a track processor chain runs in the mix", rms(eqd[0].subarray(2000)) < 0.02);


// model: strips, fades and the plan the export uses
{
  const { viewToDoc, activeTimeline } = await import("../src/model/convert");
  const { defaultProject } = await import("../src/store/project");
  const { clipFade, clipGain, mixPlan, mixInputs } = await import("../src/render/audio");
  const doc = viewToDoc(defaultProject());
  const tl = activeTimeline(doc);
  const track = tl.tracks.find((t) => t.kind === "audio")!;
  const clip = { id: "c1", trackId: track.id, mediaId: "m1", start: 2, duration: 4, sourceIn: 0, sourceOut: 4, speed: 1, enabled: true, effects: [], keyframes: {}, fadeIn: 1, fadeOut: 1, reverse: true };
  check("fade in starts silent and reaches full", clipFade(clip, 2) === 0 && clipFade(clip, 3.5) === 1 && near(clipFade(clip, 2.5), Math.sin(Math.PI / 4), 1e-9));
  check("fade out ends silent", clipFade(clip, 6) === 0 && clipFade(clip, 5.5) < 0.8);
  check("clip gain includes fades and volume", near(clipGain(tl, { ...clip, volume: 0.5 }, 4), 0.5, 1e-9));
  const withTrack = { ...doc, timelines: doc.timelines.map((x) => ({ ...x, tracks: x.tracks.map((t) => (t.id === track.id ? { ...t, gain: 0.5, pan: -0.5, send: 0.2, anim: { gain: [{ t: 0, v: 1 }, { t: 10, v: 0 }] } } : t)), clips: [...x.clips, clip], master: { gainDb: -3, ceiling: -1 } })), media: [...doc.media, { id: "m1", name: "a.wav", kind: "audio" as const, fileKey: "m/1", poolId: "1", duration: 10 }] };
  const plan = mixPlan(withTrack as typeof doc, 10);
  const strip = plan.tracks.get(track.id)!;
  check("the plan carries gain, pan and send", strip.gain === 0.5 && strip.pan === -0.5 && strip.send === 0.2);
  check("track automation is sampled", !!strip.gainCurve && near(strip.gainCurve![50][1], 0.5, 0.05), strip.gainCurve?.[50]);
  check("the plan carries the master", plan.master.gainDb === -3 && plan.master.ceiling === -1 && mixPlan(withTrack as typeof doc, 10, { gainDb: 0, ceiling: undefined }).master.gainDb === 0);
  const inputs = mixInputs(withTrack as typeof doc, undefined, 20, () => "blob:x");
  const inp = inputs.find((i) => i.start === 2)!;
  check("mix inputs carry the track, reverse and a gain curve with the fades", inp.trackId === track.id && inp.reverse === true && inp.sourceOut === 4 && !!inp.gainCurve && inp.gainCurve[0].v === 0 && inp.gainCurve.length > 100, inp.gainCurve?.length);
}

if (fails) process.exit(1);
console.log("all passed");
