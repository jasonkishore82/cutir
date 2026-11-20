---
name: lyric-video
description: Build or improve a lyric video in the Cutir editor - sync lyrics to the song, choose a look, animate, add transitions and check the result. Use when the user asks to make, style or fix a lyric video in Cutir.
argument-hint: "[style or mood]"
---

# Make a lyric video in Cutir

Work through the Cutir MCP tools. Each tool call is one undo step for the user, so make one clear change per call.

1. **Look first.** Call `get_project`. Note the song, the lyric lines (1-based index, start, end, text), layers,
   the media library and the aspect ratio. If nothing is connected, follow the `connect` skill.
2. **Lyrics.** If there are no lines, ask the user for the lyrics and add them with `add_line` (one per line).
3. **Timing.** If lines are untimed or evenly spaced, run `auto_sync` (needs the Cutir backend; if it fails, say so
   and offer to space lines evenly with `update_line` / `shift_timings`). Fix overlaps and lines shorter than
   0.6 seconds.
4. **Look.** Pick a template with `apply_template` (Karaoke, Bold Caption, Minimal, Neon, Cinematic) that fits
   `$ARGUMENTS` or the song. Then adjust: `set_font`, `update_style` (size, colour, outline, shadow, position).
5. **Motion.** `set_animation_in` / `set_animation_out` / `set_animation_loop` for the whole video, or with `index`
   for single lines that deserve emphasis (the hook, the last line). Add `set_transition` between lines.
6. **Check.** `render_frame` at the start, at a chorus and near the end. Read the text in the image: is it readable,
   inside the frame, not covering faces in a background video? Fix what is not.
7. **Report.** Summarise what changed and how to undo it (Ctrl+Z in Cutir, one step per change). Only call
   `export_video` if the user asks; then follow it with `export_status`.

Keep the user's existing choices unless they ask to replace them.
