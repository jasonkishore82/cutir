import type { EffectDef } from "../types";
import { rgb } from "../gpu";
import { bool, num, str } from "../util";
import { erodeAlpha } from "../../masks";

/** Green screen keyer: chroma distance with softness, edge shrink, spill suppression and a matte view. */
export const chromaKey: EffectDef = {
  id: "chroma-key",
  name: "Chroma key",
  category: "Keying",
  description: "Remove a green or blue screen, with edge shrink, spill removal and a matte view",
  params: [
    { key: "key", label: "Key colour", type: "color", default: "#00ff00" },
    { key: "tolerance", label: "Tolerance", type: "number", min: 0, max: 100, default: 35, unit: "%" },
    { key: "softness", label: "Softness", type: "number", min: 0, max: 100, default: 15, unit: "%" },
    { key: "shrink", label: "Edge shrink", type: "number", min: 0, max: 10, default: 0, unit: "px" },
    { key: "spill", label: "Spill removal", type: "number", min: 0, max: 100, default: 50, unit: "%" },
    { key: "matte", label: "Show the matte", type: "boolean", default: false },
  ],
  gpu: {
    uniforms: (p) => ({ uKey: rgb(p.key ?? "#00ff00"), uTol: num(p, "tolerance", 35) / 100, uSoft: num(p, "softness", 15) / 100, uSpill: num(p, "spill", 50) / 100, uShrink: Math.round(num(p, "shrink", 0)), uMatte: bool(p, "matte") ? 1 : 0 }),
    fragment: `
vec2 cc(vec3 c) { return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b); }
float keyAlpha(vec2 uv) {
  vec4 c = texture(uTex, uv);
  float d = distance(cc(c.rgb), cc(uKey)) / 0.7;
  return c.a * smoothstep(uTol, uTol + max(uSoft, 0.001), d);
}
void main() {
  vec4 c = texture(uTex, vUv);
  float a = keyAlpha(vUv);
  if (uShrink > 0.5) {
    // edge shrink: the matte is the smallest alpha within the shrink radius (a ring of samples plus the middle of each)
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.785398;
      vec2 o = vec2(cos(ang), sin(ang)) / uSize;
      a = min(a, keyAlpha(vUv + o * uShrink));
      a = min(a, keyAlpha(vUv + o * uShrink * 0.5));
    }
  }
  if (uMatte > 0.5) { outColor = vec4(vec3(a), 1.0); return; }
  vec3 col = c.rgb;
  if (uKey.g > max(uKey.r, uKey.b)) col.g = mix(col.g, min(col.g, max(col.r, col.b)), uSpill);
  else if (uKey.b > max(uKey.r, uKey.g)) col.b = mix(col.b, min(col.b, max(col.r, col.g)), uSpill);
  outColor = vec4(col, a);
}`,
  },
  // the same maths per pixel on the CPU (slower; used without WebGL2)
  render(src, dst, p) {
    const [kr, kg, kb] = rgb(str(p, "key", "#00ff00"));
    const tol = num(p, "tolerance", 35) / 100;
    const soft = Math.max(0.001, num(p, "softness", 15) / 100);
    const spill = num(p, "spill", 50) / 100;
    const shrink = Math.round(num(p, "shrink", 0));
    const cb = (r: number, g: number, b: number) => [-0.169 * r - 0.331 * g + 0.5 * b, 0.5 * r - 0.419 * g - 0.081 * b];
    const [kx, ky] = cb(kr, kg, kb);
    const img = src.ctx.getImageData(0, 0, src.w, src.h);
    const d = img.data;
    const greenKey = kg > Math.max(kr, kb);
    const blueKey = !greenKey && kb > Math.max(kr, kg);
    let alpha = new Uint8ClampedArray(src.w * src.h);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255;
      const g = d[i + 1] / 255;
      const b = d[i + 2] / 255;
      const [x, y] = cb(r, g, b);
      const t = Math.min(1, Math.max(0, (Math.hypot(x - kx, y - ky) / 0.7 - tol) / soft));
      alpha[i >> 2] = d[i + 3] * t * t * (3 - 2 * t);
      if (greenKey) d[i + 1] = (g + (Math.min(g, Math.max(r, b)) - g) * spill) * 255;
      else if (blueKey) d[i + 2] = (b + (Math.min(b, Math.max(r, g)) - b) * spill) * 255;
    }
    if (shrink > 0) alpha = erodeAlpha(alpha, src.w, src.h, shrink) as typeof alpha;
    const showMatte = bool(p, "matte");
    for (let i = 0; i < d.length; i += 4) {
      const a = alpha[i >> 2];
      if (showMatte) (d[i] = d[i + 1] = d[i + 2] = a), (d[i + 3] = 255);
      else d[i + 3] = a;
    }
    dst.ctx.putImageData(img, 0, 0);
  },
};
