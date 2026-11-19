# Phase 17: Effects, Transitions and Plugin Interface

Reference: Resolve applies effects per clip and transitions at cuts. Cutir needs one effect interface that built-ins and later plugins share.

## Effect interface (`lib/effects/`)
- `Effect { id, name, category, params: ParamSpec[], render(ctx, inputs, params, time) }`
- Params are typed (number, colour, angle, point, boolean, choice, curve) so the inspector and the keyframe editor are generated from the spec
- Effects compile to GPU shader passes where possible, with a canvas fallback

## Clip effect stack
- Per clip ordered stack: enable, reorder, copy and paste, reset, save as preset
- Built-ins: transform, crop, blur, sharpen, glow, vignette, drop shadow, mask, chroma key, invert, mirror, noise, pixelate

## Transitions
- Drop a transition on a cut or at a clip edge; adjustable duration, alignment (start, centre, end) and easing
- Built-ins: cross dissolve, dip to colour, wipe, push, slide, zoom, blur dissolve, spin
- Audio crossfade added automatically with video transitions, editable on its own

## Browser
- Effects panel with search, categories and live hover preview
- Drag onto a clip, a track or the cut

## Lyric features as effects
- The five lyric animations from phase 2 and the slots from phase 8 are re-implemented as effects so they work on any text or clip

## Done when
- At least 12 effects and 8 transitions work in viewer and export
- Adding an effect is one file with a param spec and a shader
- Old lyric animations still render identically
