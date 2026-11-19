# Phase 18: Keyframe Engine and Curve Editor

Reference: Resolve lets users move keyframes, retime them and set ease controls for nearly every parameter. This phase generalises phase 9 to all effects and clip properties.

## Engine
- Any param from an effect, a transform or an audio control can be animated
- Keyframe types: hold, linear, bezier with handles, preset eases (in, out, in-out, back, elastic, bounce)
- Interpolation of numbers, colours (in a linear space), points and angles with correct wrap-around

## Timeline lane
- Per-clip keyframe lane showing diamonds for the selected parameters
- Add at playhead, drag to retime, shift-drag to snap, multi-select, copy and paste keyframes between clips and params

## Curve editor
- Graph view with value on the vertical axis and time on the horizontal axis, one curve per param
- Drag keyframes and bezier handles; fit, zoom and lock axes; show multiple params at once
- Presets menu to apply ease shapes to selected keyframes

## Canvas interaction
- Moving, scaling or rotating a clip in the viewer writes keyframes when auto-key is on
- Motion path overlay for position keyframes with draggable points

## Done when
- Any parameter can be animated and edited in the curve editor
- Copying keyframes between clips works and respects clip start times
- Exports match the viewer frame for frame
