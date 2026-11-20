import type { EffectDef } from "../types";
import { num, str } from "../util";

/** Darker (or coloured) corners, only where the picture is. */
export const vignette: EffectDef = {
  id: "vignette",
  name: "Vignette",
  category: "Stylize",
  description: "Darken the corners",
  params: [
    { key: "amount", label: "Amount", type: "number", min: 0, max: 100, default: 50, unit: "%" },
    { key: "size", label: "Clear centre", type: "number", min: 0, max: 100, default: 55, unit: "%" },
    { key: "color", label: "Colour", type: "color", default: "#000000" },
  ],
  render(src, dst, p) {
    const { w, h } = src;
    dst.ctx.drawImage(src.canvas, 0, 0);
    const r = Math.hypot(w, h) / 2;
    const g = dst.ctx.createRadialGradient(w / 2, h / 2, (r * num(p, "size", 55)) / 100, w / 2, h / 2, r);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, str(p, "color", "#000000"));
    dst.ctx.save();
    dst.ctx.globalCompositeOperation = "source-atop";
    dst.ctx.globalAlpha = num(p, "amount", 50) / 100;
    dst.ctx.fillStyle = g;
    dst.ctx.fillRect(0, 0, w, h);
    dst.ctx.restore();
  },
};
