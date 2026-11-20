/**
 * Colour grading maths (phase 20), pure and shared by the effects, the scopes and the tests. Everything works on
 * 0..1 floats; the effects turn it into 256-entry tables so a 1080p frame is a few table lookups per pixel.
 *
 * Order of the primary tone stage, per channel c:
 *   white balance -> gain and lift -> offset -> gamma -> contrast around the pivot -> shadows and highlights
 * then one 3x3 matrix for saturation and hue. With every control at its default the result is the input.
 */

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ---------- curves ---------- */

export type CurvePoints = [number, number][];
export const LINEAR_CURVE: CurvePoints = [[0, 0], [1, 1]];
/** The neutral curve of hue vs and luma vs curves: flat in the middle (0.5 = no change). */
export const FLAT_CURVE: CurvePoints = [[0, 0.5], [1, 0.5]];

/** A curve through its points (x ascending), smooth and without overshoot (monotone cubic); holds outside the ends. */
export function evalCurve(points: CurvePoints | undefined, x: number): number {
  const pts = (points?.length ? [...points].sort((a, b) => a[0] - b[0]) : LINEAR_CURVE) as CurvePoints;
  if (pts.length === 1) return pts[0][1];
  if (x <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (x >= last[0]) return last[1];
  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0] || 1e-9);
    slope.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) m[i] = m[i + 1] = 0;
    else {
      const a = m[i] / slope[i];
      const b = m[i + 1] / slope[i];
      const s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        m[i] = k * a * slope[i];
        m[i + 1] = k * b * slope[i];
      }
    }
  }
  let i = 0;
  while (i < n - 2 && x > pts[i + 1][0]) i++;
  const t = (x - pts[i][0]) / dx[i];
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * pts[i][1] + (t3 - 2 * t2 + t) * dx[i] * m[i] + (-2 * t3 + 3 * t2) * pts[i + 1][1] + (t3 - t2) * dx[i] * m[i + 1];
}

export const isIdentityCurve = (pts: CurvePoints | undefined, flat = false) => !pts || pts.every(([x, y]) => (flat ? Math.abs(y - 0.5) < 1e-4 : Math.abs(y - x) < 1e-4));

/** A 256-entry table of a curve (output 0..255). */
export function curveTable(points: CurvePoints | undefined): Uint8ClampedArray {
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(clamp01(evalCurve(points, i / 255)) * 255);
  return t;
}

/* ---------- primary grade ---------- */

export type Wheel = { r: number; g: number; b: number; m: number };
export type Grade = {
  lift: Wheel;
  gamma: Wheel;
  gain: Wheel;
  offset: Wheel;
  contrast: number;
  pivot: number;
  saturation: number;
  hue: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
};

const zeroWheel = (): Wheel => ({ r: 0, g: 0, b: 0, m: 0 });
export const NEUTRAL_GRADE: Grade = { lift: zeroWheel(), gamma: zeroWheel(), gain: zeroWheel(), offset: zeroWheel(), contrast: 0, pivot: 50, saturation: 0, hue: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 };

/** One channel's value through the tone stage. `k` is 0, 1, 2 for r, g, b. All sliders are -100..100. */
export function toneChannel(c: number, k: 0 | 1 | 2, g: Grade): number {
  const ch = (["r", "g", "b"] as const)[k];
  // white balance: warm adds red and removes blue; a positive tint is magenta (less green)
  const wb = k === 0 ? 1 + g.temperature * 0.0025 : k === 2 ? 1 - g.temperature * 0.0025 : 1 - g.tint * 0.002;
  c *= wb;
  const gain = 1 + (g.gain.m + g.gain[ch]) / 100;
  const lift = ((g.lift.m + g.lift[ch]) / 100) * 0.5;
  c = c * gain + lift * (1 - c);
  c += ((g.offset.m + g.offset[ch]) / 100) * 0.25;
  const gamma = Math.pow(2, (g.gamma.m + g.gamma[ch]) / 100);
  c = c <= 0 ? c : Math.pow(c, 1 / gamma);
  c = (c - g.pivot / 100) * (1 + g.contrast / 100) + g.pivot / 100;
  if (g.shadows) c += (g.shadows / 100) * 0.25 * (1 - smooth(0, 0.6, c));
  if (g.highlights) c += (g.highlights / 100) * 0.25 * smooth(0.4, 1, c);
  return clamp01(c);
}

