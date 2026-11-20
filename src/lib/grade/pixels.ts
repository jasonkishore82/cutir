import { LINEAR_CURVE, FLAT_CURVE, NEUTRAL_GRADE, clamp01, colourMatrix, curveTable, evalCurve, hsl, isIdentityCurve, mul3, hueMatrix, sampleLut, spaceTransform, toneTables, qualify, unpackLut, type CurvePoints, type Grade, type Lut3D, type Qualifier, type SpaceId, type Wheel } from "./math";
import type { Params } from "../effects/types";

/** Pixel loops of the colour effects, on the RGBA bytes of an ImageData (alpha is left alone). */

const n = (p: Params, k: string, d = 0) => (typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : d);
const b = (p: Params, k: string) => p[k] === true;

const wheel = (p: Params, name: string): Wheel => ({ r: n(p, `${name}R`), g: n(p, `${name}G`), b: n(p, `${name}B`), m: n(p, `${name}M`) });

export function readGrade(p: Params): Grade {
  return {
    lift: wheel(p, "lift"),
    gamma: wheel(p, "gamma"),
    gain: wheel(p, "gain"),
    offset: wheel(p, "offset"),
    contrast: n(p, "contrast"),
    pivot: n(p, "pivot", NEUTRAL_GRADE.pivot),
    saturation: n(p, "saturation"),
    hue: n(p, "hue"),
    temperature: n(p, "temperature"),
    tint: n(p, "tint"),
    highlights: n(p, "highlights"),
    shadows: n(p, "shadows"),
  };
}

export function readQualifier(p: Params): Qualifier {
  return { hue: n(p, "qHue", 0), hueWidth: n(p, "qWidth", 30), satLow: n(p, "qSatLow", 0), satHigh: n(p, "qSatHigh", 100), lumLow: n(p, "qLumLow", 0), lumHigh: n(p, "qLumHigh", 100), softness: n(p, "qSoft", 20), invert: b(p, "qInvert") };
}

/** Blend `after` into the pixel by `m` (0..1), writing 0..255 into data. */
const put = (d: Uint8ClampedArray, i: number, r0: number, g0: number, b0: number, r1: number, g1: number, b1: number, m: number) => {
  d[i] = r0 + (r1 - r0) * m;
  d[i + 1] = g0 + (g1 - g0) * m;
  d[i + 2] = b0 + (b1 - b0) * m;
};

/** The primary grade over a frame, optionally limited by an HSL qualifier and mixed with the original. */
export function gradePixels(d: Uint8ClampedArray, p: Params): void {
  const g = readGrade(p);
  const [tr, tg, tb] = toneTables(g);
  const m = colourMatrix(g);
  const mix = clamp01(n(p, "mix", 100) / 100);
  const useQ = b(p, "qualify");
  const q = readQualifier(p);
  const show = useQ && b(p, "qShow");
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i];
    const gg = d[i + 1];
    const bb = d[i + 2];
    const a = tr[r] / 255;
    const c = tg[gg] / 255;
    const e = tb[bb] / 255;
    const r1 = (m[0] * a + m[1] * c + m[2] * e) * 255;
    const g1 = (m[3] * a + m[4] * c + m[5] * e) * 255;
    const b1 = (m[6] * a + m[7] * c + m[8] * e) * 255;
    let w = mix;
    if (useQ) {
      const sel = qualify(q, r / 255, gg / 255, bb / 255);
      if (show) {
        const v = sel * 255;
        d[i] = d[i + 1] = d[i + 2] = v;
        continue;
      }
      w *= sel;
    }
    put(d, i, r, gg, bb, r1, g1, b1, w);
  }
}

export type CurveSet = { master?: CurvePoints; r?: CurvePoints; g?: CurvePoints; b?: CurvePoints; hueVsHue?: CurvePoints; hueVsSat?: CurvePoints; lumaVsSat?: CurvePoints };

