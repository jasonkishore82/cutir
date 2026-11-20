# Cutir: AI tool ideas

20 ideas for new tools the chat assistant could use, with an example of what you would type, what each tool does, a sketch of its parameters, and what it would take to build.

## How tools work in Cutir

- Each tool is one `defineTool({...})` in `src/lib/tools/` (see `docs/TOOL-CALLING.md`): a zod parameter schema, a description, an optional async `prepare` step, and a pure `apply(project, args)` function that returns the new project.
- Everything else is generated from that definition: the Ollama schema, the prompt line, validation, undo (one undo step per AI reply), and the "Applied changes" card.
- Tools are grouped (`style`, `lines`, `layers`, `scene`, `sync`). Only relevant groups are sent to the model, which matters for small 8B models.
- A request that is clear enough can also run **directly** from chat without asking the model (as "auto sync" and "use X font" already do): add a pattern to `directIntent` in `src/store/chat.ts`.

**Tools that exist today (16):** `update_style`, `set_font`, `set_animation`, `add_line`, `update_line`, `delete_line`, `shift_timings`, `split_line`, `merge_lines`, `add_layer`, `update_layer`, `delete_layer`, `move_line`, `set_background`, `set_aspect`, `auto_sync`.

**Effort key:** Small = a tool only. Medium = a tool plus some supporting code. Large = needs new rendering, audio analysis or backend work.

---

## Ideas 1 to 10

| # | Tool | You say | Effort |
|---|---|---|---|
| 1 | `style_lines` | "make lines 5 to 8 pink and bigger" | Small |
| 2 | `undo` / `redo` | "undo that" | Small |
| 3 | `find_replace` | "replace 'colour' with 'color' everywhere" | Small |
| 4 | `clean_lyrics` | "clean up the lyrics" | Small |
| 5 | `set_durations` | "make every line 3 seconds" / "close the gaps" | Small |
| 6 | `add_title` | "add a title card 'My Song' for the first 4 seconds" | Small |
| 7 | `add_translation` | "add a Spanish translation layer" | Medium |
| 8 | `detect_chorus` | "highlight the chorus" | Medium |
| 9 | `export` | "export as 1080p MP4" / "give me the .srt" | Medium |
| 10 | `background_overlay` | "darken the background so the text is readable" | Medium |

### 1. `style_lines`
Style a range of lines on their own (colour, size, animation) without changing the rest.
- Params: `from_index`, `to_index`, `patch` (the same fields as `update_style`).
- Needs: nothing new. The per-line `styleOverride` already exists in the data model and the renderer.

### 2. `undo` / `redo`
Step the project back or forward from chat.
- Params: `steps?` (default 1).
- Needs: calls the store's `undo()` / `redo()`. Because tool calls from one reply are already grouped into a single undo step, "undo that" reverts the whole previous AI edit. Care is needed so an `undo` tool does not undo its own reply.

### 3. `find_replace`
Fix wording across the lyrics.
- Params: `find`, `replace`, `layer?`, `match_case?`.
- Needs: nothing new.

### 4. `clean_lyrics`
One-step tidy-up: drop `[Verse]`-style tags, collapse double spaces, trim stray punctuation, optionally fix casing.
- Params: `layer?`, `remove_tags?`, `fix_case?`.
- Needs: nothing new. Useful for lyrics pasted from Suno.

### 5. `set_durations`
Evenly set line lengths or close gaps, instead of shifting lines one by one.
- Params: `from_index?`, `to_index?`, `seconds?` (fixed length) or `close_gaps: true`.
- Needs: nothing new.

### 6. `add_title`
Create a timed title or credits block on its own layer.
- Params: `text`, `start?`, `duration?`, `position?`, `font_size?`.
- Needs: nothing new (uses the layer helpers).

### 7. `add_translation`
The model writes translated lines, which land on a new layer with the same timings as the originals.
- Params: `language`, `lines: string[]` (one per source line), `layer_name?`.
- Needs: no new code, but small models may struggle to return a long list reliably. Consider chunking or verifying the line count.

### 8. `detect_chorus`
Find repeated lines and style them differently (bigger, another colour or animation).
- Params: `patch` (style to apply), `min_repeats?`.
- Needs: a normalised-text matcher, then it reuses the per-line style override.

### 9. `export`
Start an export from chat.
- Params: `format` (`mp4` | `srt` | `ass`), `fps?`, `aspect?`.
- Needs: the exporter is currently driven by the Export dialog; it needs a small entry point callable from a tool, and a way to report progress in the chat.

### 10. `background_overlay`
A dim and/or blur layer over the background so text stays readable on busy images or video.
- Params: `dim` (0 to 1), `blur?` (px).
- Needs: a new renderer feature (draw the overlay after the background), a field in the project's `Background`, and the tool.

---

## Ideas 11 to 20

