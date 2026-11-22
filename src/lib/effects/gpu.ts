import type { EffectEnv, GpuPass, Layer, Params } from "./types";

/**
 * A tiny WebGL2 runner for effects that are much faster (or only possible) per pixel: one full-screen quad, the
 * source layer as a texture, the effect's fragment shader, the result drawn back into the destination layer.
 * One shared context; programs are compiled once per effect. Returns false when WebGL2 is not available, so the
 * caller uses the effect's canvas version instead.
 */

let enabled = true;
/** Settings: turn the graphics card path off and every effect uses its canvas version. */
export const setGpuEnabled = (on: boolean) => void (enabled = on);

let gl: WebGL2RenderingContext | null | undefined;
let glCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
const programs = new Map<string, { prog: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> }>();
let tex: WebGLTexture | null = null;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

function context(): WebGL2RenderingContext | null {
  if (gl !== undefined) return gl;
  try {
    glCanvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(2, 2) : typeof document !== "undefined" ? document.createElement("canvas") : null;
    gl = (glCanvas?.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null) ?? null;
  } catch {
    gl = null;
  }
  if (gl) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }
  return gl;
}

function compile(id: string, pass: GpuPass, uniformNames: string[]) {
  const c = programs.get(id);
  if (c) return c;
  const g = gl!;
  const decl = uniformNames.map((n) => `uniform ${guessType(n)} ${n};`).join("\n");
  const frag = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform float uTime;
${decl}
${pass.fragment}`;
  const sh = (type: number, src: string) => {
    const s = g.createShader(type)!;
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(`shader ${id}: ${g.getShaderInfoLog(s)}`);
    return s;
  };
  const prog = g.createProgram()!;
  g.attachShader(prog, sh(g.VERTEX_SHADER, VERT));
  g.attachShader(prog, sh(g.FRAGMENT_SHADER, frag));
  g.bindAttribLocation(prog, 0, "aPos");
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(`shader ${id}: ${g.getProgramInfoLog(prog)}`);
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  for (const n of ["uTex", "uSize", "uTime", ...uniformNames]) uniforms.set(n, g.getUniformLocation(prog, n));
  const entry = { prog, uniforms };
  programs.set(id, entry);
  return entry;
}

/** Drop compiled programs of an effect (a plugin was removed or replaced). */
export function forgetProgram(id: string) {
  for (const k of [...programs.keys()]) if (k.startsWith(`${id}:`)) programs.delete(k);
}

/** Uniform types come from the name prefix: uCol... and uKey... are vec3, uPt... is vec2, everything else float. */
function guessType(name: string) {
  return /^u(Col|Key)/.test(name) ? "vec3" : /^uPt/.test(name) ? "vec2" : "float";
}

/** Run a GPU pass from `src` into `dst`. False when WebGL2 is unavailable or the shader failed. */
export function runGpu(id: string, pass: GpuPass, src: Layer, dst: Layer, p: Params, env: EffectEnv): boolean {
  if (!enabled) return false;
  const g = context();
  if (!g || !glCanvas) return false;
  try {
    const values = pass.uniforms(p, env);
    const names = Object.keys(values).sort();
    const { prog, uniforms } = compile(`${id}:${names.join(",")}`, pass, names);
    if (glCanvas.width !== src.w || glCanvas.height !== src.h) {
      glCanvas.width = src.w;
      glCanvas.height = src.h;
    }
    g.viewport(0, 0, src.w, src.h);
    g.useProgram(prog);
    g.bindTexture(g.TEXTURE_2D, tex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src.canvas as TexImageSource);
    g.uniform1i(uniforms.get("uTex")!, 0);
    g.uniform2f(uniforms.get("uSize")!, src.w, src.h);
    g.uniform1f(uniforms.get("uTime")!, env.time);
    for (const n of names) {
      const v = values[n];
      const loc = uniforms.get(n)!;
      if (Array.isArray(v)) v.length === 3 ? g.uniform3f(loc, v[0], v[1], v[2]) : g.uniform2f(loc, v[0], v[1]);
      else g.uniform1f(loc, v);
    }
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    dst.ctx.drawImage(glCanvas, 0, 0);
    return true;
  } catch (e) {
    console.warn("GPU effect failed, using the canvas version:", e);
    return false;
  }
}

/** "#rrggbb" -> [r, g, b] in 0..1. */
export function rgb(hex: unknown): number[] {
  const h = String(hex ?? "#000000").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}
