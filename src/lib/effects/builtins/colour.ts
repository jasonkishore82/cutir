import type { EffectDef, Layer, ParamSpec } from "../types";
import { FLAT_CURVE, LINEAR_CURVE, curvePixels, gradePixels, lutPixels, readCurves, spacePixels, unpackLut } from "../../grade/pixels";
import { SPACES, type SpaceId } from "../../grade/math";
import { num, str } from "../util";

/** Run a pixel function over a layer: read the frame, change its bytes, write it to the destination. */
function viaPixels(src: Layer, dst: Layer, fn: (data: Uint8ClampedArray) => void) {
  const img = src.ctx.getImageData(0, 0, src.w, src.h);
  fn(img.data);
  dst.ctx.putImageData(img, 0, 0);
}

const slider = (key: string, label: string, def = 0, min = -100, max = 100): ParamSpec => ({ key, label, type: "number", min, max, default: def });
const wheelParams = (key: string, label: string): ParamSpec[] => [slider(`${key}M`, `${label} master`), slider(`${key}R`, `${label} red`), slider(`${key}G`, `${label} green`), slider(`${key}B`, `${label} blue`)];

/** Primary grading: lift, gamma, gain, offset wheels with masters, contrast and pivot, saturation, hue, white balance, tone, and an optional HSL qualifier. */
export const grade: EffectDef = {
  id: "grade",
  name: "Colour grade",
  category: "Colour",
  description: "Lift, gamma, gain, offset, contrast, saturation, white balance and an HSL qualifier",
  params: [
    ...wheelParams("lift", "Lift"),
    ...wheelParams("gamma", "Gamma"),
    ...wheelParams("gain", "Gain"),
    ...wheelParams("offset", "Offset"),
    slider("contrast", "Contrast"),
    slider("pivot", "Pivot", 50, 0, 100),
    slider("saturation", "Saturation"),
    slider("hue", "Hue", 0, -180, 180),
    slider("temperature", "Temperature"),
    slider("tint", "Tint"),
    slider("highlights", "Highlights"),
    slider("shadows", "Shadows"),
    slider("mix", "Amount", 100, 0, 100),
    { key: "qualify", label: "Only the colours picked below", type: "boolean", default: false },
    { key: "qShow", label: "Show the matte", type: "boolean", default: false },
    { key: "qInvert", label: "Invert the selection", type: "boolean", default: false },
    slider("qHue", "Picked hue", 0, 0, 360),
    slider("qWidth", "Hue width", 30, 0, 180),
    slider("qSatLow", "Saturation from", 0, 0, 100),
    slider("qSatHigh", "Saturation to", 100, 0, 100),
    slider("qLumLow", "Brightness from", 0, 0, 100),
    slider("qLumHigh", "Brightness to", 100, 0, 100),
    slider("qSoft", "Softness", 20, 0, 100),
    slider("qBlur", "Matte blur", 0, 0, 100),
  ],
  render: (src, dst, p) => viaPixels(src, dst, (d) => gradePixels(d, p, src.w)),
};

export const curves: EffectDef = {
  id: "curves",
  name: "Curves",
  category: "Colour",
  description: "RGB curves, hue vs hue, hue vs saturation, luma vs saturation, hue vs luma, saturation vs saturation",
  params: [
    { key: "master", label: "Master", type: "curve", default: structuredClone(LINEAR_CURVE) },
    { key: "red", label: "Red", type: "curve", default: structuredClone(LINEAR_CURVE) },
    { key: "green", label: "Green", type: "curve", default: structuredClone(LINEAR_CURVE) },
    { key: "blue", label: "Blue", type: "curve", default: structuredClone(LINEAR_CURVE) },
    { key: "hueVsHue", label: "Hue vs hue", type: "curve", default: structuredClone(FLAT_CURVE) },
    { key: "hueVsSat", label: "Hue vs saturation", type: "curve", default: structuredClone(FLAT_CURVE) },
    { key: "lumaVsSat", label: "Luma vs saturation", type: "curve", default: structuredClone(FLAT_CURVE) },
    { key: "hueVsLuma", label: "Hue vs luma", type: "curve", default: structuredClone(FLAT_CURVE) },
    { key: "satVsSat", label: "Saturation vs saturation", type: "curve", default: structuredClone(FLAT_CURVE) },
    slider("mix", "Amount", 100, 0, 100),
  ],
  render: (src, dst, p) => viaPixels(src, dst, (d) => curvePixels(d, readCurves(p), num(p, "mix", 100))),
};

const lutCache = new WeakMap<object, ReturnType<typeof unpackLut>>();

export const lut: EffectDef = {
  id: "lut",
  name: "LUT",
  category: "Colour",
  description: "A .cube look-up table with an intensity",
  params: [{ key: "lut", label: "LUT file (.cube)", type: "lut", default: null }, slider("intensity", "Intensity", 100, 0, 100)],
  render(src, dst, p) {
    const v = p.lut as object | null;
    let table = v ? lutCache.get(v) : undefined;
    if (v && table === undefined) lutCache.set(v, (table = unpackLut(v)));
    if (!table) return dst.ctx.drawImage(src.canvas, 0, 0);
    viaPixels(src, dst, (d) => lutPixels(d, table!, num(p, "intensity", 100)));
  },
};

export const colourSpace: EffectDef = {
  id: "colour-space",
  name: "Colour space transform",
  category: "Colour",
  description: "Move a clip between Rec.709, sRGB, Rec.2020, Display P3 and camera log curves",
  params: [
    { key: "from", label: "Clip is in", type: "choice", options: SPACES.map((s) => ({ value: s.id, label: s.name })), default: "slog3" },
    { key: "to", label: "Convert to", type: "choice", options: SPACES.map((s) => ({ value: s.id, label: s.name })), default: "rec709" },
  ],
  render: (src, dst, p) => viaPixels(src, dst, (d) => spacePixels(d, str(p, "from", "slog3") as SpaceId, str(p, "to", "rec709") as SpaceId)),
};
