# Phase 13: Multi-Track Timeline Engine

Reference: Resolve's Edit page stacks video and audio tracks with per-track controls and a pointer-aware editing surface.

## Layout
- Video tracks above the centre line, audio tracks below, subtitle tracks at the top; add, remove, reorder and resize tracks
- Track header: name, lock, mute, solo, visibility, target (which track receives inserts), height
- Time ruler with timecode and frame display, zoom to fit, zoom to selection, horizontal and vertical scroll
- Playhead scrubbing with audio scrub and frame step (left and right arrows)

## Clips
- Clip blocks with thumbnails, waveform, name, duration and effect badges
- Select one, many (shift, ctrl, marquee) and linked selection for video plus its audio
- Move, copy, duplicate, drag across tracks, nudge by frame or by ten frames
- Snapping to playhead, clip edges, markers and grid, with a toggle and a hold-key override

## Virtualised rendering
- Only draw clips and thumbnails in view; timelines of thousands of clips stay responsive
- Draw on canvas or use windowed DOM, measured against a 500 clip benchmark

## Compatibility
- Existing lyric block editing (drag, resize edges, split, merge) keeps working on subtitle tracks

## Done when
- A timeline with 10 tracks and 500 clips scrolls and zooms at 60 fps
- All selection, move and snapping behaviour is covered by tests
- The lyric workflow from phases 3 and 5 still works unchanged
