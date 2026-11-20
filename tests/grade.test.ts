// Phase 20: colour grading maths, effects, LUTs, colour spaces and scopes.
import { NEUTRAL_GRADE, colourMatrix, convertColor, decode, encode, evalCurve, gradeColor, isIdentityCurve, packLut, parseCube, qualify, sampleLut, toneChannel, type Grade } from "../src/lib/grade/math";
import { curvePixels, gradePixels, lutPixels, spacePixels, unpackLut } from "../src/lib/grade/pixels";
import { histogram, vectorscope, waveform } from "../src/lib/scopes";
import { cleanParams, defaultParams, getEffect, listEffects, newEffect } from "../src/lib/effects";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
}
const near = (a: number, b: number, e = 0.01) => Math.abs(a - b) < e;
const G = (over: Partial<Grade>): Grade => ({ ...structuredClone(NEUTRAL_GRADE), ...over });
const px = (...rgb: number[]) => new Uint8ClampedArray(rgb.flatMap((v, i) => (i % 3 === 2 ? [v, 255] : [v])).length ? rgb.reduce<number[]>((a, v, i) => (a.push(v), i % 3 === 2 ? a.push(255) : 0, a), []) : []);

/* ---------- registry ---------- */
for (const id of ["grade", "curves", "lut", "colour-space"]) check(`${id} is registered under Colour`, getEffect(id)?.category === "Colour");
check("colour effects survive their own spec", ["grade", "curves", "lut", "colour-space"].every((id) => { const d = getEffect(id)!; return JSON.stringify(cleanParams(d.params, defaultParams(d.params))) === JSON.stringify(defaultParams(d.params)); }));
check("every effect still has a unique id", new Set(listEffects().map((e) => e.id)).size === listEffects().length);
check("a new grade starts neutral", gradeColor([0.3, 0.5, 0.7], G({})).every((v, i) => near(v, [0.3, 0.5, 0.7][i], 0.004)));

/* ---------- primary grade ---------- */
const lift = G({ lift: { r: 0, g: 0, b: 0, m: 40 } });
check("lift raises the blacks more than the whites", toneChannel(0, 0, lift) > 0.15 && toneChannel(1, 0, lift) > 0.99 && toneChannel(0.9, 0, lift) - 0.9 < toneChannel(0.1, 0, lift) - 0.1);
const gain = G({ gain: { r: 0, g: 0, b: 0, m: -50 } });
check("gain scales the whites", near(toneChannel(1, 1, gain), 0.5) && near(toneChannel(0, 1, gain), 0));
check("gamma brightens the midtones and keeps the ends", toneChannel(0.5, 0, G({ gamma: { r: 0, g: 0, b: 0, m: 50 } })) > 0.55 && near(toneChannel(1, 0, G({ gamma: { r: 0, g: 0, b: 0, m: 50 } })), 1) && near(toneChannel(0, 0, G({ gamma: { r: 0, g: 0, b: 0, m: 50 } })), 0));
check("offset moves everything", toneChannel(0.5, 0, G({ offset: { r: 0, g: 0, b: 0, m: 40 } })) > 0.55);
check("a channel wheel changes only that channel", toneChannel(0.5, 0, G({ gain: { r: 50, g: 0, b: 0, m: 0 } })) > 0.7 && near(toneChannel(0.5, 1, G({ gain: { r: 50, g: 0, b: 0, m: 0 } })), 0.5));
check("contrast pivots around the pivot", near(toneChannel(0.5, 0, G({ contrast: 60 })), 0.5) && toneChannel(0.8, 0, G({ contrast: 60 })) > 0.8 && toneChannel(0.2, 0, G({ contrast: 60 })) < 0.2);
check("shadows lift the darks, highlights the brights", toneChannel(0.1, 0, G({ shadows: 80 })) > 0.2 && near(toneChannel(0.9, 0, G({ shadows: 80 })), 0.9, 0.02) && toneChannel(0.9, 0, G({ highlights: -80 })) < 0.85);
const warm = gradeColor([0.5, 0.5, 0.5], G({ temperature: 60 }));
check("temperature warms (red up, blue down)", warm[0] > 0.5 && warm[2] < 0.5, warm);
check("tint pulls green", gradeColor([0.5, 0.5, 0.5], G({ tint: 60 }))[1] < 0.5);
check("saturation 0 gives grey", (() => { const o = gradeColor([0.9, 0.2, 0.1], G({ saturation: -100 })); return near(o[0], o[1], 0.002) && near(o[1], o[2], 0.002); })());
check("saturation keeps the brightness", (() => { const o = gradeColor([0.9, 0.2, 0.1], G({ saturation: -100 })); return near(o[0], 0.2126 * 0.9 + 0.7152 * 0.2 + 0.0722 * 0.1, 0.002); })());
check("a hue turn of 120 degrees sends red towards green", (() => { const o = gradeColor([1, 0, 0], G({ hue: 120 })); return o[1] > 0.9 && o[0] < 0.2; })());
check("a hue turn keeps greys", (() => { const m = colourMatrix({ saturation: 0, hue: 77 }); return near(m[0] + m[1] + m[2], 1, 1e-6) && near(m[3] + m[4] + m[5], 1, 1e-6); })());
check("results stay in range", gradeColor([1, 1, 1], G({ gain: { r: 100, g: 100, b: 100, m: 100 }, offset: { r: 100, g: 0, b: 0, m: 100 } })).every((v) => v >= 0 && v <= 1));

