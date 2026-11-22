# Phase 19: Titles, Text and Shapes

Reference: Titles are generators in Resolve. Cutir already has the best text tooling for lyrics, so this phase makes it a general titling system.

## Text clip
- Text clips live on any video track, not only subtitle tracks; rich text with per-range font, size, colour, weight, italic and underline
- Text box with auto-fit, alignment, line and letter spacing, paragraph styles, background box with padding and radius
- Fills: solid, gradient, image; strokes; shadow and glow; 3D-free bevel emulation with layered strokes

## Per-character animation
- Text animators in the style of After Effects: range selector (start, end, offset) driving position, scale, rotation, opacity and colour per character, word or line
- Presets: typewriter, word pop, line slide, wave, blur in, karaoke fill

## Templates
- Title templates: lower third, centred title, quote, credits roll, scoreboard; saved as presets with exposed fields
- Lyric mode is a template pack that binds a subtitle track to the text animator and the sync tools from phases 3 to 5

## Shapes and generators
- Rectangle, ellipse, line, polygon, arrow, gradient background, solid colour, noise, countdown and timecode generators

## Fonts
- Google Fonts and local fonts as today, plus font fallback chains and a missing font warning

## Done when
- A lower third and a credits roll can be built from templates in under a minute
- Per-character animation works with kerning and right-to-left text
- All existing lyric projects keep their look

## Status (done)
Built: generator clips on any video track (solid, gradient, noise, countdown, timecode, rectangle, ellipse, line, polygon, arrow, title); titles with rich runs (colour, weight, italic, underline, size, font), auto-fit, alignment, line and letter spacing, background box, gradient and image fill, stroke, shadow, glow and a layered-stroke bevel; per-letter, word or line animators with a range selector (typewriter, word pop, line slide, wave, blur in, karaoke fill, spin in, slide in, drop in, colour flash) that drive position, rotation, scale, opacity, blur and colour; a custom animator builder (the starting look of each piece, set with sliders); credits roll; templates (lower third, centred title, quote, credits roll, scoreboard) with fields; user title presets (save the selected title's look, add it again with new words; kept in the browser); per-range font family in the Titles tab; font fallback chain and a missing-font warning; kerning and right-to-left words; chat tools `add_title`, `add_title_template` and `update_title`. Tests: tests/titles.test.ts, tests/titles-phase19b.test.ts.

Also built: the lyric pack (`src/lib/lyricPack.ts`): six packs (karaoke fill, word pop, typewriter, wave, blur in, line slide) turn the lines of a subtitle track into title clips with the same words, start and length, on a video track bound to the subtitle track (`Track.lyricsOf`). The subtitle lines stay as the timing source, switched off in the picture; converting again after a retime replaces the generated titles, and Back to subtitles undoes it. Chat tool `lyrics_to_titles`. Saved multi-clip templates (`src/lib/userTemplates.ts`): select several generator clips, save them under a name, add the group again with new words (every title becomes a field; timing and stacking are kept). Both are in the Titles tab. Test: tests/lyricpack.test.ts.

By design: right-to-left words animate whole, not letter by letter, because a shaped Arabic or Hebrew word cannot be split into letters. A pack spreads its animation evenly across the line; it does not use per-word sync times. Not yet checked in a real browser.
