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

## Status (partly built)
Built: the Colour grade effect (lift, gamma, gain, offset with masters and RGB, contrast and pivot, saturation, hue, temperature, tint, highlights, shadows, amount), an HSL qualifier with matte preview, softness and invert, RGB curves plus hue vs hue, hue vs saturation and luma vs saturation with an inline curve editor, .cube LUT import with intensity, a colour space transform effect (Rec.709, sRGB, Rec.2020, Display P3, S-Log3, LogC, V-Log; log curves only, no camera gamut), and waveform, parade, vectorscope and histogram scopes in the Effects tab. All are ordinary effects, so they stack, keyframe (numeric params), copy and paste between clips, and save as presets. Tests: tests/grade.test.ts.

Also built: round colour wheels for lift, gamma, gain and offset (drag the puck, master slider under each, double-click to reset) and an Auto balance button (gray-world balance plus a levels stretch from the viewer frame; `src/lib/grade/auto.ts`).

Also built: hue vs luma and saturation vs saturation curves, a qualifier matte blur (box blur up to 5% of the frame width), a project working space and output space (Canvas card; the composed frame is converted at the end of drawFrame, so preview and export match; per-clip input transforms use the Colour space transform effect), and a Stills card (save the viewer frame with the clip's colour effects, wipe compare against the live frame, apply a still's grade to a clip).

Not built yet: a GPU path (grading runs on the CPU, so it is slower than the GPU effects at 1080p; scopes sample a 256 x 144 copy and stay real time); a dockable Colour workspace (phase 27); stills are kept in memory for the session, not saved with the project.