/** Tables for the three channels. */
export function toneTables(g: Grade): [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] {
  const out = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)] as const;
  for (let k = 0; k < 3; k++) for (let i = 0; i < 256; i++) out[k][i] = Math.round(toneChannel(i / 255, k as 0 | 1 | 2, g) * 255);
  return [out[0], out[1], out[2]];
}

export const LUMA = [0.2126, 0.7152, 0.0722] as const;
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const mul3 = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};

/** Saturation (1 = unchanged, 0 = grey) as a matrix around the luma. */
export function saturationMatrix(s: number): Mat3 {
  const [lr, lg, lb] = LUMA;
  return [lr + (1 - lr) * s, lg - lg * s, lb - lb * s, lr - lr * s, lg + (1 - lg) * s, lb - lb * s, lr - lr * s, lg - lg * s, lb + (1 - lb) * s];
}

/** Hue rotation in degrees: a rotation about the grey axis (1,1,1). */
export function hueMatrix(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = 1 / 3;
  const q = Math.sqrt(k) * s;
  return [c + (1 - c) * k, k * (1 - c) - q, k * (1 - c) + q, k * (1 - c) + q, c + k * (1 - c), k * (1 - c) - q, k * (1 - c) - q, k * (1 - c) + q, c + k * (1 - c)];
}

export const colourMatrix = (g: Pick<Grade, "saturation" | "hue">): Mat3 => mul3(saturationMatrix(Math.max(0, 1 + g.saturation / 100)), hueMatrix(g.hue));

export const isNeutralGrade = (g: Grade) => JSON.stringify(g) === JSON.stringify(NEUTRAL_GRADE);

/** One colour through the whole grade (for tests, scopes and swatches; the effect uses tables). */
export function gradeColor(rgb: [number, number, number], g: Grade): [number, number, number] {
  const t = [0, 1, 2].map((k) => toneChannel(rgb[k], k as 0 | 1 | 2, g));
  const m = colourMatrix(g);
  return [0, 1, 2].map((r) => clamp01(m[r * 3] * t[0] + m[r * 3 + 1] * t[1] + m[r * 3 + 2] * t[2])) as [number, number, number];
}

/* ---------- hue, saturation, luma ---------- */

/** Hue in degrees 0..360, saturation 0..1 (HSV style) and luma 0..1 of a colour. */
export function hsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: max <= 1e-6 ? 0 : d / max, l: LUMA[0] * r + LUMA[1] * g + LUMA[2] * b };
}

/* ---------- HSL qualifier ---------- */

export type Qualifier = {
  /** Centre hue and the width either side, degrees. */
  hue: number;
  hueWidth: number;
  satLow: number;
  satHigh: number;
  lumLow: number;
  lumHigh: number;
  /** Soft edge, 0..100. */
  softness: number;
  invert: boolean;
};

/** How much of a colour the qualifier selects, 0..1 (1 inside, fading out over the softness). */
export function qualify(q: Qualifier, r: number, g: number, b: number): number {
  const c = hsl(r, g, b);
  const soft = Math.max(0.001, q.softness / 100);
  const band = (v: number, lo: number, hi: number, range: number) => {
    const edge = soft * range;
    return smooth(lo - edge, lo + 1e-6, v) * (1 - smooth(hi - 1e-6, hi + edge, v));
  };
  const dh = Math.abs(((c.h - q.hue + 540) % 360) - 180);
  const hueW = c.s < 0.02 ? 0 : 1 - smooth(q.hueWidth - soft * 90, q.hueWidth + soft * 90 + 1e-6, dh);
  const m = hueW * band(c.s * 100, q.satLow, q.satHigh, 100) * band(c.l * 100, q.lumLow, q.lumHigh, 100);
  return q.invert ? 1 - m : m;
}

/* ---------- .cube LUTs ---------- */

export type Lut3D = { name: string; size: number; /** r fastest, then g, then b; 0..255 */ data: Uint8ClampedArray; /** Input domain, usually 0..1. */ min: number; max: number };

