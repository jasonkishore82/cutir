import type { GpuPass, GpuTable, Params } from "../effects/types";
import { clamp01, colourMatrix, curveTable, evalCurve, gamutMatrix, isIdentityCurve, spaceTransform, toneTables, type Lut3D, type SpaceId } from "./math";
import { readCurves, readGrade, readQualifier, type CurveSet } from "./pixels";
import { unpackLut } from "./math";

/**
 * The graphics card versions of the colour effects (phase 20). They use the same tables as the canvas versions (tone
 * tables, curve tables, the colour matrix, the LUT, the space transform), uploaded as float textures, so the picture
 * matches: the shader only looks values up and mixes them. A setting the shader cannot do (the qualifier matte blur)
 * returns null and the canvas version runs for that frame.
 */

const n = (p: Params, k: string, d = 0) => (typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : d);
const b = (p: Params, k: string) => (p[k] === true ? 1 : 0);

/* ---------- tables (pure: tested in node) ---------- */

/** 256 x 1: the red, green and blue tone tables (0..255) in the channels. */
export function toneTable(p: Params): Float32Array {
  const [tr, tg, tb] = toneTables(readGrade(p));
  const out = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) out.set([tr[i], tg[i], tb[i], 0], i * 4);
  return out;
}

/** The three matrix rows of the grade's saturation and hue. */
export function matrixRows(p: Params): Record<string, number[]> {
  const m = colourMatrix(readGrade(p));
  return { uColRow0: [m[0], m[1], m[2]], uColRow1: [m[3], m[4], m[5]], uColRow2: [m[6], m[7], m[8]] };
}

/** 256 x 1: master then per channel curves, folded into one table per channel (0..255). */
export function curveRgbTable(c: CurveSet): Float32Array {
  const master = curveTable(c.master);
  const tr = curveTable(c.r);
  const tg = curveTable(c.g);
  const tb = curveTable(c.b);
  const out = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) out.set([tr[master[i]], tg[master[i]], tb[master[i]], 0], i * 4);
  return out;
}

/** 360 x 1: per degree of hue, the hue shift in degrees, the saturation multiplier and the brightness added (0..255). */
export function curveHueTable(c: CurveSet): Float32Array {
  const hh = !isIdentityCurve(c.hueVsHue, true);
  const hs = !isIdentityCurve(c.hueVsSat, true);
  const hl = !isIdentityCurve(c.hueVsLuma, true);
  const out = new Float32Array(360 * 4);
  for (let h = 0; h < 360; h++) out.set([hh ? (evalCurve(c.hueVsHue, h / 360) - 0.5) * 120 : 0, hs ? evalCurve(c.hueVsSat, h / 360) * 2 : 1, hl ? (evalCurve(c.hueVsLuma, h / 360) - 0.5) * 255 : 0, 0], h * 4);
  return out;
}

/** 256 x 1: red = saturation multiplier by brightness, green = by saturation (first 101 entries). */
export function curveLumSatTable(c: CurveSet): Float32Array {
  const ls = !isIdentityCurve(c.lumaVsSat, true);
  const ss = !isIdentityCurve(c.satVsSat, true);
  const out = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) out.set([ls ? evalCurve(c.lumaVsSat, i / 255) * 2 : 1, ss && i <= 100 ? evalCurve(c.satVsSat, i / 100) * 2 : 1, 0, 0], i * 4);
  return out;
}

/** (size * size) x size: texel (green * size + red, blue) holds the output colour (0..255), the order of the .cube data. */
export function lutTexture(l: Lut3D): Float32Array {
  const out = new Float32Array(l.size * l.size * l.size * 4);
  for (let i = 0; i < l.size * l.size * l.size; i++) out.set([l.data[i * 3], l.data[i * 3 + 1], l.data[i * 3 + 2], 0], i * 4);
  return out;
}