| # | Tool | You say | Effort |
|---|---|---|---|
| 11 | `play_control` | "play from line 3" / "loop the chorus" | Small |
| 12 | `snap_to_beats` | "snap the lines to the beat" | Large |
| 13 | `project_settings` | "rename this project" / "switch to 60 fps" | Small |
| 14 | `apply_mood` | "make it feel like a sunset" | Medium |
| 15 | `text_effect` | "add a neon glow" | Medium |
| 16 | `resync_lines` | "re-sync lines 10 to 12" | Medium |
| 17 | `set_lyrics` | "use these lyrics: …" | Small |
| 18 | `duplicate_layer` | "add an echo of the lyrics, offset by 0.3s" | Medium |
| 19 | `word_by_word` | "show the lyrics one word at a time" | Medium |
| 20 | `check_timing` | "check my timing" / "fix overlaps" | Medium |

### 11. `play_control`
Control playback from chat.
- Params: `action` (`play` | `pause` | `seek`), `time?`, `line?`, `loop_lines?`.
- Needs: calls the existing transport functions. It does not change the project, so it must be excluded from the "no-op" check and the undo step.

### 12. `snap_to_beats`
Move line starts onto the nearest beat of the song.
- Params: `strength?`, `from_index?`, `to_index?`.
- Needs: beat detection on the audio. This could be done in the browser (onset analysis) or in the Python backend (for example with librosa). A real feature in its own right.

### 13. `project_settings`
Project-level changes from chat.
- Params: `name?`, `fps?` (30 | 60), `aspect?`.
- Needs: the project name lives in the library store, so this tool touches both stores.

### 14. `apply_mood`
One request sets a coordinated look: gradient, font, animation, colours.
- Params: `mood` (a preset name or free text), or explicit `bundle`.
- Needs: a small library of presets (sunset, neon, calm, retro…). Optionally `save_preset` / `apply_preset` so users can name their own looks. Most useful as a way to cut several tool calls into one.

### 15. `text_effect`
Glow, hard shadow, outline presets.
- Params: `effect` (`glow` | `hard_shadow` | `outline`), `color?`, `strength?`.
- Needs: glow requires a coloured shadow/blur option in the renderer; the others map onto existing shadow and outline fields.

### 16. `resync_lines`
Re-run alignment for only a range of lines.
- Params: `from_index`, `to_index`, `separate?`.
- Needs: the aligner API to accept a time window (the backend would align only that part of the audio), plus merging the result back into those lines.

### 17. `set_lyrics`
Replace or insert lyrics from text pasted in the chat.
- Params: `text`, `layer?`, `mode` (`replace` | `append`), `format?` (`plain` | `lrc` | `srt`).
- Needs: reuses the existing `.lrc`/`.srt` parsers. Long pasted text is better handled directly (like the font shortcut) than passed through a small model.

### 18. `duplicate_layer`
Copy a layer, optionally shifted in time (an echo or shadow-text effect).
- Params: `layer`, `offset_seconds?`, `style?`.
- Needs: layer helpers already exist; add a copy-with-offset function.

### 19. `word_by_word`
TikTok-style captions: one word (or short phrase) at a time.
- Params: `layer`, `words_per_block?`.
- Needs: uses real word timings when auto-sync has produced them, otherwise an even split. Creates many blocks, so it should write to a new layer and be easy to undo.

### 20. `check_timing`
Report problems, then optionally fix them.
- Params: `fix?` (overlaps, gaps, too-short lines).
- Checks: overlapping lines on a layer, lines shorter than a minimum, reading speed too fast, lines past the end of the audio, text that overflows the frame, missing audio.
- Needs: mostly a pure analysis function; the fix mode reuses `set_durations`.

---

## Suggested build order

1. **`undo` / `redo`, `style_lines`, `clean_lyrics`**: small, fix everyday annoyances, and need nothing new.
2. **`find_replace`, `set_durations`, `add_title`, `set_lyrics`, `check_timing`**: small to medium and make timing and text edits much faster.
3. **`apply_mood`, `duplicate_layer`, `word_by_word`, `export`**: bigger payoff, some supporting code.
4. **`background_overlay`, `text_effect`, `detect_chorus`, `add_translation`, `resync_lines`**: need renderer or backend work, or are sensitive to small-model reliability.
5. **`snap_to_beats`**: its own project.

## Keeping the tool list manageable

With 16 tools the schemas are already about 6.7 KB per request, and 8B models get less accurate as the list grows. Adding 20 more would roughly double that. Before adding many tools:

- Add groups for the new areas (for example `timing`, `effects`, `project`) and extend `selectToolGroups` so only the relevant ones are sent.
- Prefer direct intents for clear, common requests (undo, export, fonts, auto-sync) so they never depend on the model.
- Keep one broad tool over several near-identical ones.
- Add a small set of fixed test prompts per tool, so changes can be checked against each model.
