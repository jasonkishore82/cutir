import type { EffectDef } from "../types";
import { num, px, rgb255, str } from "../util";

export const dropShadow: EffectDef = {
  id: "drop-shadow",
  name: "Drop shadow",
  category: "Stylize",
  description: "A shadow behind the picture",
  params: [
    { key: "distance", label: "Distance", type: "number", min: 0, max: 200, default: 18, unit: "px" },
    { key: "angle", label: "Direction", type: "angle", default: 135 },
    { key: "blur", label: "Softness", type: "number", min: 0, max: 100, default: 20, unit: "px" },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 100, default: 60, unit: "%" },
    { key: "color", label: "Colour", type: "color", default: "#000000" },
  ],
  render(src, dst, p) {
    const a = (num(p, "angle", 135) * Math.PI) / 180;
    const d = px(num(p, "distance", 18), src);
    const [r, g, b] = rgb255(str(p, "color", "#000000"));
    dst.ctx.save();
    dst.ctx.shadowColor = `rgba(${r},${g},${b},${num(p, "opacity", 60) / 100})`;
    dst.ctx.shadowBlur = px(num(p, "blur", 20), src);
    dst.ctx.shadowOffsetX = Math.cos(a) * d;
    dst.ctx.shadowOffsetY = Math.sin(a) * d;
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.restore();
  },
};
