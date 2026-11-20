# Animation in Cutir

How text moves: the effects, where they are stored, how a frame is drawn, and how to add an effect or a chat tool.
Everything here applies to the preview, the MP4 export and the home-screen thumbnails alike, because all three draw
through one function.

## One draw path

```
Preview.tsx ─┐
exporter.ts ─┼─> drawFrame(ctx, project, time, w, h)      src/lib/renderer.ts
thumbnail.ts ┘        │
                      ├─ background
                      └─ for each visible layer (bottom to top):
                           handoverAt(...)  -> a transition is running: draw the outgoing AND the incoming line
                           otherwise        -> draw the line active at `time`
                                drawLyric(): style -> in / out / loop -> transition -> keyframes -> paint
```

There is no separate export renderer. If something looks right in the preview at a given time, the exported frame at
that time is the same picture. Never read the clock (`Date.now()`, `performance.now()`) inside the renderer: every
value must come from `time` and the project, or preview and export drift apart.

## The data model (`src/store/project.ts`)

| Where | Field | Meaning |
|---|---|---|
| `TextStyle.animation.in` | `{ name: EffectName, ms, easing }` | How a line appears. `ms: 0` = the effect's automatic length (typewriter) or nothing. |
| `TextStyle.animation.out` | same | How a line leaves. Effects with `out: false` (word-highlight) cannot be exits. |
| `TextStyle.animation.loop` | `{ name: LoopName, speed }` | Motion while the line is on screen. |
| `TextStyle.transform` | `{ x?, y?, scale, rotation }` | Resting placement. `x`, `y` are the block centre as 0..1 of the canvas; missing = the `position` preset. |
| `TextStyle.highlight` | `{ tint, color, activeScale }` | Karaoke look for the word-highlight entrance: colour of sung words, size of the word being sung. |
| `LyricLine.keyframes` | `Keyframe[]` | Custom motion. `time` is seconds from the line's start; `props` are offsets (see below). |
| `LyricLine.transition` | `{ type, ms }` | Hand-over into the next line on the same layer. Missing = `Project.transition`. |
| `Project.transition` | `{ type, ms }` | Default hand-over between consecutive lines. |

Styles cascade **project -> layer -> line** (`resolveStyle`). Any field, including a single field inside
`animation.in`, can be overridden at a lower level. Read styles only through `resolveStyle`.

## The order effects are applied in

For one line at time `t`, `drawLyric` builds one `Fx` (`{ opacity, dx, dy, scale, rotation, blur, reveal }`) and
draws with it:

1. **In slot** at presence 0 -> 1 over its duration (skipped while a transition brings the line in).
2. **Out slot** at presence 1 -> 0 over its duration (skipped while a transition takes the line out).
3. **Loop** at `t - start`.
4. **Transition** (`TRANSITIONS[type].in / .out` at progress 0..1).
5. **Keyframes**: `x`, `y` move by a fraction of the canvas width / height, `scale` and `opacity` multiply,
   `rotation` adds degrees.

Steps 1-4 combine with `combineFx` (opacity and scale multiply, offsets and rotation add, blur takes the max). A slot
never uses more than half the line (`slotSeconds`), so in and out never overlap within one line.

Word and letter effects (`mode: "word" | "letter"`) run the same `fx` per unit, staggered by `spread`. `reveal` effects
(typewriter) show a growing share of the characters. `highlight` (word-highlight) lights words at their sung times:
real word timings from auto-sync when present, otherwise an even split.

## Effects (`src/lib/animations.ts`)

### In / out (`EFFECTS`)

| Name | Mode | What it does |
|---|---|---|
| `none` | block | Nothing. |
| `fade` | block | Opacity, with a slight scale-up on entry. |
| `pop` | block | Scale from 60% with overshoot (`easeOutBack`). |
| `slide-up`, `slide-down`, `slide-left`, `slide-right` | block | Slide 6% of the height (10% of the height sideways) while fading. |
| `zoom` | block | Shrink from 150%. |
| `blur` | block | Blur up to 14px (1080p) while fading. |
| `rotate` | block | Turn 25° while fading and growing. ("spin" in chat.) |
| `typewriter` | reveal | Characters appear one by one; automatic length from the text. |
| `word-highlight` | highlight | All words dim, each lights up when sung. Entrance only. |
| `word-by-word` | word | Each word pops in, 70% stagger. |
| `letter-by-letter` | letter | Each letter rises in, 85% stagger. |

An effect is a pure function `fx(presence, phase)`: presence 0 = hidden, 1 = fully shown; `phase` is `"in"` or
`"out"` (use it to mirror direction). The same definition serves both slots.