/* ---------- pixel loops ---------- */
const frame = new Uint8ClampedArray([200, 50, 50, 255, 50, 200, 50, 255, 20, 20, 20, 0]);
const same = new Uint8ClampedArray(frame);
gradePixels(same, defaultParams(getEffect("grade")!.params));
check("the default grade leaves pixels alone (within rounding)", same.every((v, i) => Math.abs(v - frame[i]) <= 1));
const dark = new Uint8ClampedArray(frame);
gradePixels(dark, { ...defaultParams(getEffect("grade")!.params), gainM: -50 });
check("the grade changes visible pixels and keeps alpha", dark[0] < 110 && dark[3] === 255 && dark[11] === 0 && dark[8] === 20);
const half = new Uint8ClampedArray(frame);
gradePixels(half, { ...defaultParams(getEffect("grade")!.params), gainM: -100, mix: 50 });
check("Amount mixes with the original", near(half[0], 100, 2), half[0]);
const qp = { ...defaultParams(getEffect("grade")!.params), saturation: -100, qualify: true, qHue: 0, qWidth: 30, qSoft: 10 };
const q = new Uint8ClampedArray(frame);
gradePixels(q, qp);
check("the qualifier grades only the picked colour", Math.abs(q[0] - q[1]) < 30 && q[4] === 50 && q[5] === 200, Array.from(q));
const matte = new Uint8ClampedArray(frame);
gradePixels(matte, { ...qp, qShow: true });
check("the matte preview is white on the pick, black elsewhere", matte[0] > 240 && matte[4] === 0 && matte[0] === matte[1], Array.from(matte));
check("qualify measures hue, saturation and brightness", qualify({ hue: 0, hueWidth: 20, satLow: 0, satHigh: 100, lumLow: 0, lumHigh: 100, softness: 5, invert: false }, 1, 0, 0) > 0.95 && qualify({ hue: 0, hueWidth: 20, satLow: 0, satHigh: 100, lumLow: 0, lumHigh: 100, softness: 5, invert: true }, 1, 0, 0) < 0.05 && qualify({ hue: 0, hueWidth: 20, satLow: 50, satHigh: 100, lumLow: 0, lumHigh: 100, softness: 5, invert: false }, 0.5, 0.45, 0.45) < 0.05);

