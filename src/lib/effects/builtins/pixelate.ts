import type { EffectDef } from "../types";
import { num, px } from "../util";

export const pixelate: EffectDef = {
  id: "pixelate",
  name: "Pixelate",
  category: "Distort",
  description: "Big square pixels",
  params: [{ key: "size", label: "Block size", type: "number", min: 2, max: 200, default: 24, unit: "px" }],
  render(src, dst, p, env) {
    const block = Math.max(1, px(num(p, "size", 24), src));
    const small = env.scratch();
    const sw = Math.max(1, Math.round(src.w / block));
    const sh = Math.max(1, Math.round(src.h / block));
    small.ctx.imageSmoothingEnabled = false;
    small.ctx.drawImage(src.canvas, 0, 0, sw, sh);
    dst.ctx.save();
    dst.ctx.imageSmoothingEnabled = false;
    dst.ctx.drawImage(small.canvas, 0, 0, sw, sh, 0, 0, src.w, src.h);
    dst.ctx.restore();
  },
};
