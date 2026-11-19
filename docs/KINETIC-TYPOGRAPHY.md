# Kinetic Lyric Typography

What kinetic typography is, how it works, what Cutir can already do, and ten ideas to take it further.

## What it is

Kinetic typography is text that moves to tell the story. In a kinetic lyric video the words are the picture: they
appear when they are sung, grow on the words that matter, shake on a drum hit and fly off when the line ends. The
viewer reads the song and feels its rhythm at the same time.

Compared with a plain lyric video:

| Plain lyric video | Kinetic lyric video |
|---|---|
| One line at a time, same place, same size | Words placed, sized and styled one by one |
| Lines fade in and out | Each word enters and leaves with its own motion |
| Timing per line | Timing per word or syllable |
| Font chosen once | Font, weight and colour change with meaning and energy |
| Ignores the beat | Pulses, cuts and pops land on the beat |
| Static frame | "Camera" pans and zooms through the text |

## How it works

A kinetic lyric frame is built from five layers of decisions. Every good kinetic video, whether hand-made in After
Effects or generated, answers all five.

### 1. Timing: when does each word exist?

Everything starts from time. Each word needs a start and an end, ideally per syllable for fast or stretched vocals.

- **Source**: forced alignment of the lyrics against the vocal (Cutir's auto-sync uses stable-ts / Whisper and stores
  per-word times in `LyricLine.words`), or manual tapping.
- **Phrase grouping**: words are grouped into phrases (a breath, a bar). A phrase is the unit that shares one layout.
- **Lead-in and hold**: words usually appear a few frames before they are sung (so the eye is ready) and hold a little
  after, so fast lines stay readable.

### 2. Hierarchy: which words matter?

Not every word is equal. Kinetic type makes the important ones big and lets the small ones ("the", "a", "and") sit
quietly beside them.

- **Emphasis words**: nouns, verbs and emotional words; the title hook; words the singer stretches or belts.
- **Signals**: word length in time (a held note), loudness of the vocal at that moment, position in the phrase, and
  meaning (which an AI model can judge).
- **Scale steps**: usually 2 to 4 sizes, not a continuous range, so the layout looks designed rather than random.

### 3. Layout: where does each word go?

The phrase is arranged as a composition, like a poster, instead of a centred subtitle.

- **Stacking**: words on separate rows, big words taking a full row, small words tucked beside them.
- **Justified blocks**: every row stretched to the same width, so the phrase forms a clean rectangle.
- **Rotation**: a word turned 90 degrees running up the side of the block.
- **Grid and safe area**: everything aligned to a grid inside the title-safe area, so it survives 16:9, 9:16 and 1:1.

The layout is solved once per phrase, then animated.

### 4. Motion: how do words enter, move and leave?

Motion carries rhythm and meaning.

- **Entrances and exits** per word: pop, slide, drop, type, scale from zero, blur in. Staggered across the phrase so
  the eye follows the singing.
- **Meaningful motion**: "fall" drops, "rise" floats up, "shake" shakes, "spin" spins, "fade away" fades.
- **Easing**: overshoot (back) for punch, ease-out for calm, elastic for playful. Linear motion looks mechanical.
- **Continuous motion**: a slow drift or zoom while the phrase is on screen keeps it alive between hits.

### 5. Rhythm: how does it follow the music?

What makes it feel like a music video rather than animated subtitles.

- **Beat grid**: the tempo and beat times of the song (beat tracking from the audio).
- **Hits**: on a beat or a drum onset, a quick scale pulse, a flash, a shake or a hard cut to the next phrase.
- **Energy**: louder or busier sections get faster, bigger motion; quiet verses get slow, small motion.
- **Camera**: the whole composition is placed in a larger virtual canvas and a virtual camera pans, zooms and rotates
  across it from phrase to phrase.

### Putting it together

```
audio ──> word timings ──> phrases ──> emphasis ──> layout ──> per-word motion ──> beat hits ──> camera ──> frame
          (auto-sync)                  (rules/AI)   (solver)   (effects+keyframes) (beat track)  (virtual)
```

Every stage is deterministic given the project data, so the same project always renders the same frames, and the
preview and the export stay identical (see `ANIMATION.md`, "One draw path").

## What Cutir already has

| Need | In Cutir today | Where |
|---|---|---|
| Per-word timing | Auto-sync stores word times; even split when missing | `LyricLine.words`, `backend/`, `lib/autosync.ts` |
| Per-word entrances | `word-by-word`, `letter-by-letter`, `typewriter`, `word-highlight` | `EFFECTS` in `lib/animations.ts` |
| Karaoke emphasis | Sung-word colour, current word grows | `TextStyle.highlight` |
| Free placement | Move, scale, rotate per line on the preview | `TextStyle.transform`, `TextOverlay.tsx` |
| Custom motion | Keyframes per line (position, scale, rotation, opacity) | `lib/keyframes.ts` |
| Continuous motion | Loops: float, pulse, shake, glow, wave | `LOOPS` |
| Phrase hand-over | Transitions between lines | `TRANSITIONS`, `handoverAt` |
| Looks | Templates (Bold Caption, Neon, ...) | `lib/templates.ts` |
| AI control | Chat tools for placement, animation, keyframes, transitions | `lib/tools/` |

What is missing: words are not separate objects (a line is one block), there is no beat information, no automatic
emphasis, no layout solver and no virtual camera.