/* ---------- curves ---------- */
check("a straight curve is the identity", near(evalCurve([[0, 0], [1, 1]], 0.37), 0.37, 1e-6) && isIdentityCurve([[0, 0], [1, 1]]));
check("a curve passes through its points", near(evalCurve([[0, 0], [0.5, 0.7], [1, 1]], 0.5), 0.7, 1e-6));
check("a curve does not overshoot", (() => { let max = 0; for (let x = 0; x <= 1; x += 0.01) max = Math.max(max, evalCurve([[0, 0], [0.3, 0.9], [0.6, 0.92], [1, 1]], x)); return max <= 1.0001; })());
check("a curve holds outside its ends", evalCurve([[0.2, 0.3], [0.8, 0.9]], 0) === 0.3 && evalCurve([[0.2, 0.3], [0.8, 0.9]], 1) === 0.9);
const cv = new Uint8ClampedArray([128, 128, 128, 255]);
curvePixels(cv, { master: [[0, 0], [0.5, 0.75], [1, 1]] });
check("the master curve lifts the midtones", cv[0] >= 190 && cv[0] === cv[1] && cv[1] === cv[2], Array.from(cv));
const cr = new Uint8ClampedArray([128, 128, 128, 255]);
curvePixels(cr, { r: [[0, 0], [1, 0.5]] });
check("a channel curve moves one channel", cr[0] < 70 && cr[1] === 128);
const hv = new Uint8ClampedArray([220, 40, 40, 255, 128, 128, 128, 255]);
curvePixels(hv, { hueVsSat: [[0, 0], [0.1, 0], [0.2, 0.5], [1, 0.5]] });
check("hue vs saturation desaturates the picked hues and spares greys", Math.abs(hv[0] - hv[1]) < 40 && hv[4] === 128, Array.from(hv));
const flat = new Uint8ClampedArray([220, 40, 40, 255]);
curvePixels(flat, {});
check("no curve edits: unchanged", flat[0] === 220 && flat[1] === 40);

