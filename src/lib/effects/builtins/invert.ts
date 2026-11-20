import type { EffectDef } from "../types";
import { filtered, num } from "../util";

export const invert: EffectDef = {
  id: "invert",
  name: "Invert",
  category: "Colour",
  description: "Negative colours",
  params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 100, default: 100, unit: "%" }],
  render: (src, dst, p) => filtered(src, dst, `invert(${num(p, "amount", 100) / 100})`),
};
