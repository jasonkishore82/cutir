# Phase 8: In / Out / Loop Animation Slots and Easing

Modelled on how editors like CapCut organise text animation: every text item gets an In, an Out and a Loop slot.

## Data model
- Replace the single `animation` + `animationMs` with:
  `animation: { in: { name, ms, easing }, out: { name, ms, easing }, loop: { name, speed } }`
- Each slot may be `none`; lines can override any slot through `styleOverride`
- Migrate old projects: the old animation becomes the `in` slot, the old fixed fade-out becomes the `out` slot

## Effects (`lib/animations.ts`, new)
- Pure functions, one per effect: `(progress, params) -> { opacity, dx, dy, scale, rotation, reveal }`
- In / Out: fade, pop, slide-up, slide-down, slide-left, slide-right, zoom, blur-in, typewriter, rotate-in
- Loop: float, pulse, shake, glow, wave
- Word / letter modes: `word-highlight` (existing), `word-by-word` pop, `letter-by-letter` stagger with a per-item delay
- Renderer calls these and only composes the results, so a new effect is one function plus one registry entry

## Easing
- Shared easing functions: linear, ease-in, ease-out, ease-in-out, back (overshoot), elastic
- Easing is a field on In and Out slots

## UI
- Animation section in the properties panel with three tabs (In / Out / Loop)
- Duration slider per slot; loop speed slider
- Small live preview thumbnail on hover for each effect

## Limits
- In + Out duration never exceeds the line length (existing `dur / 2` rule applies per slot)

## Done when
- A line can have a different In, Out and Loop at the same time
- Every effect is visible in preview and identical in the export
- Old projects look the same as before