export function readCurves(p: Params): CurveSet {
  const c = (k: string) => (Array.isArray(p[k]) ? (p[k] as CurvePoints) : undefined);
  return { master: c("master"), r: c("red"), g: c("green"), b: c("blue"), hueVsHue: c("hueVsHue"), hueVsSat: c("hueVsSat"), lumaVsSat: c("lumaVsSat") };
}

/** RGB curves (master then per channel) and the hue and luma curves. */
export function curvePixels(d: Uint8ClampedArray, c: CurveSet, mixPct = 100): void {
  const master = curveTable(c.master);
  const tr = curveTable(c.r);
  const tg = curveTable(c.g);
  const tb = curveTable(c.b);
  const rgbFlat = isIdentityCurve(c.master) && isIdentityCurve(c.r) && isIdentityCurve(c.g) && isIdentityCurve(c.b);
  const hh = !isIdentityCurve(c.hueVsHue, true);
  const hs = !isIdentityCurve(c.hueVsSat, true);
  const ls = !isIdentityCurve(c.lumaVsSat, true);
  // per degree: the hue shift as a rotation matrix and the saturation multiplier
  const rot: number[][] = [];
  const hueSat = new Float32Array(360);
  for (let h = 0; h < 360; h++) {
    rot.push(hh ? hueMatrix((evalCurve(c.hueVsHue, h / 360) - 0.5) * 120) : [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    hueSat[h] = hs ? evalCurve(c.hueVsSat, h / 360) * 2 : 1;
  }
  const lumSat = new Float32Array(256);
  for (let i = 0; i < 256; i++) lumSat[i] = ls ? evalCurve(c.lumaVsSat, i / 255) * 2 : 1;
  const mix = clamp01(mixPct / 100);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r0 = d[i];
    const g0 = d[i + 1];
    const b0 = d[i + 2];
    let r = r0;
    let g = g0;
    let bl = b0;
    if (!rgbFlat) {
      r = tr[master[r]];
      g = tg[master[g]];
      bl = tb[master[bl]];
    }
    if (hh || hs || ls) {
      const col = hsl(r / 255, g / 255, bl / 255);
      const h = Math.min(359, Math.floor(col.h));
      const m = rot[h];
      let r2 = m[0] * r + m[1] * g + m[2] * bl;
      let g2 = m[3] * r + m[4] * g + m[5] * bl;
      let b2 = m[6] * r + m[7] * g + m[8] * bl;
      // saturation scales with how far the colour is from its own colour (only where it has colour)
      const k = col.s < 0.02 ? 1 : hueSat[h] * lumSat[Math.min(255, Math.round(col.l * 255))];
      const y = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
      r2 = y + (r2 - y) * k;
      g2 = y + (g2 - y) * k;
      b2 = y + (b2 - y) * k;
      r = r2;
      g = g2;
      bl = b2;
    }
    put(d, i, r0, g0, b0, r, g, bl, mix);
  }
}

/** A 3D LUT over a frame with an intensity (0..100). */
export function lutPixels(d: Uint8ClampedArray, lut: Lut3D, intensity = 100): void {
  const mix = clamp01(intensity / 100);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [r, g, bl] = sampleLut(lut, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    put(d, i, d[i], d[i + 1], d[i + 2], r * 255, g * 255, bl * 255, mix);
  }
}

/** Move a frame between colour spaces. */
export function spacePixels(d: Uint8ClampedArray, from: SpaceId, to: SpaceId): void {
  if (from === to) return;
  const t = spaceTransform(from, to);
  const m = t.matrix;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = t.decode[d[i]];
    const g = t.decode[d[i + 1]];
    const bl = t.decode[d[i + 2]];
    const idx = (v: number) => (v <= 0 ? 0 : v >= 1 ? 4095 : Math.round(v * 4095));
    d[i] = t.encode[idx(m[0] * r + m[1] * g + m[2] * bl)];
    d[i + 1] = t.encode[idx(m[3] * r + m[4] * g + m[5] * bl)];
    d[i + 2] = t.encode[idx(m[6] * r + m[7] * g + m[8] * bl)];
  }
}

export { LINEAR_CURVE, FLAT_CURVE, mul3, unpackLut };
