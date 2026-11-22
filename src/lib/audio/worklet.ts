/**
 * The live processors that Web Audio has no node for (phase 21): gate, de-esser, noise reduction, reverb and delay.
 * They run in an AudioWorklet and are the streaming form of the functions in dsp.ts: the same arithmetic, one sample at
 * a time with the state kept between blocks, so what is heard matches what the export renders. The code is a string
 * because an AudioWorklet loads a separate script (see `workletUrl`). tests/worklet.test.ts runs this exact source
 * against dsp.ts block by block.
 *
 * The one difference: noise reduction in the export finds the noise floor over the whole clip; live it follows the
 * quietest tenth of the last ten seconds, so the first moments adapt.
 */

export const WORKLET_NAME = "cutir-fx";
export const LIVE_WORKLET_TYPES = ["gate", "deesser", "denoise", "reverb", "delay"] as const;

export const WORKLET_SOURCE = `
const gainToDb = (g) => (g <= 1e-9 ? -180 : 20 * Math.log10(g));
const dbToGain = (db) => Math.pow(10, db / 20);
const coef = (ms, sr) => Math.exp(-1 / Math.max(1, (ms / 1000) * sr));
const DEFAULTS = {
  gate: { threshold: -50, range: 60, attack: 5, release: 120 },
  deesser: { freq: 6500, threshold: -28, ratio: 4 },
  denoise: { amount: 12, sensitivity: 6 },
  reverb: { size: 50, damping: 50, mix: 25 },
  delay: { time: 350, feedback: 35, mix: 25 },
};

/** Linked-stereo level detector and smoothed gain, one sample at a time (dynamics in dsp.ts). */
class Dyn {
  constructor(sr) {
    this.sr = sr;
    this.env = 0;
    this.det = 0;
    this.hold = coef(10, sr);
    this.set(10, 100);
  }
  set(attackMs, releaseMs) {
    this.a = coef(attackMs, this.sr);
    this.r = coef(releaseMs, this.sr);
  }
  /** inst: the loudest channel's absolute value; gainDbAt: level in dB -> wanted gain change in dB. */
  next(inst, gainDbAt) {
    this.det = Math.max(inst, this.det * this.hold);
    const target = gainDbAt(gainToDb(this.det));
    this.env = target < this.env ? this.a * this.env + (1 - this.a) * target : this.r * this.env + (1 - this.r) * target;
    return dbToGain(this.env);
  }
}

class HighPass {
  constructor(sr, freq, q) {
    const f = Math.min(Math.max(freq, 10), sr * 0.49);
    const w = (2 * Math.PI * f) / sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    const b0 = (1 + cos) / 2, b1 = -(1 + cos), b2 = b0, a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.z1 = [0, 0]; this.z2 = [0, 0];
  }
  run(ch, v) {
    const y = this.b0 * v + this.z1[ch];
    this.z1[ch] = this.b1 * v - this.a1 * y + this.z2[ch];
    this.z2[ch] = this.b2 * v - this.a2 * y;
    return Math.fround(y); // the export keeps this band in a Float32Array
  }
}

class CutirFx extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.type = o.type;
    this.sr = sampleRate;
    this.dyn = new Dyn(this.sr);
    this.hp = null;
    this.lines = null;
    this.blockE = 0; this.blockN = 0; this.levels = []; this.thr = null;
    this.configure(o.params || {});
    this.port.onmessage = (e) => this.configure(e.data.params || {});
  }
  v(k) {
    const p = this.params;
    return p[k] !== undefined ? p[k] : DEFAULTS[this.type][k];
  }
  configure(params) {
    this.params = params;
    const sr = this.sr;
    if (this.type === "gate") this.dyn.set(this.v("attack"), this.v("release"));
    else if (this.type === "deesser") {
      this.dyn.set(1, 60);
      if (!this.hp || this.hpFreq !== this.v("freq")) { this.hp = new HighPass(sr, this.v("freq"), 0.9); this.hpFreq = this.v("freq"); }
    } else if (this.type === "denoise") {
      this.dyn.set(10, 120);
      this.block = Math.max(64, Math.floor(sr * 0.02));
    } else if (this.type === "delay") {
      const d = Math.max(1, Math.round((this.v("time") / 1000) * sr));
      if (!this.lines || this.lines[0].buf.length !== d) this.lines = [0, 1].map(() => ({ buf: new Float32Array(d), w: 0 }));
    } else if (this.type === "reverb") {
      const size = this.v("size") / 100;
      const combs = [1116, 1188, 1277, 1356, 1422, 1491];
      const aps = [556, 441, 341];
      // changing the room size resizes the lines; damping and mix change in place
      if (!this.rv || this.rvSize !== size) {
        this.rvSize = size;
        this.rv = [0, 1].map((ci) => {
          const scale = (sr / 44100) * (0.5 + size) * (ci ? 1.03 : 1);
          return {
            combs: combs.map((d) => ({ buf: new Float32Array(Math.max(1, Math.round(d * scale))), i: 0, lp: 0 })),
            aps: aps.map((d) => ({ buf: new Float32Array(Math.max(1, Math.round(d * scale))), i: 0 })),
          };
        });
      }
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const inp = inputs[0] || [];
    const n = out[0].length;
    const L = inp[0] || null;
    const R = inp[1] || L;
    const ch = out.length > 1 ? [out[0], out[1]] : [out[0]];
    // copy the input (silence when nothing is connected, so reverb and delay tails ring out)
    for (let c = 0; c < ch.length; c++) {
      const s = c === 0 ? L : R;
      for (let i = 0; i < n; i++) ch[c][i] = s ? s[i] : 0;
    }
    const t = this.type;
    if (t === "gate") this.gate(ch, n);
    else if (t === "deesser") this.deess(ch, n);
    else if (t === "denoise") this.denoise(ch, n);
    else if (t === "delay") this.delayFx(ch, n);
    else if (t === "reverb") this.reverbFx(ch, n);
    return true;
  }
  gate(ch, n) {
    const thr = this.v("threshold"), range = this.v("range");
    for (let i = 0; i < n; i++) {
      let inst = 0;
      for (const c of ch) inst = Math.max(inst, Math.abs(c[i]));
      const g = this.dyn.next(inst, (l) => (l < thr ? -range : 0));
      for (const c of ch) c[i] *= g;
    }
  }
  deess(ch, n) {
    const thr = this.v("threshold"), ratio = this.v("ratio");
    const k = 1 - 1 / Math.max(1, ratio);
    for (let i = 0; i < n; i++) {
      let inst = 0;
      for (let c = 0; c < ch.length; c++) inst = Math.max(inst, Math.abs(this.hp.run(c, ch[c][i])));
      const g = this.dyn.next(inst, (l) => (l > thr ? (thr - l) * k : 0));
      for (const c of ch) c[i] *= g;
    }
  }
  denoise(ch, n) {
    const amount = this.v("amount"), margin = this.v("sensitivity");
    for (let i = 0; i < n; i++) {
      let inst = 0;
      for (const c of ch) { inst = Math.max(inst, Math.abs(c[i])); this.blockE += c[i] * c[i]; }
      if (++this.blockN === this.block) {
        this.levels.push(gainToDb(Math.sqrt(this.blockE / (this.block * ch.length))));
        if (this.levels.length > 500) this.levels.shift(); // the last ten seconds
        const sorted = this.levels.slice().sort((a, b) => a - b);
        this.thr = sorted[Math.floor(sorted.length * 0.1)] + margin;
        this.blockE = 0; this.blockN = 0;
      }
      const thr = this.thr;
      const g = this.dyn.next(inst, (l) => (thr !== null && l < thr ? -amount : 0));
      for (const c of ch) c[i] *= g;
    }
  }
  delayFx(ch, n) {
    const fb = this.v("feedback") / 100, mix = this.v("mix") / 100;
    for (let c = 0; c < ch.length; c++) {
      const line = this.lines[c];
      const d = line.buf.length;
      for (let i = 0; i < n; i++) {
        const dry = ch[c][i];
        const wet = line.buf[line.w];
        line.buf[line.w] = dry + wet * fb;
        line.w = (line.w + 1) % d;
        ch[c][i] = dry * (1 - mix * 0.5) + wet * mix;
      }
    }
  }
  reverbFx(ch, n) {
    const damping = this.v("damping") / 100, mix = this.v("mix") / 100;
    const size = this.rvSize;
    const fb = 0.7 + size * 0.25;
    const damp = 0.05 + damping * 0.7;
    for (let c = 0; c < ch.length; c++) {
      const r = this.rv[c];
      for (let i = 0; i < n; i++) {
        const x = ch[c][i];
        let wet = 0;
        for (const l of r.combs) {
          const y = l.buf[l.i];
          l.lp = y * (1 - damp) + l.lp * damp;
          l.buf[l.i] = x * 0.15 + l.lp * fb;
          l.i = (l.i + 1) % l.buf.length;
          wet += y;
        }
        for (const a of r.aps) {
          const y = a.buf[a.i];
          a.buf[a.i] = wet + y * 0.5;
          wet = y - wet * 0.5;
          a.i = (a.i + 1) % a.buf.length;
        }
        ch[c][i] = x * (1 - mix * 0.5) + wet * mix;
      }
    }
  }
}
registerProcessor("cutir-fx", CutirFx);
`;

/** A blob address the audio context can load the worklet from. Browser only. */
export function workletUrl(): string {
  return URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
}