/** 256 x 1 decode table (linear light, red channel) and a 64 x 64 encode table (0..255, red channel) for a space move. */
export function decodeTable(from: SpaceId, to: SpaceId): Float32Array {
  const t = spaceTransform(from, to);
  const out = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) out[i * 4] = t.decode[i];
  return out;
}
export function encodeTable(from: SpaceId, to: SpaceId): Float32Array {
  const t = spaceTransform(from, to);
  const out = new Float32Array(4096 * 4);
  for (let i = 0; i < 4096; i++) out[i * 4] = t.encode[i];
  return out;
}

const tbl = (key: string, w: number, h: number, build: () => Float32Array): GpuTable => ({ key, w, h, build });

/* ---------- shader pieces ---------- */

const COMMON = `
vec3 hsl3(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) h = mod((c.g - c.b) / d + 6.0, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
  }
  return vec3(h, mx <= 1e-6 ? 0.0 : d / mx, dot(c, vec3(0.2126, 0.7152, 0.0722)));
}
float sm(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float band(float v, float lo, float hi, float range, float soft) {
  float edge = soft * range;
  return sm(lo - edge, lo + 1e-6, v) * (1.0 - sm(hi - 1e-6, hi + edge, v));
}
ivec3 bytes(vec3 c) { return ivec3(floor(c * 255.0 + 0.5)); }
`;

/* ---------- Colour grade ---------- */

export const gradeGpu: GpuPass = {
  fragment: `${COMMON}
float qualify(vec3 c) {
  vec3 h = hsl3(c);
  float soft = max(0.001, uQSoft / 100.0);
  float dh = abs(mod(h.x - uQHue + 540.0, 360.0) - 180.0);
  float hueW = h.y < 0.02 ? 0.0 : 1.0 - sm(uQWidth - soft * 90.0, uQWidth + soft * 90.0 + 1e-6, dh);
  float m = hueW * band(h.y * 100.0, uQSatLow, uQSatHigh, 100.0, soft) * band(h.z * 100.0, uQLumLow, uQLumHigh, 100.0, soft);
  return uQInvert > 0.5 ? 1.0 - m : m;
}
void main() {
  vec4 c = texture(uTex, vUv);
  if (c.a == 0.0) { outColor = c; return; }
  ivec3 i = bytes(c.rgb);
  vec3 t = vec3(texelFetch(uTbl_tone, ivec2(i.r, 0), 0).r, texelFetch(uTbl_tone, ivec2(i.g, 0), 0).g, texelFetch(uTbl_tone, ivec2(i.b, 0), 0).b) / 255.0;
  vec3 o = vec3(dot(uColRow0, t), dot(uColRow1, t), dot(uColRow2, t));
  float w = uMix;
  if (uQualify > 0.5) {
    float sel = qualify(c.rgb);
    if (uQShow > 0.5) { outColor = vec4(vec3(sel), c.a); return; }
    w *= sel;
  }
  outColor = vec4(clamp(mix(c.rgb, o, w), 0.0, 1.0), c.a);
}`,
  uniforms: (p) => {
    if (b(p, "qualify") && n(p, "qBlur", 0) > 0) return null; // the matte blur needs neighbours: canvas version
    const q = readQualifier(p);
    return {
      ...matrixRows(p),
      uMix: clamp01(n(p, "mix", 100) / 100),
      uQualify: b(p, "qualify"),
      uQShow: b(p, "qShow"),
      uQInvert: q.invert ? 1 : 0,
      uQHue: q.hue,
      uQWidth: q.hueWidth,
      uQSatLow: q.satLow,
      uQSatHigh: q.satHigh,
      uQLumLow: q.lumLow,
      uQLumHigh: q.lumHigh,
      uQSoft: q.softness,
    };
  },
  tables: (p) => {
    const g = readGrade(p);
    return { tone: tbl(JSON.stringify(g), 256, 1, () => toneTable(p)) };
  },
};

/* ---------- Curves ---------- */

