# Phase 7: Per-Line Properties Panel and Overrides

## Scope
Make every style value editable at the right level: project, layer or single line.

## Resolution order
1. line `styleOverride`
2. layer style
3. project style
- One function `resolveStyle(project, line)` in `lib/` used by renderer, preview overlay and export (no duplicated cascades)

## Properties panel (`components/LeftPanel.tsx` or a new `Inspector.tsx`)
- Shows the selected line; empty selection shows project defaults
- Fields: text, start / end, font, size, colour, outline, shadow, alignment, transform (x, y, scale, rotation) as numbers
- Each field shows where its value comes from (project / layer / line) with a "reset to inherited" button
- "Apply to all lines" and "Apply to layer" actions for the current style
- Copy style from one line and paste onto others

## Multi-select
- Shift-click on canvas or timeline to select several lines
- Moving a multi-selection moves the whole group; the panel edits all selected lines at once (mixed values shown as "mixed")

## Alignment helpers
- Align left / centre / right and top / middle / bottom relative to the canvas for the selection
- Distribute evenly for 3+ lines

## Done when
- Any style value can be overridden for one line and reset again
- Multi-select move and edit work and are a single undo step
- The panel and the canvas always agree on the final resolved value

## Status
- Done. `resolveStyle` (deep merge of shadow, outline and transform) is the one cascade; `effectiveStyle` is kept as an alias.
- The Style and Motion tabs edit the selection, the active layer or the project, chosen with the bar at the top of the tab. Each control shows its source and a reset.
- Not built: a text alignment field (the renderer always centres text).
- Select several lines with Shift-click on the timeline or the preview. On the preview, drag moves the group; scale and rotate handles show for a single line.
