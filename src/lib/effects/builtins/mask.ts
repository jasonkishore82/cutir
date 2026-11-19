import type { EffectDef } from "../types";
import { bool, num, pt, px, str } from "../util";

/** Show the picture only inside (or outside) a rectangle or ellipse, with a soft edge. */
export const mask: EffectDef = {
  id: "mask",
  name: "Mask",
  category: "Transform",
  description: "Keep a rectangle or ellipse of the picture",
  params: [
    { key: "shape", label: "Shape", type: "choice", default: "ellipse", options: [{ value: "ellipse", label: "Ellipse" }, { value: "rectangle", label: "Rectangle" }] },
    { key: "center", label: "Centre", type: "point", default: { x: 0.5, y: 0.5 } },
    { key: "width", label: "Width", type: "number", min: 1, max: 200, default: 60, unit: "%" },
    { key: "height", label: "Height", type: "number", min: 1, max: 200, default: 60, unit: "%" },
    { key: "feather", label: "Soft edge", type: "number", min: 0, max: 200, default: 30, unit: "px" },
    { key: "invert", label: "Invert", type: "boolean", default: false },
  ],
  render(src, dst, p, env) {
    const { w, h } = src;
    const c = pt(p, "center");
    const mw = (num(p, "width", 60) / 100) * w;
    const mh = (num(p, "height", 60) / 100) * h;
    const m = env.scratch();
    const f = px(num(p, "feather", 30), src);
    if (f > 0.5) m.ctx.filter = `blur(${f}px)`;
    m.ctx.fillStyle = "#fff";
    m.ctx.beginPath();
    if (str(p, "shape", "ellipse") === "rectangle") m.ctx.rect(c.x * w - mw / 2, c.y * h - mh / 2, mw, mh);
    else m.ctx.ellipse(c.x * w, c.y * h, mw / 2, mh / 2, 0, 0, Math.PI * 2);
    m.ctx.fill();
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.globalCompositeOperation = bool(p, "invert") ? "destination-out" : "destination-in";
    dst.ctx.drawImage(m.canvas, 0, 0);
    dst.ctx.globalCompositeOperation = "source-over";
  },
};
