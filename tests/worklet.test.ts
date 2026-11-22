// Phase 21: the live processors (AudioWorklet source) match the offline ones in dsp.ts, block by block.
import { WORKLET_NAME, WORKLET_SOURCE, LIVE_WORKLET_TYPES } from "../src/lib/audio/worklet";
import { applyProcessor, processorDefaults, PROCESSORS, type AudioProcessor, type ProcessorType } from "../src/lib/audio/dsp";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const SR = 48000;

// a stand-in for the AudioWorklet global scope
const registry = new Map<string, new (o: unknown) => { process: (i: Float32Array[][], o: Float32Array[][]) => boolean; configure: (p: Record<string, number>) => void }>();
class AudioWorkletProcessor {
  port = { onmessage: null as null | ((e: { data: unknown }) => void) };
}
new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", WORKLET_SOURCE)(AudioWorkletProcessor, (n: string, c: never) => registry.set(n, c), SR);
check("the worklet registers one processor", registry.size === 1 && registry.has(WORKLET_NAME));

const make = (type: ProcessorType, params: Record<string, number>) => {
  const Cls = registry.get(WORKLET_NAME)!;
  return new Cls({ processorOptions: { type, params } });
};

/** Run stereo input through the worklet in 128-sample blocks. */
function live(type: ProcessorType, params: Record<string, number>, input: Float32Array[]): Float32Array[] {
  const node = make(type, params);
  const n = input[0].length;
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let s = 0; s < n; s += 128) {
    const e = Math.min(n, s + 128);
    const o = [new Float32Array(e - s), new Float32Array(e - s)];
    node.process([[input[0].subarray(s, e), input[1].subarray(s, e)]], [o]);
    out[0].set(o[0], s);
    out[1].set(o[1], s);
  }
  return out;
}
const offline = (type: ProcessorType, params: Record<string, number>, input: Float32Array[]) => {
  const ch = input.map((c) => Float32Array.from(c));
  const p: AudioProcessor = { id: "x", type, enabled: true, params };
  applyProcessor(ch, SR, p);
  return ch;
};
const maxDiff = (a: Float32Array[], b: Float32Array[]) => {
  let m = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) m = Math.max(m, Math.abs(a[c][i] - b[c][i]));
  return m;
};

// a speech-like test signal: noise floor, a loud tone burst, a sibilant burst, a pause
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const N = SR * 2;
const sig = [new Float32Array(N), new Float32Array(N)];
for (let i = 0; i < N; i++) {
  const t = i / SR;
  let v = 0.002 * rnd();
  if (t > 0.3 && t < 0.8) v += 0.5 * Math.sin(2 * Math.PI * 220 * t);
  if (t > 1.0 && t < 1.2) v += 0.4 * Math.sin(2 * Math.PI * 8000 * t);
  sig[0][i] = v;
  sig[1][i] = v * 0.8 + 0.001 * rnd();
}

for (const type of ["gate", "deesser", "delay", "reverb"] as const) {
  const params = processorDefaults(type);
  const d = maxDiff(live(type, params, sig), offline(type, params, sig));
  check(`${type}: live equals the export render (max difference ${d.toExponential(1)})`, d < 1e-4, d);
}
{
  const params = { ...processorDefaults("reverb"), size: 85, damping: 20, mix: 60 };
  check("reverb: other settings match too", maxDiff(live("reverb", params, sig), offline("reverb", params, sig)) < 1e-4);
  const p2 = { ...processorDefaults("delay"), time: 123, feedback: 70, mix: 80 };
  check("delay: other settings match too", maxDiff(live("delay", p2, sig), offline("delay", p2, sig)) < 1e-4);
  const p3 = { ...processorDefaults("gate"), threshold: -30, range: 40, attack: 20, release: 300 };
  check("gate: other settings match too", maxDiff(live("gate", p3, sig), offline("gate", p3, sig)) < 1e-4);
  const p4 = { ...processorDefaults("deesser"), freq: 4000, threshold: -35, ratio: 8 };
  check("de-esser: other settings match too", maxDiff(live("deesser", p4, sig), offline("deesser", p4, sig)) < 1e-4);
}

// behaviour: the gate silences the noise floor and keeps the tone
const g = live("gate", { threshold: -40, range: 60, attack: 2, release: 50 }, sig);
const rms = (x: Float32Array, a: number, b: number) => Math.sqrt(x.subarray(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
check("gate: quiet noise is gone, the tone stays", rms(g[0], 2000, 12000) < 0.0004 && rms(g[0], 20000, 36000) > 0.3);

// noise reduction follows the floor it hears
const dn = live("denoise", { amount: 20, sensitivity: 6 }, sig);
check("denoise: the noise floor drops after it has listened", rms(dn[0], 70000, 90000) < rms(sig[0], 70000, 90000) * 0.5);
check("denoise: the tone is kept", rms(dn[0], 20000, 36000) > rms(sig[0], 20000, 36000) * 0.8);
check("denoise: nothing changes before the first noise measurement", Math.abs(dn[0][100] - sig[0][100]) < 1e-9);

// reverb and delay tails keep ringing when the input stops (an unconnected input gives no channels)
const rvNode = make("reverb", { size: 60, damping: 50, mix: 100 });
const burst = [new Float32Array(128), new Float32Array(128)];
burst[0][0] = 1;
const o1 = [new Float32Array(128), new Float32Array(128)];
rvNode.process([[burst[0], burst[1]]], [o1]);
let tail = 0;
for (let b = 0; b < 40; b++) {
  const o = [new Float32Array(128), new Float32Array(128)];
  rvNode.process([[]], [o]);
  tail = Math.max(tail, ...o[0].map(Math.abs));
}
check("reverb: the tail rings on with nothing connected", tail > 0.01, tail);

// mono input feeds both channels
const mono = make("delay", { time: 20, feedback: 0, mix: 0 });
const mo = [new Float32Array(128), new Float32Array(128)];
const mi = new Float32Array(128).fill(0.25);
mono.process([[mi]], [mo]);
check("a mono input is copied to both outputs", mo[0][5] === 0.25 && mo[1][5] === 0.25);

// settings change while running without a glitch of state
const cfg = make("gate", { threshold: -50, range: 60, attack: 5, release: 120 });
const a1 = [new Float32Array(128).fill(0.3), new Float32Array(128).fill(0.3)];
const ob = [new Float32Array(128), new Float32Array(128)];
cfg.process([[a1[0], a1[1]]], [ob]);
cfg.configure({ threshold: -10, range: 60, attack: 5, release: 120 });
cfg.process([[a1[0], a1[1]]], [ob]);
check("changing a setting while running keeps working", Number.isFinite(ob[0][127]) && ob[0][127] < 0.3);

const native = ["eq", "highpass", "lowpass", "compressor", "limiter"];
check("exactly the processors without a Web Audio node are in the worklet", JSON.stringify([...LIVE_WORKLET_TYPES]) === JSON.stringify((Object.keys(PROCESSORS) as ProcessorType[]).filter((t) => !native.includes(t))), LIVE_WORKLET_TYPES);
check("every processor is heard live now", Object.values(PROCESSORS).every((p) => p.live));

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
