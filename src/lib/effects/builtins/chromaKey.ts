import type { EffectDef } from "../types";
import { rgb } from "../gpu";
import { num, str } from "../util";

/** Make a colour (green or blue screen) transparent, with a soft edge and spill removal. */
export const chromaKey: EffectDef = {
  id: "chroma-key",
  name: "Chroma key",
  category: "Keying",
  description: "Remove a green or blue screen",
  params: [
    { key: "key", label: "Key colour", type: "color", default: "#00ff00" },
    { key: "tolerance", label: "Tolerance", type: "number", min: 0, max: 100, default: 35, unit: "%" },
    { key: "softness", label: "Softness", type: "number", min: 0, max: 100, default: 15, unit: "%" },
    { key: "spill", label: "Spill removal", type: "number", min: 0, max: 100, default: 50, unit: "%" },
  ],
  gpu: {
    uniforms: (p) => ({ uKey: rgb(p.key ?? "#00ff00"), uTol: num(p, "tolerance", 35) / 100, uSoft: num(p, "softness", 15) / 100, uSpill: num(p, "spill", 50) / 100 }),
    fragment: `
vec2 cc(vec3 c) { return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b); }
void main() {
  vec4 c = texture(uTex, vUv);
  float d = distance(cc(c.rgb), cc(uKey)) / 0.7;
  float a = smoothstep(uTol, uTol + max(uSoft, 0.001), d);
  vec3 col = c.rgb;
  if (uKey.g > max(uKey.r, uKey.b)) col.g = mix(col.g, min(col.g, max(col.r, col.b)), uSpill);
  outColor = vec4(col, c.a * a);
}`,
  },
  // the same maths per pixel on the CPU (slower; used without WebGL2)
  render(src, dst, p) {
    const [kr, kg, kb] = rgb(str(p, "key", "#00ff00"));
    const tol = num(p, "tolerance", 35) / 100;
    const soft = Math.max(0.001, num(p, "softness", 15) / 100);
    const spill = num(p, "spill", 50) / 100;
    const cb = (r: number, g: number, b: number) => [-0.169 * r - 0.331 * g + 0.5 * b, 0.5 * r - 0.419 * g - 0.081 * b];
    const [kx, ky] = cb(kr, kg, kb);
    const img = src.ctx.getImageData(0, 0, src.w, src.h);
    const d = img.data;
    const greenKey = kg > Math.max(kr, kb);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255;
      const g = d[i + 1] / 255;
      const b = d[i + 2] / 255;
      const [x, y] = cb(r, g, b);
      const t = Math.min(1, Math.max(0, (Math.hypot(x - kx, y - ky) / 0.7 - tol) / soft));
      d[i + 3] = d[i + 3] * t * t * (3 - 2 * t);
      if (greenKey) d[i + 1] = (g + (Math.min(g, Math.max(r, b)) - g) * spill) * 255;
    }
    dst.ctx.putImageData(img, 0, 0);
  },
};
