import type { EffectDef } from "../types";
import { EASINGS, EFFECTS, IN_EFFECTS, OUT_EFFECTS, combineFx, toFx } from "../../animations";
import type { Easing, EffectName } from "../../../store/project";
import { num, px, str } from "../util";

/**
 * The lyric In / Out animations (fade, pop, slide, zoom, blur, rotate...) as an effect, so any clip can use them.
 * It reuses the lyric renderer's own effect definitions; whole-block effects only (word and letter effects need text).
 */
const block = (n: EffectName) => EFFECTS[n].mode === "block";
const opts = (names: EffectName[]) => names.filter(block).map((n) => ({ value: n, label: EFFECTS[n].label }));
const EASE = Object.keys(EASINGS).map((e) => ({ value: e, label: e }));

export const animate: EffectDef = {
  id: "animate",
  name: "Animate in / out",
  category: "Animation",
  description: "The lyric entrance and exit animations, for any clip",
  params: [
    { key: "in", label: "In", type: "choice", default: "fade", options: opts(IN_EFFECTS) },
    { key: "inMs", label: "In length", type: "number", min: 0, max: 3000, step: 50, default: 400, unit: "ms" },
    { key: "out", label: "Out", type: "choice", default: "fade", options: opts(OUT_EFFECTS) },
    { key: "outMs", label: "Out length", type: "number", min: 0, max: 3000, step: 50, default: 400, unit: "ms" },
    { key: "easing", label: "Easing", type: "choice", default: "ease-out", options: EASE },
  ],
  render(src, dst, p, env) {
    const ease = EASINGS[str(p, "easing", "ease-out") as Easing] ?? EASINGS.linear;
    const dIn = Math.min(num(p, "inMs", 400) / 1000, env.clipDuration / 2);
    const dOut = Math.min(num(p, "outMs", 400) / 1000, env.clipDuration / 2);
    const pin = dIn > 0 ? ease(Math.min(1, Math.max(0, env.time / dIn))) : 1;
    const pout = dOut > 0 ? 1 - ease(1 - Math.min(1, Math.max(0, (env.clipDuration - env.time) / dOut))) : 1;
    const inName = str(p, "in", "fade") as EffectName;
    const outName = str(p, "out", "fade") as EffectName;
    const fx = combineFx(toFx(EFFECTS[inName] && block(inName) ? EFFECTS[inName].fx(pin, "in") : {}), toFx(EFFECTS[outName] && block(outName) ? EFFECTS[outName].fx(pout, "out") : {}));
    if (fx.opacity <= 0) return;
    const { w, h } = src;
    dst.ctx.save();
    dst.ctx.globalAlpha = Math.min(1, fx.opacity);
    if (fx.blur > 0.05) dst.ctx.filter = `blur(${px(fx.blur, src)}px)`;
    dst.ctx.translate(w / 2 + fx.dx * h, h / 2 + fx.dy * h);
    dst.ctx.rotate((fx.rotation * Math.PI) / 180);
    dst.ctx.scale(fx.scale, fx.scale);
    dst.ctx.drawImage(src.canvas, -w / 2, -h / 2);
    dst.ctx.restore();
  },
};
