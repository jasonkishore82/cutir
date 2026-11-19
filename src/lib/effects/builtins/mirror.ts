import type { EffectDef } from "../types";
import { str } from "../util";

export const mirror: EffectDef = {
  id: "mirror",
  name: "Mirror",
  category: "Distort",
  description: "Flip the picture",
  params: [
    {
      key: "axis",
      label: "Flip",
      type: "choice",
      default: "horizontal",
      options: [
        { value: "horizontal", label: "Left-right" },
        { value: "vertical", label: "Upside down" },
        { value: "both", label: "Both" },
      ],
    },
  ],
  render(src, dst, p) {
    const axis = str(p, "axis", "horizontal");
    const sx = axis === "vertical" ? 1 : -1;
    const sy = axis === "horizontal" ? 1 : -1;
    dst.ctx.save();
    dst.ctx.translate(sx < 0 ? src.w : 0, sy < 0 ? src.h : 0);
    dst.ctx.scale(sx, sy);
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.restore();
  },
};
