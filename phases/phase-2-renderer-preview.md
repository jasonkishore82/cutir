# Phase 2: Canvas Renderer and Preview

## Renderer (`lib/renderer.ts`)
- One pure function `drawFrame(ctx, project, time, size)` shared by preview and export
- Default background: diagonal sunset gradient (#1e2a6b -> #5b3a8c -> #d4687a -> #f0a070) with soft-cloud noise
- Text: white, ALL CAPS, Permanent Marker, centered, max 2 lines, wrapped on word boundaries
- Shadow rgba(0,0,0,0.45), blur 12px, offset 0 4px; outline support
- Animations: fade, pop, slide-up, typewriter, word-highlight
- Default: 200ms fade + scale 0.96 -> 1.0 on entry, fade out on exit
- Per-line `styleOverride` support

## Assets
- Audio loading
- Background image/video loop
- Custom .ttf/.otf font upload (via FontFace API)

## Preview component
- Canvas at selected aspect ratio, letterboxed
- Play / pause / seek, current time display, loop region
- Rendering driven from `audio.currentTime` (requestAnimationFrame), never timers

## Done when
- Default look matches the reference image
- Preview stays in sync with the audio
- All style controls and animations visibly change the canvas
