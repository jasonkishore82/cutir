import type { EffectDef } from "../types";
import { filtered, num, px } from "../util";

export const blur: EffectDef = {
  id: "blur",
  name: "Blur",
  category: "Blur and sharpen",
  description: "Soften the whole picture",
  params: [{ key: "radius", label: "Amount", type: "number", min: 0, max: 100, default: 8, unit: "px" }],
  render: (src, dst, p) => filtered(src, dst, `blur(${px(num(p, "radius", 8), src)}px)`),
};