/** Parse an Adobe/Resolve .cube 3D LUT. Throws a readable error when it is not a 3D LUT. */
export function parseCube(text: string, fallbackName = "LUT"): Lut3D {
  let size = 0;
  let name = fallbackName;
  let min = 0;
  let max = 1;
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === "TITLE") name = rest.join(" ").replace(/^"|"$/g, "") || name;
    else if (key === "LUT_3D_SIZE") size = parseInt(rest[0], 10);
    else if (key === "LUT_1D_SIZE") throw new Error("This is a 1D LUT. Cutir reads 3D .cube LUTs.");
    else if (key === "DOMAIN_MIN") min = parseFloat(rest[0]);
    else if (key === "DOMAIN_MAX") max = parseFloat(rest[0]);
    else if (/^[-+\d.]/.test(key)) {
      const a = parseFloat(key);
      const b = parseFloat(rest[0]);
      const c = parseFloat(rest[1]);
      if ([a, b, c].some((v) => !Number.isFinite(v))) throw new Error("A LUT row is not three numbers.");
      vals.push(a, b, c);
    }
  }
  if (!Number.isInteger(size) || size < 2 || size > 128) throw new Error("No LUT_3D_SIZE found (or it is out of range 2..128).");
  if (vals.length !== size * size * size * 3) throw new Error(`Expected ${size * size * size} rows for a ${size}-point LUT, found ${vals.length / 3}.`);
  const data = new Uint8ClampedArray(vals.length);
  const span = max - min || 1;
  for (let i = 0; i < vals.length; i++) data[i] = Math.round(clamp01((vals[i] - min) / span) * 255);
  return { name, size, data, min: 0, max: 1 };
}

/** Trilinear lookup. Input and output 0..1. */
export function sampleLut(l: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = l.size - 1;
  const fr = clamp01(r) * n;
  const fg = clamp01(g) * n;
  const fb = clamp01(b) * n;
  const r0 = Math.min(n - 1, Math.floor(fr));
  const g0 = Math.min(n - 1, Math.floor(fg));
  const b0 = Math.min(n - 1, Math.floor(fb));
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const at = (ri: number, gi: number, bi: number, ch: number) => l.data[((bi * l.size + gi) * l.size + ri) * 3 + ch];
  const out: number[] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const c00 = at(r0, g0, b0, ch) * (1 - dr) + at(r0 + 1, g0, b0, ch) * dr;
    const c10 = at(r0, g0 + 1, b0, ch) * (1 - dr) + at(r0 + 1, g0 + 1, b0, ch) * dr;
    const c01 = at(r0, g0, b0 + 1, ch) * (1 - dr) + at(r0 + 1, g0, b0 + 1, ch) * dr;
    const c11 = at(r0, g0 + 1, b0 + 1, ch) * (1 - dr) + at(r0 + 1, g0 + 1, b0 + 1, ch) * dr;
    out[ch] = ((c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db) / 255;
  }
  return out as [number, number, number];
}

/** A LUT as text-safe data for a project param. */
export function packLut(l: Lut3D): { name: string; size: number; data: string } {
  let s = "";
  for (let i = 0; i < l.data.length; i += 0x8000) s += String.fromCharCode(...l.data.subarray(i, i + 0x8000));
  return { name: l.name, size: l.size, data: btoa(s) };
}
export function unpackLut(v: unknown): Lut3D | null {
  const o = v as { name?: unknown; size?: unknown; data?: unknown } | undefined;
  if (!o || typeof o.data !== "string" || typeof o.size !== "number") return null;
  try {
    const bin = atob(o.data);
    const data = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    if (data.length !== o.size * o.size * o.size * 3) return null;
    return { name: String(o.name ?? "LUT"), size: o.size, data, min: 0, max: 1 };
  } catch {
    return null;
  }
}

/* ---------- colour spaces ---------- */

export type SpaceId = "rec709" | "srgb" | "rec2020" | "p3" | "slog3" | "logc" | "vlog";

export const SPACES: { id: SpaceId; name: string; note: string }[] = [
  { id: "rec709", name: "Rec.709", note: "HD video, gamma 2.4" },
  { id: "srgb", name: "sRGB", note: "Computer screens" },
  { id: "rec2020", name: "Rec.2020", note: "Wide gamut video" },
  { id: "p3", name: "Display P3", note: "Wide gamut screens" },
  { id: "slog3", name: "S-Log3 (Sony)", note: "Camera log, tone curve only" },
  { id: "logc", name: "LogC (ARRI)", note: "Camera log, tone curve only" },
  { id: "vlog", name: "V-Log (Panasonic)", note: "Camera log, tone curve only" },
];