### Loops (`LOOPS`)

`none`, `float` (bob up and down), `pulse` (breathe in size), `shake`, `glow` (halo in the text colour), `wave`
(letters ripple; uses `letterDy`). A loop is `fx(t, speed)` where `t` is seconds into the line.

### Easings (`EASINGS`)

`linear`, `ease-in`, `ease-out`, `ease-in-out`, `back` (overshoot), `elastic`. Used by the slots, by keyframes (the
earlier keyframe's easing shapes the move to the next) and internally by transitions.

### Transitions (`TRANSITIONS`)

| Name | Outgoing line | Incoming line |
|---|---|---|
| `none` | hard cut | hard cut |
| `crossfade` | fades out | fades in |
| `slide-push` | pushed up and out | pushed up from below |
| `zoom-through` | grows, blurs and fades | grows from 70% and fades in |

`handoverAt` (renderer.ts) finds the running transition: the window is `ms` long and centred on the gap between two
consecutive lines of a layer, so the outgoing tail and the incoming head overlap by the transition length. Lines
further apart than `ms` just cut. The window is never longer than either line.

## Keyframes (`src/lib/keyframes.ts`)

```ts
type Keyframe = { id: string; time: number; props: Partial<Record<"x" | "y" | "scale" | "rotation" | "opacity", number>>; easing: Easing };
```

- Each property animates on its own between the keyframes that key it, holding before the first and after the last.
- `evalKeyframes(kfs, t)` returns all five values; unkeyed properties stay at rest (`x 0, y 0, scale 1, rotation 0, opacity 1`).
- Times are relative to the line start, so moving or retiming a line moves its keyframes. `splitKeyframes` and
  `mergeKeyframes` keep the motion continuous when lines are split or merged.
- In the editor: K adds a keyframe at the playhead; dragging the text while the playhead is on a keyframe (or with
  auto-key on) edits keyframes instead of the resting placement (`TextOverlay.tsx`).

## Clip keyframes (phase 18, `src/lib/keyframes/`)

Lyric lines keep their own motion keys (above). Timeline clips use a general engine that animates any value:

- **Engine** (`engine.ts`): a lane is a sorted list of keys `{ t, v, mode, easing, out, in }`. `t` is seconds from the
  clip's start, so keys move with the clip. Modes: `hold`, `linear`, `ease` (with an easing: ease-in, ease-out,
  ease-in-out, back, elastic, bounce) and `bezier` (`out` / `in` handles as [time fraction, value fraction] of the span).
  Values are numbers, angles (they wrap the short way round), colours (mixed in linear light so midpoints do not go dark)
  and points `{x, y}`.
- **Lanes** (`lanes.ts`): `lanesOf(clip, doc)` lists what a clip can animate: x, y, scale, rotation and opacity for
  pictures, volume for sound, and every numeric, angle, colour or point param of its effects. Placement keys live in
  `clip.anim`, effect keys in `effect.keys`. All writers (`setLaneKey`, `moveLaneKeys`, `shapeLaneKeys`, `pasteLanes`,
  `writePlacement`...) are pure `Timeline -> Timeline` functions, so every edit is one undo step.
- **Render**: `transformOf(clip, t)` in the compositor and `paramsAt(effect, t)` evaluate the lanes, and the audio mixer
  turns volume keys into a gain curve. The viewer and the export share these, so they match.

### Editing

- **Animate card** (Motion tab): every value of the selected clip with a ◆ key button, previous/next key, show lane ▤,
  clear ✕, and an ease row. Auto-key and the motion path switch on here, along with the **Curve editor** button.
- **Timeline lanes**: the selected clip's lanes with keys (or the ones you show with ▤) appear under it as rows of
  diamonds. Click selects, Shift or Ctrl adds to the selection, drag retimes (snapping to the playhead, clip edges and
  other keys; Shift turns snapping the other way), double-click jumps to the key, right-click removes it.
- **Keyboard**: with keys selected, Ctrl+C copies, Ctrl+V pastes onto the selected clip (at the playhead when it is inside
  that clip, otherwise at the same offset from the clip start), Delete removes, Esc deselects. Effect keys paste onto
  the same effect type.
- **Curve editor** (under the timeline): value over time for the shown lanes. Drag keys and bezier handles, double-click
  to add a key, Ctrl+wheel to zoom time, Fit, lock time or value, and the ease menu for the selected keys.
- **Viewer**: the selected picture clip gets a box. Drag it to move, a corner to scale, the knob to rotate (Shift snaps
  to 15 degrees). With auto-key on, or when that value already has keys, each change writes a key at the playhead. The
  motion path (dashed) shows where the clip travels; drag its points to move position keys, click one to jump there.