export const curvesGpu: GpuPass = {
  fragment: `${COMMON}
void main() {
  vec4 c = texture(uTex, vUv);
  if (c.a == 0.0) { outColor = c; return; }
  ivec3 i = bytes(c.rgb);
  vec3 v = vec3(texelFetch(uTbl_rgb, ivec2(i.r, 0), 0).r, texelFetch(uTbl_rgb, ivec2(i.g, 0), 0).g, texelFetch(uTbl_rgb, ivec2(i.b, 0), 0).b) / 255.0;
  if (uHue > 0.5) {
    vec3 col = hsl3(v);
    int h = min(359, int(floor(col.x)));
    vec4 hr = texelFetch(uTbl_hue, ivec2(h, 0), 0);
    float a = radians(hr.x);
    float cs = cos(a);
    float sn = sin(a);
    float k = 1.0 / 3.0;
    float q = sqrt(k) * sn;
    vec3 m0 = vec3(cs + (1.0 - cs) * k, k * (1.0 - cs) - q, k * (1.0 - cs) + q);
    vec3 m1 = vec3(k * (1.0 - cs) + q, cs + k * (1.0 - cs), k * (1.0 - cs) - q);
    vec3 m2 = vec3(k * (1.0 - cs) - q, k * (1.0 - cs) + q, cs + k * (1.0 - cs));
    vec3 r2 = vec3(dot(m0, v), dot(m1, v), dot(m2, v));
    float lumK = texelFetch(uTbl_ls, ivec2(min(255, int(floor(col.z * 255.0 + 0.5))), 0), 0).r;
    float satK = texelFetch(uTbl_ls, ivec2(min(100, int(floor(col.y * 100.0 + 0.5))), 0), 0).g;
    float k2 = col.y < 0.02 ? 1.0 : hr.y * lumK * satK;
    float y = dot(r2, vec3(0.2126, 0.7152, 0.0722));
    r2 = y + (r2 - y) * k2;
    float dl = col.y < 0.02 ? 0.0 : hr.z / 255.0 * min(1.0, col.y * 2.0);
    v = r2 + dl;
  }
  outColor = vec4(clamp(mix(c.rgb, v, uMix), 0.0, 1.0), c.a);
}`,
  uniforms: (p) => {
    const c = readCurves(p);
    const hue = ![c.hueVsHue, c.hueVsSat, c.lumaVsSat, c.hueVsLuma, c.satVsSat].every((x) => isIdentityCurve(x, true));
    return { uMix: clamp01(n(p, "mix", 100) / 100), uHue: hue ? 1 : 0 };
  },
  tables: (p) => {
    const c = readCurves(p);
    const k = (...v: unknown[]) => JSON.stringify(v);
    return {
      rgb: tbl(k(c.master, c.r, c.g, c.b), 256, 1, () => curveRgbTable(c)),
      hue: tbl(k(c.hueVsHue, c.hueVsSat, c.hueVsLuma), 360, 1, () => curveHueTable(c)),
      ls: tbl(k(c.lumaVsSat, c.satVsSat), 256, 1, () => curveLumSatTable(c)),
    };
  },
};

/* ---------- LUT ---------- */

const lutKeys = new WeakMap<object, number>();
let lutSeq = 0;
const unpacked = new WeakMap<object, Lut3D | null>();
const lutOf = (p: Params): Lut3D | null => {
  const v = p.lut as object | null;
  if (!v) return null;
  let l = unpacked.get(v);
  if (l === undefined) unpacked.set(v, (l = unpackLut(v)));
  return l;
};

