# Phase 20: Colour Correction and Grading

Reference: Resolve's Color page is built around primary wheels, curves, scopes and LUTs. A browser editor can offer the same core tools on the GPU.

## Primary tools
- Lift, gamma, gain and offset wheels with master sliders; contrast, pivot, saturation, hue, temperature, tint, highlights, shadows
- Auto balance and a reset per control

## Curves and qualifiers
- RGB curves, hue vs hue, hue vs saturation, luma vs saturation
- HSL qualifier with a matte preview, softness and blur; use as a mask for any correction

## LUTs and colour management
- Import .cube LUTs, apply per clip or per track, with intensity
- Project colour space setting (Rec.709, sRGB, Rec.2020, Display P3) and a transform stage on input and output
- Basic log to Rec.709 presets for common camera profiles

## Scopes
- Waveform, parade, vectorscope and histogram computed on the GPU from the current frame
- Scopes sit in a dockable panel and update during playback

## Workflow
- Colour tab in the workspace (phase 27) with viewer, wheels and scopes
- Stills gallery: save a frame with its grade, compare with a wipe or split view, copy grade between clips
- All controls are effect params, so they are keyframable

## Done when
- A clip can be graded with wheels, curves and a LUT and the viewer and export match
- Scopes update in real time at 1080p
- Grades copy between clips and can be saved as presets