- **Chat / MCP**: `key_clip` (`clip`, `value` such as scale or blur.radius, `keys: [{ t, v, ease }]`, `replace`) and
  `clear_clip_keys`.

## Templates (`src/lib/templates.ts`)

A template is a named `StyleOverride` (font, colours, outline, shadow, position, animation slots, highlight).
`applyTemplate(target, template)` writes its fields at the chosen level (project, layer or selected lines) in one
undo step. Built-ins: Karaoke, Bold Caption, Minimal, Neon, Cinematic. User templates are stored in IndexedDB on the
device (`templates/user` in the `cutir-assets` database). To add a built-in, append to `BUILTIN_TEMPLATES`; only the
fields in `TEMPLATE_PATHS` are applied.

## How to add an in / out effect

1. Add the name to `EffectName` in `src/store/project.ts`.
2. Add the definition to `EFFECTS` in `src/lib/animations.ts`:
   ```ts
   flip: {
     label: "flip",
     out: true,                  // can it be an exit?
     mode: "block",              // block | reveal | highlight | word | letter
     fx: (p, ph) => ({ opacity: p, scale: 0.8 + 0.2 * easeOutCubic(p), rotation: (ph === "in" ? -1 : 1) * (1 - p) * 90 }),
   },
   ```
   Offsets (`dx`, `dy`) are fractions of the canvas **height**, `blur` is in 1080p pixels, `rotation` in degrees.
3. Add the name to the `Animation` enum in `src/lib/tools/schema.ts` so the older `set_animation` alias accepts it.

That is all. The effect appears in the Motion panel (it lists `IN_EFFECTS` / `OUT_EFFECTS`), the chat tools
`set_animation_in` / `set_animation_out` offer it (their enum is built from `EFFECTS`), and preview and export both
draw it. Optionally add an everyday word for it to `EFFECT_WORDS` in `src/lib/tools/motion.ts` ("flip" -> `flip`).

A loop is the same idea in `LOOPS` plus `LoopName`; a transition is an entry in `TRANSITIONS` plus `TransitionType`
(and the `TRANSITION_TYPES` list in `tools/motion.ts`).

## How to add a chat tool

Tools live in `src/lib/tools/`, one file per group. A tool is one `defineTool({...})`:

```ts
export const myTool = defineTool({
  name: "my_tool",                       // what the model calls
  group: "motion",                       // style | lines | scene | sync | layers | transform | motion
  description: "One sentence the model reads.",
  hint: "optional extra guidance for the system prompt",
  params: z.object({ index: idx.optional(), amount: num(0, 1) }),   // zod: validates and builds the JSON schema
  normalize: (args) => args,             // optional: repair what small models send (wrong keys, "150%", "top left")
  prepare: async (args) => {},           // optional: async work before applying (download a font); throw to reject
  apply: (project, args) => ({ project: nextProject, summary: "what changed" }),   // pure; throw Error to fail
});
```

Then add it to the group's exported array and, for a new file, to the `createRegistry([...])` list in
`src/lib/tools/index.ts`. `applyCalls` validates every call, runs them all as **one undo step**, and reports bad calls
back to the model. To change styles at the right level from a tool, use `editProjectStyle(p, target, { set, unset })`
from `src/lib/styleEdit.ts` (the same function the panels use).

Groups other than style, lines, scene and sync are only sent when the message mentions them, to keep the prompt short
for small models. The routing is the keyword lists in `selectToolGroups` (`TRANSFORM_WORDS`, `MOTION_WORDS`): add
the words people will use for your tool. A tool with `alias: true` still runs when called but is never offered
(`set_animation` is kept this way for older prompts).

### The animation tools

| Tool | Group | Example request |
|---|---|---|
| `set_animation_in` / `set_animation_out` (`index?`, `effect`, `durationMs?`, `easing?`) | style | "make line 2 spin in" |
| `set_animation_loop` (`index?`, `effect`, `speed?`) | style | "make everything float" |
| `move_text` (`index?`, `place?` or `x?`/`y?` in %) | transform | "move line 3 to the top left" |
| `scale_text` (`index?`, `scale`) / `rotate_text` (`index?`, `degrees`) | transform | "tilt the chorus 10 degrees" |
| `add_keyframe` (`index`, `time`, `props`, `easing?`) / `clear_keyframes` (`index?`) | motion | "make line 4 drift right" |
| `set_transition` (`gap_index?`, `type`, `ms?`) | motion | "crossfade between all lines" |
| `apply_template` (`name`, `index?`) | motion | "use the karaoke template" |

Leaving out `index` applies to every line (the project style).
