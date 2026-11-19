import type { EffectDef } from "../types";
import { num } from "../util";

/** Move, scale and rotate the clip's picture on top of its placement. */
export const transform: EffectDef = {
  id: "transform",
  name: "Transform",
  category: "Transform",
  description: "Move, scale and rotate the picture",
  params: [
    { key: "x", label: "Move across", type: "number", min: -100, max: 100, step: 0.5, default: 0, unit: "%" },
    { key: "y", label: "Move down", type: "number", min: -100, max: 100, step: 0.5, default: 0, unit: "%" },
    { key: "scale", label: "Size", type: "number", min: 1, max: 400, default: 100, unit: "%" },
    { key: "rotation", label: "Rotation", type: "angle", default: 0 },
  ],
  render(src, dst, p) {
    const { w, h } = src;
    const s = num(p, "scale", 100) / 100;
    dst.ctx.save();
    dst.ctx.translate(w / 2 + (num(p, "x") / 100) * w, h / 2 + (num(p, "y") / 100) * h);
    dst.ctx.rotate((num(p, "rotation") * Math.PI) / 180);
    dst.ctx.scale(s, s);
    dst.ctx.drawImage(src.canvas, -w / 2, -h / 2);
    dst.ctx.restore();
  },
};