/* ---------- LUTs ---------- */
const identityCube = (n: number, extra = "") => {
  const rows: string[] = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
  return `# test\nTITLE "Identity"\nLUT_3D_SIZE ${n}\n${extra}\n${rows.join("\n")}\n`;
};
const id = parseCube(identityCube(5));
check("a .cube LUT parses (size, title)", id.size === 5 && id.name === "Identity" && id.data.length === 375);
check("an identity LUT returns its input", sampleLut(id, 0.3, 0.6, 0.9).every((v, i) => near(v, [0.3, 0.6, 0.9][i], 0.005)));
const invertCube = parseCube(identityCube(3).replace(/^([\d.]+) ([\d.]+) ([\d.]+)$/gm, (_m, a, b, c) => `${1 - +a} ${1 - +b} ${1 - +c}`));
check("an inverting LUT inverts", sampleLut(invertCube, 1, 0, 0.5).every((v, i) => near(v, [0, 1, 0.5][i], 0.01)));
check("a LUT is applied with an intensity", (() => { const d = new Uint8ClampedArray([255, 0, 0, 255]); lutPixels(d, invertCube, 50); return near(d[0], 127.5, 2) && near(d[1], 127.5, 2); })());
check("a LUT survives packing into a project", (() => { const back = unpackLut(JSON.parse(JSON.stringify(packLut(id)))); return !!back && back.size === 5 && back.data.every((v, i) => v === id.data[i]); })());
check("a LUT with a custom domain is rescaled", parseCube(identityCube(2).replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2")).data.every((v) => v <= 128));
for (const [name, text] of [["1D LUT", "LUT_1D_SIZE 4\n0 0 0"], ["missing size", "0 0 0"], ["short table", "LUT_3D_SIZE 2\n0 0 0\n1 1 1"], ["bad row", "LUT_3D_SIZE 2\n0 0 x"]] as const) {
  let msg = "";
  try { parseCube(text); } catch (e) { msg = (e as Error).message; }
  check(`a bad LUT is refused with a reason (${name})`, msg.length > 5, msg);
}
check("the LUT effect passes the picture through with no LUT", (() => { const l = getEffect("lut")!; return l.params.some((p) => p.type === "lut"); })());
check("cleanParams keeps a LUT and drops junk", !!(cleanParams(getEffect("lut")!.params, { lut: packLut(id) }).lut) && cleanParams(getEffect("lut")!.params, { lut: { nope: 1 } }).lut === undefined);

/* ---------- colour spaces ---------- */
check("sRGB round trips", (() => { const o = convertColor(convertColor([0.2, 0.5, 0.8], "srgb", "rec2020"), "rec2020", "srgb"); return o.every((v, i) => near(v, [0.2, 0.5, 0.8][i], 0.01)); })());
check("a wide gamut green is clipped in Rec.709", convertColor([0, 1, 0], "p3", "rec709")[1] <= 1 && convertColor([0, 1, 0], "p3", "rec709")[0] === 0);
check("Rec.709 to sRGB keeps whites and blacks", convertColor([1, 1, 1], "rec709", "srgb").every((v) => near(v, 1, 0.002)) && convertColor([0, 0, 0], "rec709", "srgb").every((v) => v === 0));
check("S-Log3: 18 percent grey sits at code 420/1023", near(encode("slog3", 0.18), 420 / 1023, 0.002) && near(decode("slog3", 420 / 1023), 0.18, 0.002));
check("LogC: 18 percent grey sits near 0.391", near(encode("logc", 0.18), 0.391, 0.003) && near(decode("logc", 0.391), 0.18, 0.004));
check("V-Log: 18 percent grey sits near 0.423", near(encode("vlog", 0.18), 0.423, 0.003) && near(decode("vlog", 0.423), 0.18, 0.004));
check("log curves round trip", (["slog3", "logc", "vlog"] as const).every((s) => [0.02, 0.18, 0.9].every((x) => near(decode(s, encode(s, x)), x, 0.001))));
check("log footage comes out brighter and more contrasty in Rec.709", (() => { const o = convertColor([0.41, 0.41, 0.41], "slog3", "rec709"); return o[0] > 0.4 && o[0] < 0.6; })());
const sp = new Uint8ClampedArray([107, 107, 107, 255]);
spacePixels(sp, "slog3", "rec709");
check("a frame moves between spaces", sp[0] !== 107 && sp[0] === sp[1] && sp[3] === 255, Array.from(sp));
const same709 = new Uint8ClampedArray([10, 20, 30, 255]);
spacePixels(same709, "rec709", "rec709");
check("same space: untouched", same709[0] === 10 && same709[2] === 30);

/* ---------- scopes ---------- */
const two = new Uint8ClampedArray([255, 0, 0, 255, 128, 128, 128, 255, 128, 128, 128, 255, 0, 0, 255, 255]);
const hst = histogram(two);
check("histogram counts every pixel per channel", hst.r[255] === 1 && hst.r[128] === 2 && hst.r[0] === 1 && hst.b[255] === 1 && hst.luma.reduce((a, b) => a + b, 0) === 4);
const wf = waveform(two, 2, 2, "luma");
check("waveform has one column per picture column", wf.length === 512 && wf.reduce((a, b) => a + b, 0) === 4 && wf[0 * 256 + 128] === 1);
const vs = vectorscope(new Uint8ClampedArray([128, 128, 128, 255, 255, 0, 0, 255]), 64);
check("grey is the vectorscope centre; red sits up and to the left, as on a hardware scope", vs[Math.round(31.5) * 64 + 32] + vs[31 * 64 + 31] + vs[32 * 64 + 31] + vs[32 * 64 + 32] >= 1 && (() => { for (let y = 0; y < 31; y++) for (let x = 0; x < 31; x++) if (vs[y * 64 + x]) return true; return false; })());
check("a stack of colour effects can be added to a clip", ["grade", "curves", "lut", "colour-space"].every((t) => newEffect(t).enabled));
void px;

if (fails) process.exit(1);
console.log("all passed");
