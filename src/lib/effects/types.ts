/**
 * The effect interface (phase 17). Built-in effects and future plugins use the same shape, and the inspector and the
 * keyframe lanes are generated from `params`, so adding an effect is one file: a param spec plus a render (and,
 * where it helps, a GPU shader).
 */

export type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

/** A frame-sized image an effect reads from or draws into (transparent outside the clip). */
export type Layer = { canvas: AnyCanvas; ctx: Canvas2D; w: number; h: number };

export type ParamSpec =
  | { key: string; label: string; type: "number"; min: number; max: number; step?: number; default: number; unit?: string }
  | { key: string; label: string; type: "angle"; default: number }
  | { key: string; label: string; type: "color"; default: string }
  | { key: string; label: string; type: "point"; default: { x: number; y: number } }
  | { key: string; label: string; type: "boolean"; default: boolean }
  | { key: string; label: string; type: "choice"; options: { value: string; label: string }[]; default: string }
  /** Points (x, y in 0..1) of a curve, from left to right. */
  | { key: string; label: string; type: "curve"; default: [number, number][] }
  /** Points (x, y in 0..1) of a closed mask path. */
  | { key: string; label: string; type: "path"; default: [number, number][] }
  /** A 3D LUT imported from a .cube file: { name, size, data (base64, 8 bit rgb) } or null. */
  | { key: string; label: string; type: "lut"; default: null };

export type Params = Record<string, unknown>;

export type EffectEnv = {
  w: number;
  h: number;
  /** Seconds since the clip started (for animated effects). */
  time: number;
  clipDuration: number;
  /** A cleared frame-sized scratch layer (for effects that need an extra pass). */
  scratch: () => Layer;
  /** How far the clip's tracked point has moved since the start, in 0..1 of the frame (phase 22); absent without a tracker. */
  track?: { x: number; y: number };
};

export type EffectCategory = "Transform" | "Blur and sharpen" | "Colour" | "Stylize" | "Keying" | "Distort" | "Animation";

export type GpuPass = {
  /** GLSL ES 3.00 fragment body: reads `uTex` at `vUv`, writes `outColor`. Uniforms are declared by the runner. */
  fragment: string;
  /** Uniform values from the params: numbers, [r,g,b] / [x,y] arrays. */
  uniforms: (p: Params, env: EffectEnv) => Record<string, number | number[]>;
};

export type EffectDef = {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  params: ParamSpec[];
  /** Draw `src` processed into `dst` (dst is cleared). Used when there is no GPU pass or WebGL2 is unavailable. */
  render: (src: Layer, dst: Layer, p: Params, env: EffectEnv) => void;
  /** Optional GPU version; preferred when WebGL2 works. */
  gpu?: GpuPass;
};

export type TransitionDef = {
  id: string;
  name: string;
  description: string;
  params: ParamSpec[];
  /**
   * Composite the outgoing layer `a` and the incoming layer `b` at progress p (0..1, already eased) onto `out`.
   * Either can be null at a clip edge (fade from or to nothing).
   */
  render: (out: Canvas2D, a: Layer | null, b: Layer | null, p: number, params: Params, env: { w: number; h: number; scratch: () => Layer }) => void;
};
