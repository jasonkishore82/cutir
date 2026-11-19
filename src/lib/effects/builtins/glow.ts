import type { EffectDef } from "../types";
import { num, px } from "../util";

/** Soft light around the picture: a blurred copy added on top. */
export const glow: EffectDef = {
  id: "glow",
  name: "Glow",
  category: "Stylize",
  description: "Soft light spilling around the picture",
  params: [
    { key: "radius", label: "Size", type: "number", min: 0, max: 120, default: 24, unit: "px" },
    { key: "intensity", label: "Strength", type: "number", min: 0, max: 200, default: 60, unit: "%" },
  ],
  render(src, dst, p) {
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.save();
    dst.ctx.globalCompositeOperation = "lighter";
    dst.ctx.globalAlpha = Math.min(1, num(p, "intensity", 60) / 100);
    dst.ctx.filter = `blur(${px(num(p, "radius", 24), src)}px)`;
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.restore();
  },
};
