# Cutir: animation ideas

Ideas for more animation styles, with what each one looks like. None of these are built yet.

## What exists today

- **Text animations:** fade, pop, slide-up, typewriter, word-highlight. Each line also fades out at the end.
- **Background:** gradient, image or video. The background does not move.

Everything is drawn by the shared canvas code (`drawFrame` in `src/lib/renderer.ts`), so the preview and the exported video always match.

---

## A. Background motion (a new kind of animation)

| Name | What it looks like |
|---|---|
| **Ken Burns** | The classic documentary effect: the background image very slowly zooms in or out while drifting to one side. It turns a still photo into something that feels alive. Options: zoom in or out, pan direction, how far it moves. |
| **Slow zoom ("breathing")** | The image gently zooms in and back out in a loop. |
| **Gradient drift** | For gradient backgrounds: the colours slowly shift and the gradient angle rotates, so the sunset look never sits still. |
| **Crossfade slideshow** | Several backgrounds fade into each other over the song. The biggest of the four, since it needs multiple background images. |

## B. Text entrance (how a line appears)

| Name | What it looks like |
|---|---|
| **Fade in** (pure) | Only the opacity changes. Today's "fade" also scales slightly. |
| **Slide left / right / down** | The line glides in from the side, or down from above (slide-up already exists). |
| **Zoom in / zoom out** | The line grows from small, or shrinks from large, into place. |
| **Blur in** | The text starts blurry and sharpens into focus. |
| **Bounce** | The line drops in and springs a little past its spot before settling. |
| **Spin in** | The line rotates into place. |
| **Wipe reveal** | The text is uncovered from left to right, like a curtain. |

## C. Text that animates while it is on screen

| Name | What it looks like |
|---|---|
| **Word-by-word fade** | Each word fades in one after another, in time with the line. |
| **Letter rise** | Each letter lifts and fades in, one after another. |
| **Karaoke fill** | Each word fills with a colour as it is sung, sweeping left to right (today's word-highlight just brightens whole words). |
| **Wave** | The letters bob up and down like a wave. |
| **Heartbeat pulse** | The line pulses gently in size as it plays. |
| **Neon flicker** | A glowing sign that flickers. |
| **Glitch / shake** | A digital jitter with colour-split flashes, for a punchier or darker song. |

## D. Exit and extras

| Name | What it looks like |
|---|---|
| **Separate exit animation** | Choose how a line leaves independently of how it arrives (fade out, slide away, zoom out). Today it always fades. |
| **Per-layer animation** | Each layer can use its own animation, for example the translation fading while the lyrics bounce. |
| **Beat pulse** | The background or text pulses on the beat. Needs beat detection on the audio, so it is a larger job. |

---

## Suggested first set

Ken Burns, fade in, slide left/right, zoom in, blur in, word-by-word fade, karaoke fill, wave, glitch, and a separate exit animation. That covers the look described above, and none of it needs new audio analysis.

## Notes for building

- Text animations extend `AnimationName` and the `switch (style.animation)` in `drawLyric` (`src/lib/renderer.ts`). A separate exit animation adds an `animationOut` field to `TextStyle`.
- Per-letter and per-word effects (letter rise, wave, word-by-word fade, karaoke fill) need per-character or per-word drawing, which `drawLyric` already does for typewriter and word-highlight.
- Blur in can use the canvas `filter` property; check performance in the export path.
- Ken Burns and gradient drift need a background transform that depends on time (and on the song or loop length), so `drawBackground` has to receive the current time. Add the settings to the project's `Background` type.
- Per-layer animation already works structurally, because a layer's style overrides the project style.
- Add the new names to the animation dropdown in the left panel and to the `Animation` enum used by the AI tools, so the chat can set them.
