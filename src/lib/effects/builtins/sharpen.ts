import type { EffectDef } from "../types";
import { filtered, num } from "../util";

/** Unsharp mask on the GPU; without WebGL2 a gentle contrast boost stands in. */
export const sharpen: EffectDef = {
  id: "sharpen",
  name: "Sharpen",
  category: "Blur and sharpen",
  description: "Crisper edges and detail",
  params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 300, default: 80, unit: "%" }],
  render: (src, dst, p) => filtered(src, dst, `contrast(${1 + num(p, "amount", 80) / 400})`),
  gpu: {
    uniforms: (p) => ({ uAmount: num(p, "amount", 80) / 100 }),
    fragment: `
void main() {
  vec2 px = 1.0 / uSize;
  vec4 c = texture(uTex, vUv);
  vec4 n = texture(uTex, vUv + vec2(px.x, 0.0)) + texture(uTex, vUv - vec2(px.x, 0.0)) + texture(uTex, vUv + vec2(0.0, px.y)) + texture(uTex, vUv - vec2(0.0, px.y));
  outColor = vec4(clamp(c.rgb + (c.rgb * 4.0 - n.rgb) * uAmount, 0.0, 1.0), c.a);
}`,
  },
};
