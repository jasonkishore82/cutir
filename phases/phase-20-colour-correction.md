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

## Status (done)
Built: the Colour grade effect (lift, gamma, gain, offset with masters and RGB, contrast and pivot, saturation, hue, temperature, tint, highlights, shadows, amount), an HSL qualifier with matte preview, softness and invert, RGB curves plus hue vs hue, hue vs saturation and luma vs saturation with an inline curve editor, .cube LUT import with intensity, a colour space transform effect (Rec.709, sRGB, Rec.2020, Display P3, S-Log3, LogC, V-Log; log curves only, no camera gamut), and waveform, parade, vectorscope and histogram scopes in the Effects tab. All are ordinary effects, so they stack, keyframe (numeric params), copy and paste between clips, and save as presets. Tests: tests/grade.test.ts.

Also built: round colour wheels for lift, gamma, gain and offset (drag the puck, master slider under each, double-click to reset) and an Auto balance button (gray-world balance plus a levels stretch from the viewer frame; `src/lib/grade/auto.ts`).

Also built: hue vs luma and saturation vs saturation curves, a qualifier matte blur (box blur up to 5% of the frame width), a project working space and output space (Canvas card; the composed frame is converted at the end of drawFrame, so preview and export match; per-clip input transforms use the Colour space transform effect), and a Stills card (save the viewer frame with the clip's colour effects, wipe compare against the live frame, apply a still's grade to a clip).

Also built (the rest of the phase):
- GPU path (`src/lib/grade/gpu.ts`): Colour grade, Curves (RGB, hue vs hue, hue vs saturation, luma vs saturation, hue vs luma, saturation vs saturation), LUT and Colour space transform run as shaders. They read the same tables as the canvas versions (tone tables, curve tables, the colour matrix, the LUT, the encode and decode tables) uploaded as float textures, so the picture matches. The qualifier matte blur needs neighbouring pixels, so a grade with it switched on uses the canvas version, as does a LUT effect with no LUT. The runner (`src/lib/effects/gpu.ts`) gained table textures, a way for a pass to ask for the canvas version, and it stops retrying a shader that failed to compile. The Effects list shows the GPU badge on these effects.
- Colour dock: scopes, the selected clip's colour effects (wheels, curves, LUT, colour space, with buttons to add each) and the stills gallery in one panel beside the viewer (`src/components/ColourDock.tsx`). It is part of the page layout (`dock`, `dockW`): the Color page opens with it, any page can show it (Layout preset "Colour dock on", or the command "Show or hide the colour dock"), it resizes with a drag handle, hides with its Hide button, and is saved and exported with the other layouts. With the dock open the Effects tab leaves out its scopes and stills.
- Stills are kept with the project (`src/store/stillsSync.ts`): loaded when a project opens, saved when they change, under the project's own key (so they stay out of the project file, versions and sync), at most 24 and about 2 MB, oldest dropped first, removed when the project is deleted.
- Tests: tests/grade-gpu.test.ts checks that the tables the shaders read equal the canvas tables, that every uniform and table a shader names is supplied, and the fallbacks; tests/colour-dock.test.ts covers stills storage and the layout.

Not checked: the shaders themselves were not run on a real graphics card (node has none), so a compile error or a one-level rounding difference from the canvas version would only show in a browser; a shader that fails to compile falls back to the canvas version automatically. Stills are not part of a project package or of the interchange files. Not yet looked at in a real browser.