export const lutGpu: GpuPass = {
  fragment: `${COMMON}
vec3 at(int ri, int gi, int bi) { return texelFetch(uTbl_lut, ivec2(gi * int(uLutN) + ri, bi), 0).rgb / 255.0; }
void main() {
  vec4 c = texture(uTex, vUv);
  if (c.a == 0.0) { outColor = c; return; }
  float n = uLutN - 1.0;
  vec3 f = clamp(c.rgb, 0.0, 1.0) * n;
  vec3 b0f = min(vec3(n - 1.0), floor(f));
  vec3 d = f - b0f;
  ivec3 b0 = ivec3(b0f);
  vec3 c00 = at(b0.r, b0.g, b0.b) * (1.0 - d.r) + at(b0.r + 1, b0.g, b0.b) * d.r;
  vec3 c10 = at(b0.r, b0.g + 1, b0.b) * (1.0 - d.r) + at(b0.r + 1, b0.g + 1, b0.b) * d.r;
  vec3 c01 = at(b0.r, b0.g, b0.b + 1) * (1.0 - d.r) + at(b0.r + 1, b0.g, b0.b + 1) * d.r;
  vec3 c11 = at(b0.r, b0.g + 1, b0.b + 1) * (1.0 - d.r) + at(b0.r + 1, b0.g + 1, b0.b + 1) * d.r;
  vec3 o = (c00 * (1.0 - d.g) + c10 * d.g) * (1.0 - d.b) + (c01 * (1.0 - d.g) + c11 * d.g) * d.b;
  outColor = vec4(clamp(mix(c.rgb, o, uMix), 0.0, 1.0), c.a);
}`,
  uniforms: (p) => {
    const v = p.lut as object | null;
    if (!v || !lutOf(p)) return null; // no LUT: the canvas version draws the clip unchanged
    return { uMix: clamp01(n(p, "intensity", 100) / 100), uLutN: (v as { size: number }).size };
  },
  tables: (p) => {
    const v = p.lut as object;
    let id = lutKeys.get(v);
    if (id === undefined) lutKeys.set(v, (id = ++lutSeq));
    const size = (v as { size: number }).size;
    return { lut: tbl(`lut${id}`, size * size, size, () => lutTexture(lutOf(p)!)) };
  },
};

/* ---------- Colour space transform ---------- */

export const colourSpaceGpu: GpuPass = {
  fragment: `${COMMON}
void main() {
  vec4 c = texture(uTex, vUv);
  if (c.a == 0.0 || uSkip > 0.5) { outColor = c; return; }
  ivec3 i = bytes(c.rgb);
  vec3 lin = vec3(texelFetch(uTbl_dec, ivec2(i.r, 0), 0).r, texelFetch(uTbl_dec, ivec2(i.g, 0), 0).r, texelFetch(uTbl_dec, ivec2(i.b, 0), 0).r);
  vec3 m = vec3(dot(uColRow0, lin), dot(uColRow1, lin), dot(uColRow2, lin));
  ivec3 e = ivec3(clamp(floor(m * 4095.0 + 0.5), 0.0, 4095.0));
  vec3 o = vec3(texelFetch(uTbl_enc, ivec2(e.r % 64, e.r / 64), 0).r, texelFetch(uTbl_enc, ivec2(e.g % 64, e.g / 64), 0).r, texelFetch(uTbl_enc, ivec2(e.b % 64, e.b / 64), 0).r) / 255.0;
  outColor = vec4(o, c.a);
}`,
  uniforms: (p) => {
    const from = String(p.from ?? "slog3") as SpaceId;
    const to = String(p.to ?? "rec709") as SpaceId;
    const m = gamutMatrix(from, to);
    return { uSkip: from === to ? 1 : 0, uColRow0: [m[0], m[1], m[2]], uColRow1: [m[3], m[4], m[5]], uColRow2: [m[6], m[7], m[8]] };
  },
  tables: (p) => {
    const from = String(p.from ?? "slog3") as SpaceId;
    const to = String(p.to ?? "rec709") as SpaceId;
    return { dec: tbl(`${from}>${to}`, 256, 1, () => decodeTable(from, to)), enc: tbl(`${from}>${to}`, 64, 64, () => encodeTable(from, to)) };
  },
};
