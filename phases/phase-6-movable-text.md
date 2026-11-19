# Phase 6: Movable Text (Canvas Selection and Transform)

## Data model (`store/project.ts`)
- Add `transform` to `TextStyle` (so it works per project, per layer and per line via `styleOverride`):
  `{ x: number, y: number, scale: number, rotation: number }`
- `x` / `y` are fractions of the canvas (0..1, centre of the text block), so the placement survives any aspect ratio change
- `scale` multiplies `fontSize` (1 = unchanged); `rotation` in degrees
- Keep the `position` presets (`center`, `bottom`, ...). A preset is just a shortcut that writes `x` / `y`; migrate old projects on load
- Default transform reproduces today's look exactly (no visual change for existing projects)

## Renderer (`lib/renderer.ts`)
- `drawFrame` applies translate -> rotate -> scale around the text block centre
- Export a helper `getLineBounds(project, line, time, size)` returning the rotated box, used for hit-testing and the selection overlay (one source of truth, no duplicated layout code)
- Preview and export still share the same `drawFrame`

## Preview interaction (`components/Preview.tsx`)
- Click a line on the canvas to select it; clicking empty space deselects
- Selection overlay: bounding box, 4 corner scale handles, 1 rotate handle
- Drag body = move, drag corner = scale (Shift keeps it uniform), drag rotate handle = rotate (Shift snaps to 15 degrees)
- Arrow keys nudge by 1px (Shift = 10px); Delete is NOT bound here
- Pointer events with capture so dragging works over the canvas edge; touch supported
- Only lines visible at the current time are selectable; selecting a line in the timeline selects it on the canvas and the reverse

## Snapping and guides
- Snap to canvas centre (horizontal and vertical) and to safe margins (5%)
- Show thin guide lines while snapping; hold Alt to disable snapping

## History
- A drag is one undo step (use the existing continuous-gesture history API in the store)
- Undo / redo restores selection too

## Done when
- A line can be dragged, scaled and rotated directly on the preview
- Changes appear identically in the export
- Old projects open unchanged; changing the aspect ratio keeps text where it should be
- One drag = one undo step