## Ten ideas for Cutir

Ordered roughly from the foundation up. Each lists what it adds, how it could work in Cutir's architecture, and the
size of the work.

### 1. Words as objects

Make every word of a line addressable: its own style override, transform, keyframes and in/out slot, falling back to
the line's. This is the foundation for everything below.

- **How**: `LyricLine.wordStyle?: Record<number, StyleOverride>` and per-word keyframes keyed by word index; the
  renderer already draws word by word for stagger effects, so it extends that path. On the preview, double-click a line
  to select single words.
- **Size**: large (renderer, overlay, panels, data model; v2 clips can carry it in `TextPayload`).

### 2. Beat detection and a beat grid

Find the tempo and beat times of the song once, show beats as ticks on the timeline, and let anything snap to them.

- **How**: an onset/beat tracker (librosa-style spectral flux + tempo estimate) in the Python backend next to
  auto-sync, or a small Web Audio implementation for offline use. Store `timeline.markers` of kind `beat`. Snap line
  edges and keyframes to beats.
- **Size**: medium.

### 3. Beat reactions

Per-line or per-template "on beat" effects: pulse, flash, shake, nudge, colour swap, jump cut. Strength follows the
loudness of the beat.

- **How**: a new slot `animation.beat: { name, strength }` evaluated from the beat grid (like loops are evaluated from
  time), composed with `combineFx`. Preview and export match because the beat grid is project data.
- **Size**: small once idea 2 exists.

### 4. Automatic emphasis

Pick the key words of each line and make them big, bold or coloured, with 2 to 3 size steps.

- **How**: rules first (long sung duration, stressed vocal from the audio level, stop-word list, repeated hook words),
  then an optional AI pass: one chat tool `emphasize_words(index, words, level)` so the model can choose by meaning.
  Writes per-word styles from idea 1.
- **Size**: medium.

### 5. Phrase layout solver ("poster mode")

Arrange each line as a designed block: stacked rows, big words on their own row, justified widths, an optional
vertical word, all inside the safe area for the current aspect ratio.

- **How**: a deterministic solver that takes words, emphasis levels and the canvas size and returns per-word
  positions and sizes (try a few row splits, score by fill and balance, keep the best). A handful of layout presets:
  Stack, Justify, Staircase, Side word.
- **Size**: large.

### 6. Meaning-driven motion ("words that act")

Words animate according to what they mean: "fall" drops, "rise" floats, "spin" spins, "shake", "explode", "freeze",
"whisper" (small and faded), "scream" (huge, shaking).

- **How**: a small dictionary of verbs and adjectives mapped to word effects (with synonyms), applied to matching words
  when the user asks ("make the words act it out") or when a template turns it on. The AI can extend it per song.
- **Size**: small to medium (on top of idea 1).

### 7. Virtual camera

Lay phrases out across a big virtual canvas and move a camera between them: pan to the next phrase, zoom into the hook,
rotate on the drop.

- **How**: a camera track on the timeline with keyframes (x, y, zoom, rotation) using the existing keyframe engine;
  the renderer applies the camera transform before drawing text. "Auto camera" places each phrase next to the previous
  one and generates moves on phrase changes, timed to beats.
- **Size**: medium to large.

### 8. Energy-aware styling

Quiet parts look calm (thin weight, slow fades, small size); loud parts look intense (heavy weight, fast pops,
shake), following the song's loudness curve.

- **How**: compute an RMS loudness envelope once (Web Audio, offline), store it with the media item, and let styles map
  energy to size, weight, speed and loop strength. A single "Energy" slider in templates.
- **Size**: medium.

### 9. Kinetic templates

Ready-made kinetic looks that combine everything: "Hip-hop punch" (bold stack, beat pops, shake on hits), "Ballad"
(serif, slow drift, soft fades), "Pop karaoke" (colour sweep, bouncy words), "Trap" (glitch, hard cuts), "Indie"
(handwritten, scattered words).

- **How**: extend `Template` to carry per-word rules (emphasis levels, word effects, layout preset, beat reaction,
  camera style). Applying a template sets the rules; the rules regenerate the per-word styles when lyrics or timings
  change.
- **Size**: medium (after ideas 1 to 5).

### 10. "Make it kinetic" in one prompt

One chat request turns a plain lyric project into a kinetic video: pick a kinetic template for the song's mood, find
emphasis words, solve layouts, add beat reactions and camera moves, then explain what it did. Every step stays
editable and undoable as one operation.

- **How**: a planning prompt that calls the tools from ideas 1 to 9 in order (`apply_template`, `emphasize_words`,
  `set_layout`, `set_beat_reaction`, `auto_camera`), applied with `applyCalls` as a single undo step. Works with small
  local models because each tool is simple; larger models can choose more per line.
- **Size**: small once the tools exist.

## Suggested order

1. Words as objects (1) and beat grid (2): the two foundations.
2. Beat reactions (3) and automatic emphasis (4): the biggest visible jump for the least work.
3. Layout solver (5) and words that act (6).
4. Camera (7) and energy (8).
5. Kinetic templates (9) and "make it kinetic" (10) to package it all.

Every idea keeps Cutir's rules: project data in, frames out, the same draw path for preview and export, every edit one
undoable operation, and every feature reachable from the chat.
