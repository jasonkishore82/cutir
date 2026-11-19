---
name: timeline-editing
description: Edit video and audio clips on the Cutir timeline - place media from the library, trim, move, cut, delete, tracks, markers, clip placement and volume. Use when the user asks to add footage, B-roll, music or voice-over, or to edit clips in Cutir.
---

# Timeline editing in Cutir

Call `get_project` first: it lists tracks (name, kind, target, locked), clips (id, track, media, start, end) and the
media library (id, name, kind, duration). Refer to clips by **id** and to media by **library name or id**.

- **Put media on the timeline:** `add_clip` with `media`, `at` (seconds), optional `track` (a track name, or
  `video` / `audio` for the target track), `in` / `out` (part of the source) and `mode`:
  `overwrite` (default), `insert` (pushes later clips), `append` (after the last clip), `top` (a free track above).
  A video with sound also gets its sound on the audio target track, linked to the picture.
- **Trim:** `trim_clip` with `edge` start or end, `by` (seconds) or `to` (a time); `ripple: true` keeps later clips
  attached.
- **Move:** `move_clips` with `by` or `to`, optionally `track` (same kind). Linked sound moves along.
- **Cut and delete:** `cut_at` (a time, optionally only some clips), `delete_clips` (`ripple: true` closes gaps).
- **Placement:** `set_clip` with x / y in percent (50 / 50 = centre), `scale`, `rotation`, `opacity`, `blend`,
  `fit`; `volume` for audio; `enabled` to switch a clip off.
- **Tracks:** `add_track`, `set_track` (mute, solo, lock, hide, target, rename).
- **Markers and range:** `add_marker`, `set_range` (in / out).
- **Effects:** `add_effect` (blur, glow, vignette, drop-shadow, mask, chroma-key, crop, transform, sharpen, invert,
  mirror, noise, pixelate, animate for in/out motion) with optional `params`; `set_effect` / `remove_effect` to
  change or drop one. Effects apply in order; check the look with `render_frame`.
- **Transitions:** `add_transition` with `type` (cross-dissolve, dip-to-colour, wipe, push, slide, zoom,
  blur-dissolve, spin), `from` / `to` clip ids for a cut (or only one for a fade at an edge), `duration`, `align`;
  `all_cuts: true` for every cut on a track. Linked sound gets a crossfade automatically.

Locked tracks are never changed: if an edit does nothing, check for locks. Media that is missing or needs
permission shows a status in `list_media`; ask the user to relink it in the Media library.
Check the picture with `render_frame` after placing or moving visual clips.