const XYZ_FROM: Record<"rec709" | "rec2020" | "p3", Mat3> = {
  rec709: [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041],
  rec2020: [0.636958, 0.1446169, 0.168881, 0.2627002, 0.6779981, 0.0593017, 0, 0.0280727, 1.0609851],
  p3: [0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0, 0.0451134, 1.0439444],
};

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const gamutOf = (s: SpaceId): keyof typeof XYZ_FROM => (s === "rec2020" ? "rec2020" : s === "p3" ? "p3" : "rec709");

/** Encoded value -> linear light. */
export function decode(s: SpaceId, v: number): number {
  switch (s) {
    case "srgb":
    case "p3":
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    case "slog3":
      return v >= 171.2102946929 / 1023 ? (Math.pow(10, (v * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01) : ((v * 1023 - 95) * 0.01125) / (171.2102946929 - 95);
    case "logc": {
      const cut = 0.010591;
      return v > 5.367655 * cut + 0.092809 ? (Math.pow(10, (v - 0.385537) / 0.24719) - 0.052272) / 5.555556 : (v - 0.092809) / 5.367655;
    }
    case "vlog":
      return v < 0.181 ? (v - 0.125) / 5.6 : Math.pow(10, (v - 0.598206) / 0.241514) - 0.00873;
    default:
      return Math.pow(Math.max(0, v), 2.4); // Rec.709 and Rec.2020 as shown on a display
  }
}

/** Linear light -> encoded value. */
export function encode(s: SpaceId, x: number): number {
  switch (s) {
    case "srgb":
    case "p3":
      return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    case "slog3":
      return x >= 0.01125 ? (420 + Math.log10((x + 0.01) / (0.18 + 0.01)) * 261.5) / 1023 : (x * (171.2102946929 - 95)) / 0.01125 / 1023 + 95 / 1023;
    case "logc": {
      const cut = 0.010591;
      return x > cut ? 0.24719 * Math.log10(5.555556 * x + 0.052272) + 0.385537 : 5.367655 * x + 0.092809;
    }
    case "vlog":
      return x < 0.01 ? 5.6 * x + 0.125 : 0.241514 * Math.log10(x + 0.00873) + 0.598206;
    default:
      return Math.pow(Math.max(0, x), 1 / 2.4);
  }
}

/** The linear-light matrix that carries `from` primaries to `to` primaries (log spaces count as Rec.709 primaries). */
export const gamutMatrix = (from: SpaceId, to: SpaceId): Mat3 => mul3(invert3(XYZ_FROM[gamutOf(to)]), XYZ_FROM[gamutOf(from)]);

export type SpaceTransform = { decode: Float32Array; matrix: Mat3; encode: Uint8ClampedArray; identity: boolean };

/** Tables to move colour from one space to another: decode table (256 -> linear), a matrix, an encode table (4096 -> 0..255). */
export function spaceTransform(from: SpaceId, to: SpaceId): SpaceTransform {
  const dec = new Float32Array(256);
  for (let i = 0; i < 256; i++) dec[i] = decode(from, i / 255);
  const enc = new Uint8ClampedArray(4096);
  for (let i = 0; i < 4096; i++) enc[i] = Math.round(clamp01(encode(to, i / 4095)) * 255);
  return { decode: dec, matrix: gamutMatrix(from, to), encode: enc, identity: from === to };
}

/** One colour through a space transform (for tests); the effect inlines the same steps over a frame. */
export function convertColor(rgb: [number, number, number], from: SpaceId, to: SpaceId): [number, number, number] {
  if (from === to) return rgb;
  const lin = rgb.map((v) => decode(from, v));
  const m = gamutMatrix(from, to);
  return [0, 1, 2].map((r) => clamp01(encode(to, Math.max(0, m[r * 3] * lin[0] + m[r * 3 + 1] * lin[1] + m[r * 3 + 2] * lin[2])))) as [number, number, number];
}
