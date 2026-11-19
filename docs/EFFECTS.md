# Effects and Transitions

How clip effects and transitions work in Cutir (phase 17), and how to add one. For the lyric text animations see
`ANIMATION.md`.

## What exists

**Effects** (`src/lib/effects/builtins/`, one file each): Transform, Crop, Blur, Sharpen (GPU), Glow, Vignette,
Drop shadow, Mask, Chroma key (GPU), Invert, Mirror, Noise (GPU), Pixelate, and **Animate in / out**, which brings the
lyric In / Out animations (fade, pop, slide, zoom, blur, rotate...) to any video or image clip.

**Transitions** (`src/lib/effects/transitions/builtins.ts`): Cross dissolve, Dip to colour, Wipe, Push, Slide, Zoom,
Blur dissolve, Spin. On audio tracks a transition is an equal-power **crossfade**; adding a video transition between
clips with linked sound adds the crossfade automatically, and it can then be edited or removed on its own.

## Where they live in a project

- `Clip.effects: ClipEffect[]`: the clip's stack, applied top to bottom. Each has `type` (the effect id), `enabled`,
  `params` and optional `keys` (keyframes per numeric param, `t` in seconds from the clip's start).
- `Timeline.cutTransitions: ClipTransition[]`: each sits at the cut between `from` and `to` on one track, or at one
  clip's edge (only `from` = out at its end, only `to` = in at its start). `align` puts it before, across or after
  the cut; `duration` in seconds; `easing`; `params` for the transition.

## How a frame is drawn

`compositeVisuals` (src/render/compositor.ts), the same for the viewer and export:

1. For each visible video track, bottom to top, `visualPlan` decides: the transition running there, or the clips
   under the playhead.
2. A clip with no enabled effects is drawn straight onto the frame (the phase 15 path).
3. A clip with effects is drawn into a frame-sized layer (with its placement and opacity), then each effect turns one
   layer into the next (`applyStack`), then the result is blended onto the frame with the clip's blend mode.
4. A transition renders both clips' layers (with their effects) and mixes them with its `render`. Frames on the
   other side of the cut come from the clips' handles (source beyond their in / out points), clamped to the file.

Export decodes exactly what `needsAt` lists, including both sides of a transition, so it matches the viewer.
The render cache (phase 16) drops only the frames an effect or transition change can affect.

## Adding an effect: one file

Create `src/lib/effects/builtins/myEffect.ts`:

```ts
import type { EffectDef } from "../types";
import { filtered, num } from "../util";

export const sepia: EffectDef = {
  id: "sepia",                       // lowercase, digits, dashes
  name: "Sepia",
  category: "Colour",                // Transform, Blur and sharpen, Colour, Stylize, Keying, Distort, Animation
  description: "Old photo tones",
  params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 100, default: 80, unit: "%" }],
  // canvas version (always required): draw src into dst
  render: (src, dst, p) => filtered(src, dst, `sepia(${num(p, "amount", 80) / 100})`),
  // optional GPU version, used when WebGL2 works
  gpu: {
    uniforms: (p) => ({ uAmount: num(p, "amount", 80) / 100 }),
    fragment: `
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 s = vec3(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131)));
  outColor = vec4(mix(c.rgb, s, uAmount), c.a);
}`,
  },
};
```

Then add it to the list in `src/lib/effects/index.ts` (or, from a plugin, call `registerEffect(sepia)`). That is all:

- the **Effects tab** lists it (search, category, hover preview, drag onto clips),
- the **inspector** is generated from `params` (sliders, colour wells, checkboxes, choices, points, angles), and
  numeric params get **keyframes** (the diamond button),
- the chat and the **MCP server** can use it through `add_effect` / `set_effect` (their help text lists every effect
  and its params),
- the viewer and export draw it the same way.

### Param types

| type | value | control |
|---|---|---|
| `number` | number in `min..max` | slider, keyframeable |
| `angle` | degrees | slider -180..180, keyframeable |
| `color` | `"#rrggbb"` | colour well |
| `point` | `{ x, y }` in 0..1 of the frame | two sliders |
| `boolean` | true / false | checkbox |
| `choice` | one of `options[].value` | dropdown |
| `curve` | `[x, y][]` points in 0..1 | (chat only for now) |

Values coming from the inspector, the chat or saved projects pass through `cleanParams`: clamped to ranges, wrong
types and unknown keys dropped.

### Render rules

- `src` and `dst` are frame-sized layers; `dst` starts cleared. Draw your result into `dst`; never change `src`.
- Sizes in params are in 1080p pixels; scale with `px(value, src)` so they look the same at any output size.
- Use `env.time` (seconds into the clip) for anything animated, never the clock, so the viewer and export match.
- Need an extra pass? `env.scratch()` gives a cleared frame-sized layer.
- GPU shaders get `uTex` (the source), `uSize` (pixels), `uTime` (seconds) and your uniforms. Uniform types come
  from the name: `uCol...` and `uKey...` are `vec3`, `uPt...` is `vec2`, others `float`. Write `outColor`.

## Adding a transition

Same idea in `src/lib/effects/transitions/` with a `TransitionDef`: `render(out, a, b, p, params, env)` draws the
outgoing layer `a` and incoming layer `b` (either can be null at a clip edge) at eased progress `p` onto `out`.
Register it with `registerTransition` (or add it to `BUILTIN_TRANSITIONS`).

## Chat and MCP tools

`add_effect`, `set_effect`, `remove_effect`, `add_transition` (with `all_cuts: true` for every cut on a track) and
`remove_transition`, in `src/lib/tools/effects.ts`.
