// Phase 20: the graphics card versions of the colour effects. The shaders cannot run in node, so this checks what can go
// wrong around them: the tables they read equal the canvas version's tables, the uniforms and tables the shader text
// names are the ones supplied, and settings the shader cannot do fall back to the canvas version.
import { colourSpaceGpu, curveHueTable, curveLumSatTable, curveRgbTable, curvesGpu, decodeTable, encodeTable, gradeGpu, lutGpu, lutTexture, matrixRows, toneTable } from "../src/lib/grade/gpu";
import { colourMatrix, curveTable, evalCurve, gamutMatrix, packLut, parseCube, spaceTransform, toneTables, type Lut3D } from "../src/lib/grade/math";
import { readCurves, readGrade } from "../src/lib/grade/pixels";
import { getEffect } from "../src/lib/effects";
import type { EffectEnv, GpuPass, Params } from "../src/lib/effects/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
};
const env = { w: 4, h: 4, time: 0, clipDuration: 1, scratch: () => null as never } as EffectEnv;
const near = (a: number, b: number, e = 1e-5) => Math.abs(a - b) < e;

const wired = (name: string, pass: GpuPass, p: Params) => {
  const u = pass.uniforms(p, env);
  const t = pass.tables?.(p, env) ?? {};
  check(`${name}: has a shader, uniforms and tables`, !!u && pass.fragment.includes("void main"));
  const used = new Set([...pass.fragment.matchAll(/\b(u[A-Z]\w*)\b/g)].map((m) => m[1]).filter((n) => !["uTex", "uSize", "uTime"].includes(n)));
  const have = new Set([...Object.keys(u ?? {})]);
  const missing = [...used].filter((n) => !have.has(n) && !n.startsWith("uTbl_"));
  check(`${name}: every uniform the shader reads is supplied`, missing.length === 0, missing);
  const unused = [...have].filter((n) => !used.has(n));
  check(`${name}: no uniform is supplied that the shader ignores`, unused.length === 0, unused);
  const tablesUsed = new Set([...pass.fragment.matchAll(/uTbl_(\w+)/g)].map((m) => m[1]));
  check(`${name}: tables supplied are the tables read`, JSON.stringify([...tablesUsed].sort()) === JSON.stringify(Object.keys(t).sort()), [[...tablesUsed], Object.keys(t)]);
  for (const [k, tb] of Object.entries(t)) check(`${name}: table ${k} is ${tb.w} x ${tb.h} RGBA floats`, tb.build().length === tb.w * tb.h * 4);
  return { u, t };
};

/* ---------- the effects use them ---------- */
check("all four colour effects have a GPU path", ["grade", "curves", "lut", "colour-space"].every((id) => !!getEffect(id)?.gpu));

/* ---------- grade ---------- */
const gp: Params = { liftM: 12, gainR: -20, gammaB: 30, offsetG: 5, contrast: 25, pivot: 40, saturation: 30, hue: 20, temperature: 10, tint: -8, highlights: -15, shadows: 20, mix: 80, qualify: true, qHue: 120, qWidth: 40, qSoft: 30, qSatLow: 10, qSatHigh: 90, qLumLow: 5, qLumHigh: 95, qInvert: true };
const { u: gu, t: gt } = wired("grade", gradeGpu, gp);
const tones = toneTables(readGrade(gp));
const tt = toneTable(gp);
check("grade: the tone table holds the three CPU tables", [0, 17, 128, 200, 255].every((i) => tt[i * 4] === tones[0][i] && tt[i * 4 + 1] === tones[1][i] && tt[i * 4 + 2] === tones[2][i]));
const m = colourMatrix(readGrade(gp));
const rows = matrixRows(gp);
check("grade: the matrix rows are the CPU matrix", JSON.stringify([rows.uColRow0, rows.uColRow1, rows.uColRow2]) === JSON.stringify([[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]]));
check("grade: amount and qualifier settings reach the shader", near(gu!.uMix as number, 0.8) && gu!.uQualify === 1 && gu!.uQInvert === 1 && gu!.uQHue === 120 && gu!.uQSoft === 30);
check("grade: the table key changes with the grade and not with the amount", gradeGpu.tables!({ ...gp, contrast: 26 }, env).tone.key !== gt.tone.key && gradeGpu.tables!({ ...gp, mix: 10 }, env).tone.key === gt.tone.key);
check("grade: the matte blur needs the canvas version", gradeGpu.uniforms({ ...gp, qBlur: 20 }, env) === null);
check("grade: blur without the qualifier is fine on the card", gradeGpu.uniforms({ ...gp, qualify: false, qBlur: 20 }, env) !== null);
check("grade: a neutral grade gives identity tables and matrix", (() => { const t = toneTable({}); const r = matrixRows({}); return [0, 99, 255].every((i) => t[i * 4] === i && t[i * 4 + 1] === i && t[i * 4 + 2] === i) && JSON.stringify(r.uColRow0) === "[1,0,0]"; })());

