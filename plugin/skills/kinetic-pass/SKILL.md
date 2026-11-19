---
name: kinetic-pass
description: Give a Cutir lyric video a kinetic typography feel - emphasis on key words and lines, motion that matches meaning, keyframed movement. Use when the user asks for kinetic text, more energy, or text that moves with the song.
---

# Kinetic pass in Cutir

Kinetic typography makes the words perform the song: timing, hierarchy, layout, motion and rhythm
(`cutir://docs/animation` explains the effects; the project's docs/KINETIC-TYPOGRAPHY.md has the background).

With the tools available today:

1. `get_project`, then pick the lines that matter: the hook, the title line, held notes (long lines with few words),
   the last line.
2. **Hierarchy:** for those lines use `update_style` through templates or per-line tools: bigger `scale_text`,
   a stronger colour via `apply_template` with `index`, or `set_animation_in` with `pop` / `zoom` / `word-by-word`.
   Keep other lines calmer (`fade`, `slide-up`).
3. **Meaning:** match motion to words: falling words `slide-down`, rising `slide-up`, spinning `rotate`, shaky
   `set_animation_loop` `shake`, dreamy `float` or `blur`.
4. **Movement:** `add_keyframe` to drift important lines across the frame (two keyframes: start and end of the
   line, `x` / `y` offsets in percent, easing `ease-in-out`), or `move_text` for placement.
5. **Flow:** `set_transition` `slide-push` or `zoom-through` between energetic lines, `crossfade` in calm parts.
6. `render_frame` on a few emphasised lines to check that nothing leaves the frame or becomes unreadable.

Beat-synced effects and per-word styling are not in Cutir yet; say so if the user asks for them.
