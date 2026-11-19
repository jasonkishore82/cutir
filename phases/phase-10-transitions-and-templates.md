# Phase 10: Line Transitions, Style Templates and Chat Tools

## Line transitions
- Handle consecutive lines explicitly: `transition: { type, ms }` between line N and N+1
- Types: none (hard cut), crossfade, slide-push (outgoing leaves while incoming enters), zoom-through
- Overlap handling: the outgoing line's Out and the incoming line's In may overlap by the transition length
- Optional background transition at a chosen time (crossfade between two backgrounds)
- Set per gap from the timeline right-click menu, or one project-wide default

## Style / caption templates
- Built-in presets bundling font, colours, outline, shadow, animation slots and transform (for example Karaoke, Bold Caption, Minimal, Neon)
- Apply to the project, a layer or selected lines; user can save their own template (stored locally in IndexedDB like assets)
- Per-word highlight colour and "active word scale" options for karaoke-style looks

## Chat tools (`lib/tools/`)
Defined once with `defineTool`, in new groups so small models only see them when relevant:
- `move_text(index, x?, y?)`, `scale_text(index, scale)`, `rotate_text(index, degrees)` (group `transform`)
- `set_animation_in` / `set_animation_out` / `set_animation_loop` (replace `set_animation`; keep it as an alias for old prompts)
- `add_keyframe(index, time, props, easing?)`, `clear_keyframes(index)` (group `motion`)
- `set_transition(gap_index, type, ms)`, `apply_template(name, target)`
- All tools validate with zod, apply as a single undoable step and update the `selectToolGroups` keyword routing

## Docs
- Write `ANIMATION.md`: the effect list, the data model, how to add an effect, how to add a chat tool, and how preview and export share the same code path

## Done when
- "Move line 3 to the top left", "make line 2 spin in" and "crossfade between all lines" work with qwen3:8b
- Transitions and templates render identically in preview and export
- `ANIMATION.md` is accurate and a new effect can be added from it alone