/* ---------- curves ---------- */
const cp: Params = {
  master: [[0, 0], [0.5, 0.65], [1, 1]],
  red: [[0, 0], [1, 0.9]],
  hueVsHue: [[0, 0.5], [0.3, 0.7], [1, 0.5]],
  hueVsSat: [[0, 0.5], [0.5, 0.8], [1, 0.5]],
  lumaVsSat: [[0, 0.5], [1, 0.3]],
  hueVsLuma: [[0, 0.5], [0.6, 0.6], [1, 0.5]],
  satVsSat: [[0, 0.5], [1, 0.9]],
  mix: 60,
};
const { u: cu } = wired("curves", curvesGpu, cp);
const cs = readCurves(cp);
const rgb = curveRgbTable(cs);
const master = curveTable(cs.master);
const red = curveTable(cs.r);
const green = curveTable(cs.g);
check("curves: master then channel, folded into one table", [0, 40, 128, 255].every((i) => rgb[i * 4] === red[master[i]] && rgb[i * 4 + 1] === green[master[i]]));
const hue = curveHueTable(cs);
check("curves: hue table = shift in degrees, saturation multiplier, brightness", [0, 100, 359].every((h) => near(hue[h * 4], (evalCurve(cs.hueVsHue, h / 360) - 0.5) * 120) && near(hue[h * 4 + 1], evalCurve(cs.hueVsSat, h / 360) * 2) && near(hue[h * 4 + 2], (evalCurve(cs.hueVsLuma, h / 360) - 0.5) * 255)));
const ls = curveLumSatTable(cs);
check("curves: luma and saturation tables", near(ls[200 * 4], evalCurve(cs.lumaVsSat, 200 / 255) * 2) && near(ls[50 * 4 + 1], evalCurve(cs.satVsSat, 0.5) * 2) && ls[200 * 4 + 1] === 1);
check("curves: the hue stage is on when a hue curve is used", cu!.uHue === 1 && near(cu!.uMix as number, 0.6));
check("curves: plain RGB curves leave the hue stage off", curvesGpu.uniforms({ master: [[0, 0], [1, 0.8]] }, env)!.uHue === 0);
check("curves: flat hue curves give identity hue tables", (() => { const h = curveHueTable({}); const l = curveLumSatTable({}); return h[0] === 0 && h[1] === 1 && h[2] === 0 && l[0] === 1 && l[1] === 1; })());

/* ---------- LUT ---------- */
const size = 3;
const data = new Uint8ClampedArray(size * size * size * 3).map((_, i) => (i * 7) % 256);
const lut: Lut3D = { name: "t", size, data, min: 0, max: 1 };
const tex = lutTexture(lut);
check("lut: texel (green * size + red, blue) is the .cube row", [[0, 0, 0], [2, 1, 0], [1, 2, 2], [2, 2, 2]].every(([r, g, b]) => { const idx = (b * size + g) * size + r; const x = g * size + r; const o = (b * size * size + x) * 4; return tex[o] === data[idx * 3] && tex[o + 1] === data[idx * 3 + 1] && tex[o + 2] === data[idx * 3 + 2]; }));
const packed = packLut(lut);
const lp: Params = { lut: packed, intensity: 50 };
const { u: lu, t: lt } = wired("lut", lutGpu, lp);
check("lut: size and intensity reach the shader", lu!.uLutN === size && near(lu!.uMix as number, 0.5));
check("lut: the table is (size * size) x size", lt.lut.w === size * size && lt.lut.h === size);
check("lut: the same LUT keeps its table, another one gets a new key", lutGpu.tables!(lp, env).lut.key === lt.lut.key && lutGpu.tables!({ lut: packLut({ ...lut, name: "u" }), intensity: 50 }, env).lut.key !== lt.lut.key);
check("lut: no LUT chosen means the canvas version", lutGpu.uniforms({ lut: null }, env) === null && lutGpu.uniforms({ lut: { size: 2, data: "x" } }, env) === null);
const cube = parseCube(["LUT_3D_SIZE 2", ...Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`)].join("\n"));
check("lut: an identity .cube round trips through the texture", (() => { const t = lutTexture(cube); const o = (1 * 2 * 2 + 1 * 2 + 0) * 4; return t[o] === 0 && t[o + 1] === 255 && t[o + 2] === 255; })());

/* ---------- colour space ---------- */
const sp: Params = { from: "slog3", to: "rec709" };
const { u: su } = wired("colour-space", colourSpaceGpu, sp);
const tr = spaceTransform("slog3", "rec709");
const dec = decodeTable("slog3", "rec709");
const enc = encodeTable("slog3", "rec709");
check("colour space: decode and encode tables are the CPU tables", [0, 100, 255].every((i) => near(dec[i * 4], tr.decode[i])) && [0, 1000, 4095].every((i) => enc[i * 4] === tr.encode[i]));
const gm = gamutMatrix("rec2020", "rec709");
const su2 = colourSpaceGpu.uniforms({ from: "rec2020", to: "rec709" }, env)!;
check("colour space: the gamut matrix rows are right", JSON.stringify(su2.uColRow1) === JSON.stringify([gm[3], gm[4], gm[5]]) && su!.uSkip === 0);
check("colour space: same space in and out passes through", colourSpaceGpu.uniforms({ from: "srgb", to: "srgb" }, env)!.uSkip === 1);
check("colour space: the encode table is 64 x 64", colourSpaceGpu.tables!(sp, env).enc.w === 64 && colourSpaceGpu.tables!(sp, env).enc.h === 64);

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
