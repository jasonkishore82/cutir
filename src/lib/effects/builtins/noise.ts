import type { EffectDef } from "../types";
import { bool, num } from "../util";

/** Film grain: random speckles, moving every frame unless frozen. */
export const noise: EffectDef = {
  id: "noise",
  name: "Noise",
  category: "Stylize",
  description: "Film grain",
  params: [
    { key: "amount", label: "Amount", type: "number", min: 0, max: 100, default: 20, unit: "%" },
    { key: "mono", label: "Black and white grain", type: "boolean", default: true },
    { key: "animated", label: "Moving grain", type: "boolean", default: true },
  ],
  gpu: {
    uniforms: (p, env) => ({ uAmount: num(p, "amount", 20) / 100, uMono: bool(p, "mono", true) ? 1 : 0, uSeed: bool(p, "animated", true) ? Math.floor(env.time * 30) : 0 }),
    fragment: `
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c = texture(uTex, vUv);
  vec2 p = floor(vUv * uSize) + uSeed * 17.0;
  vec3 n = uMono > 0.5 ? vec3(h(p)) : vec3(h(p), h(p + 1.3), h(p + 2.7));
  outColor = vec4(clamp(c.rgb + (n - 0.5) * uAmount, 0.0, 1.0), c.a);
}`,
  },
  render(src, dst, p, env) {
    dst.ctx.drawImage(src.canvas, 0, 0);
    const n = env.scratch();
    const img = n.ctx.createImageData(n.w, n.h);
    const d = img.data;
    const amt = num(p, "amount", 20) / 100;
    const mono = bool(p, "mono", true);
    // a seeded generator, so the same frame always gets the same grain (preview = export)
    let s = (bool(p, "animated", true) ? Math.floor(env.time * 30) : 0) * 9301 + 49297;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < d.length; i += 4) {
      const v = rnd() * 255;
      d[i] = v;
      d[i + 1] = mono ? v : rnd() * 255;
      d[i + 2] = mono ? v : rnd() * 255;
      d[i + 3] = 255 * amt;
    }
    n.ctx.putImageData(img, 0, 0);
    dst.ctx.save();
    dst.ctx.globalCompositeOperation = "source-atop";
    dst.ctx.globalAlpha = 0.5;
    dst.ctx.drawImage(n.canvas, 0, 0);
    dst.ctx.restore();
  },
};
