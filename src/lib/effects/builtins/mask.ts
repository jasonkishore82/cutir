import type { EffectDef, Params } from "../types";
import { bool, num, pt, px, str } from "../util";
import { DEFAULT_PATH, tracePath, type Pt } from "../../masks";

const readPath = (p: Params): Pt[] => (Array.isArray(p.path) ? (p.path as Pt[]).filter((q) => Array.isArray(q) && q.length >= 2) : DEFAULT_PATH);

/** Show the picture only inside (or outside) a rectangle, ellipse, polygon or smooth (bezier) shape, with a soft edge, growing or shrinking, and an optional tracker to follow. */
export const mask: EffectDef = {
  id: "mask",
  name: "Mask",
  category: "Transform",
  description: "Keep a rectangle, ellipse, polygon or bezier shape of the picture",
  params: [
    { key: "shape", label: "Shape", type: "choice", default: "ellipse", options: [{ value: "ellipse", label: "Ellipse" }, { value: "rectangle", label: "Rectangle" }, { value: "polygon", label: "Polygon" }, { value: "bezier", label: "Bezier (smooth)" }] },
    { key: "path", label: "Polygon and bezier points", type: "path", default: DEFAULT_PATH.map((q) => [...q] as [number, number]) },
    { key: "center", label: "Centre (rectangle and ellipse)", type: "point", default: { x: 0.5, y: 0.5 } },
    { key: "width", label: "Width", type: "number", min: 1, max: 200, default: 60, unit: "%" },
    { key: "height", label: "Height", type: "number", min: 1, max: 200, default: 60, unit: "%" },
    { key: "offsetX", label: "Move horizontally", type: "number", min: -100, max: 100, default: 0, unit: "%" },
    { key: "offsetY", label: "Move vertically", type: "number", min: -100, max: 100, default: 0, unit: "%" },
    { key: "expand", label: "Grow or shrink", type: "number", min: -200, max: 200, default: 0, unit: "px" },
    { key: "feather", label: "Soft edge", type: "number", min: 0, max: 200, default: 30, unit: "px" },
    { key: "invert", label: "Invert", type: "boolean", default: false },
    { key: "follow", label: "Follow this clip's tracker", type: "boolean", default: false },
  ],
  render(src, dst, p, env) {
    const { w, h } = src;
    const m = env.scratch();
    // the mask moves by its own offsets (keyframable) and, when asked, by the clip's tracked point
    const tr = bool(p, "follow") && env.track ? env.track : { x: 0, y: 0 };
    const off = { x: num(p, "offsetX") / 100 + tr.x, y: num(p, "offsetY") / 100 + tr.y };
    const f = px(num(p, "feather", 30), src);
    const grow = px(num(p, "expand"), src);
    if (f > 0.5) m.ctx.filter = `blur(${f}px)`;
    m.ctx.fillStyle = "#fff";
    m.ctx.strokeStyle = "#fff";
    const shape = str(p, "shape", "ellipse");
    const draw = () => {
      m.ctx.beginPath();
      if (shape === "polygon" || shape === "bezier") {
        if (!tracePath(m.ctx, readPath(p), shape === "bezier", w, h, off)) m.ctx.rect(0, 0, w, h);
        return;
      }
      const c = pt(p, "center");
      const mw = (num(p, "width", 60) / 100) * w;
      const mh = (num(p, "height", 60) / 100) * h;
      const cx = (c.x + off.x) * w;
      const cy = (c.y + off.y) * h;
      if (shape === "rectangle") m.ctx.rect(cx - mw / 2, cy - mh / 2, mw, mh);
      else m.ctx.ellipse(cx, cy, Math.max(0.5, mw / 2), Math.max(0.5, mh / 2), 0, 0, Math.PI * 2);
    };
    draw();
    m.ctx.fill();
    if (Math.abs(grow) > 0.5) {
      // growing strokes the outline outward; shrinking erases a band along the inside edge
      m.ctx.lineJoin = "round";
      m.ctx.lineWidth = Math.abs(grow) * 2;
      m.ctx.globalCompositeOperation = grow > 0 ? "source-over" : "destination-out";
      draw();
      m.ctx.stroke();
      m.ctx.globalCompositeOperation = "source-over";
    }
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.globalCompositeOperation = bool(p, "invert") ? "destination-out" : "destination-in";
    dst.ctx.drawImage(m.canvas, 0, 0);
    dst.ctx.globalCompositeOperation = "source-over";
  },
};
