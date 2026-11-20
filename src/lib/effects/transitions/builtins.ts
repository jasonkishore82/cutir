import type { Canvas2D, Layer, Params, TransitionDef } from "../types";
import { num, px, str } from "../util";

/**
 * Built-in transitions (phase 17). `a` is the outgoing clip, `b` the incoming one; either is null at a clip edge.
 * `p` runs 0 -> 1 and is already eased.
 */

const draw = (out: Canvas2D, l: Layer | null, alpha = 1) => {
  if (!l || alpha <= 0) return;
  out.save();
  out.globalAlpha = Math.min(1, alpha);
  out.drawImage(l.canvas, 0, 0);
  out.restore();
};

const DIRS = [
  { value: "left", label: "To the left" },
  { value: "right", label: "To the right" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];
const dirVec = (d: string) => (d === "right" ? [1, 0] : d === "up" ? [0, -1] : d === "down" ? [0, 1] : [-1, 0]);

export const crossDissolve: TransitionDef = {
  id: "cross-dissolve",
  name: "Cross dissolve",
  description: "One picture fades into the next",
  params: [],
  render(out, a, b, p) {
    draw(out, a, b ? 1 : 1 - p); // with an incoming clip the old one stays solid underneath
    draw(out, b, p);
  },
};

export const dipToColour: TransitionDef = {
  id: "dip-to-colour",
  name: "Dip to colour",
  description: "Fade to a colour (black by default), then into the next clip",
  params: [{ key: "color", label: "Colour", type: "color", default: "#000000" }],
  render(out, a, b, p, params, env) {
    out.save();
    out.fillStyle = str(params, "color", "#000000");
    if (p < 0.5) {
      draw(out, a);
      out.globalAlpha = p * 2;
    } else {
      draw(out, b);
      out.globalAlpha = (1 - p) * 2;
    }
    out.fillRect(0, 0, env.w, env.h);
    out.restore();
  },
};

export const wipe: TransitionDef = {
  id: "wipe",
  name: "Wipe",
  description: "A moving edge reveals the next clip",
  params: [
    { key: "direction", label: "Direction", type: "choice", default: "left", options: DIRS },
    { key: "softness", label: "Soft edge", type: "number", min: 0, max: 200, default: 20, unit: "px" },
  ],
  render(out, a, b, p, params, env) {
    draw(out, a);
    if (!b) return;
    const [dx, dy] = dirVec(str(params, "direction", "left"));
    const soft = px(num(params, "softness", 20), env);
    const m = env.scratch();
    // the revealed area grows from the edge the wipe travels away from
    const gx = dx < 0 ? env.w * (1 - p) : dx > 0 ? 0 : 0;
    const gy = dy < 0 ? env.h * (1 - p) : 0;
    const gw = dx ? env.w * p : env.w;
    const gh = dy ? env.h * p : env.h;
    if (soft > 0.5) m.ctx.filter = `blur(${soft}px)`;
    m.ctx.fillStyle = "#fff";
    m.ctx.fillRect(dx < 0 ? gx : dx > 0 ? 0 : 0, dy < 0 ? gy : 0, gw, gh);
    m.ctx.filter = "none";
    m.ctx.globalCompositeOperation = "source-in";
    m.ctx.drawImage(b.canvas, 0, 0);
    out.drawImage(m.canvas, 0, 0);
  },
};

export const push: TransitionDef = {
  id: "push",
  name: "Push",
  description: "The next clip pushes the current one out of the frame",
  params: [{ key: "direction", label: "Direction", type: "choice", default: "left", options: DIRS }],
  render(out, a, b, p, params, env) {
    const [dx, dy] = dirVec(str(params, "direction", "left"));
    const ox = dx * env.w * p;
    const oy = dy * env.h * p;
    if (a) out.drawImage(a.canvas, ox, oy);
    if (b) out.drawImage(b.canvas, ox - dx * env.w, oy - dy * env.h);
  },
};

export const slide: TransitionDef = {
  id: "slide",
  name: "Slide",
  description: "The next clip slides in over the current one",
  params: [{ key: "direction", label: "Direction", type: "choice", default: "left", options: DIRS }],
  render(out, a, b, p, params, env) {
    const [dx, dy] = dirVec(str(params, "direction", "left"));
    draw(out, a);
    if (b) out.drawImage(b.canvas, -dx * env.w * (1 - p), -dy * env.h * (1 - p));
  },
};

const scaled = (out: Canvas2D, l: Layer | null, s: number, alpha: number, rot = 0) => {
  if (!l || alpha <= 0) return;
  out.save();
  out.globalAlpha = Math.min(1, alpha);
  out.translate(l.w / 2, l.h / 2);
  out.rotate(rot);
  out.scale(s, s);
  out.drawImage(l.canvas, -l.w / 2, -l.h / 2);
  out.restore();
};

export const zoom: TransitionDef = {
  id: "zoom",
  name: "Zoom",
  description: "Zoom through into the next clip",
  params: [{ key: "amount", label: "Zoom", type: "number", min: 10, max: 300, default: 60, unit: "%" }],
  render(out, a, b, p, params) {
    const z = num(params, "amount", 60) / 100;
    scaled(out, a, 1 + z * p, 1 - p);
    scaled(out, b, 1 / (1 + z * (1 - p)), p);
  },
};

export const blurDissolve: TransitionDef = {
  id: "blur-dissolve",
  name: "Blur dissolve",
  description: "Blur out, dissolve, blur back in",
  params: [{ key: "radius", label: "Blur", type: "number", min: 0, max: 100, default: 30, unit: "px" }],
  render(out, a, b, p, params, env) {
    const r = px(num(params, "radius", 30), env) * Math.sin(Math.PI * p);
    out.save();
    if (r > 0.3) out.filter = `blur(${r}px)`;
    draw(out, a, 1 - p);
    draw(out, b, p);
    out.restore();
  },
};

export const spin: TransitionDef = {
  id: "spin",
  name: "Spin",
  description: "Spin out of one clip and into the next",
  params: [{ key: "turns", label: "Turns", type: "number", min: 0.25, max: 3, step: 0.25, default: 0.5 }],
  render(out, a, b, p, params: Params) {
    const turn = num(params, "turns", 0.5) * Math.PI * 2;
    scaled(out, a, 1 - 0.5 * p, 1 - p, turn * p);
    scaled(out, b, 0.5 + 0.5 * p, p, -turn * (1 - p));
  },
};

export const BUILTIN_TRANSITIONS = [crossDissolve, dipToColour, wipe, push, slide, zoom, blurDissolve, spin];
