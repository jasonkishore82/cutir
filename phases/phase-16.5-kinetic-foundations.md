# Phase 16.5: Kinetic Foundations (Words, Beats, Emphasis and Energy)

Reference: `docs/KINETIC-TYPOGRAPHY.md`, ideas 1 to 4 and 8 and the beat sync plan. Kinetic lyric videos treat every word as its own object, hit on the beat, make the key words big and grow with the song's energy. This phase builds those foundations; layouts, camera and kinetic templates come later.

## Words as objects (idea 1)
- Every word of a line is addressable: its own style override, transform, keyframes and in/out slot, falling back to the line's
- Data: `LyricLine.wordStyle?: Record<number, StyleOverride>` and per-word keyframes keyed by word index; text clips carry the same in `TextPayload`
- Keep word overrides when a line's text is edited: match words by position and text instead of dropping `words` (today `linesFromText` clears them)
- Renderer extends the existing word-by-word stagger path so each word resolves its own style, transform and effects
- Preview: double-click a line to select single words; move, scale, rotate and restyle them like lines; Esc goes back to the line
- Properties panel shows the selected word's overrides with a "reset to line" action

## Beat detection (idea 2)
- Detect tempo and every beat time from onset strength (sudden jumps in spectral energy, such as drum hits) once, when a song is added
- Backend route next to auto-sync using librosa or madmom (accurate); Web Audio fallback in a worker when the backend is offline
- Flag downbeats and store the onset strength of each beat
- Re-run on demand from the media item's menu; manual tempo and first-downbeat offset for songs the detector gets wrong

## Beats as project data
- Add `kind` to `Marker` (`"user" | "beat"`, default `"user"`), plus `downbeat` and `strength` for beat markers; migrate old projects
- Beat markers sit on the timeline, so preview and export always match and the song is not re-analysed on each render
- Ruler draws beat ticks, downbeats stronger; beat markers stay out of the marker list and next/previous marker keys unless asked for
- Snapping (phase 13) includes beats: line edges, word times, keyframes and clip edits snap to the nearest beat, with its own toggle

## Beat reactions (idea 3)
- New animation slot next to In / Out / Loop: `animation.beat: { name, strength, downbeatsOnly? }`, on a line or a single word
- Effects: pulse, flash, shake, nudge, colour swap, jump cut; each is one entry in `animations.ts` like the loop effects
- The renderer takes the time since the nearest beat and applies a short decaying effect, combined through `combineFx` like a loop
- Hit strength follows the beat's onset strength, so big hits react more than soft ones
- Extend `Fx` with a colour or brightness term for flash and colour swap

## Automatic emphasis (idea 4)
- Pick the key words of each line and give them 2 to 3 size steps, bolder weight or an accent colour, written as word overrides
- Rules first: long sung duration, vocal loudness at the word, stop-word list, repeated hook words
- Optional AI pass: the model chooses by meaning through one chat tool
- Emphasis levels are stored per word, so restyling a level updates every word at that level

## Energy curve (idea 8)
- Compute the song's RMS loudness curve once (offline, in a worker) and store it on the media item
- Energy scales beat reaction strength, motion speed and loop strength: calm in quiet verses, intense in loud choruses
- One "Energy" amount per line or project, from none to full
- Draw the curve faintly under the audio waveform

## Chat tools
- `select_words` / `set_word_style`, `detect_beats`, `set_beat_reaction`, `snap_to_beats`, `emphasize_words(index, words, level)`, `set_energy`
- Each is one undoable operation and is exposed through the MCP server

## Later (not in this phase)
- Phrase layout solver, "poster mode" (idea 5)
- Meaning-driven motion, "words that act" (idea 6)
- Virtual camera with moves timed to downbeats (idea 7)
- Kinetic templates with built-in beat reactions, such as "Hip-hop punch" (idea 9)
- "Make it kinetic" in one prompt (idea 10)
- "Cut to the next line on every downbeat" and montage on the beat; phase 24 reuses these beat markers instead of detecting its own

## Done when
- A single word can be selected on the preview, moved, restyled and keyframed, and keeps its changes when the line text is fixed
- A typical pop or hip-hop song gets beats within 30 ms of hand-tapped ones, with downbeats correct on most bars
- Beat ticks show on the ruler and line and word edges snap to them
- A pulse beat reaction looks the same in preview and export, stronger on big hits and louder sections
- Automatic emphasis makes a plain line look designed in one click and can be undone in one step
- Old projects open unchanged, and words, beats, emphasis and energy are covered by tests
