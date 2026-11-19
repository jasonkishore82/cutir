import type { EffectDef } from "../types";
import { num, px } from "../util";

/** Cut away the edges of the frame. */
export const crop: EffectDef = {
  id: "crop",
  name: "Crop",
  category: "Transform",
  description: "Trim the left, right, top and bottom edges",
  params: [
    { key: "left", label: "Left", type: "number", min: 0, max: 100, default: 0, unit: "%" },
    { key: "right", label: "Right", type: "number", min: 0, max: 100, default: 0, unit: "%" },
    { key: "top", label: "Top", type: "number", min: 0, max: 100, default: 0, unit: "%" },
    { key: "bottom", label: "Bottom", type: "number", min: 0, max: 100, default: 0, unit: "%" },
    { key: "feather", label: "Soft edge", type: "number", min: 0, max: 100, default: 0, unit: "px" },
  ],
  render(src, dst, p, env) {
    const { w, h } = src;
    const x0 = (num(p, "left") / 100) * w;
    const x1 = w - (num(p, "right") / 100) * w;
    const y0 = (num(p, "top") / 100) * h;
    const y1 = h - (num(p, "bottom") / 100) * h;
    if (x1 <= x0 || y1 <= y0) return;
    const f = px(num(p, "feather"), src);
    if (f <= 0.5) {
      dst.ctx.save();
      dst.ctx.beginPath();
      dst.ctx.rect(x0, y0, x1 - x0, y1 - y0);
      dst.ctx.clip();
      dst.ctx.drawImage(src.canvas, 0, 0);
      dst.ctx.restore();
      return;
    }
    // soft edge: keep the picture only where a blurred rectangle is
    const m = env.scratch();
    m.ctx.filter = `blur(${f}px)`;
    m.ctx.fillStyle = "#fff";
    m.ctx.fillRect(x0 + f, y0 + f, Math.max(0, x1 - x0 - 2 * f), Math.max(0, y1 - y0 - 2 * f));
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.globalCompositeOperation = "destination-in";
    dst.ctx.drawImage(m.canvas, 0, 0);
    dst.ctx.globalCompositeOperation = "source-over";
  },
};
