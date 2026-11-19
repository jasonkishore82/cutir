# Phase 9: Keyframes (Position, Scale, Rotation, Opacity)

Custom motion for cases the presets cannot cover (a line drifting across the screen, a word flying in from a corner).

## Data model
- `LyricLine.keyframes?: { time: number, props: { x?, y?, scale?, rotation?, opacity? }, easing: EasingName }[]`
- `time` is relative to the line start so moving or retiming the line moves its keyframes with it
- Between keyframes values interpolate with the easing of the earlier keyframe; before the first and after the last they hold
- Keyframe values are added on top of the resolved style transform and the In / Out / Loop animation

## Renderer
- `evalKeyframes(line, t)` in `lib/animations.ts`; composed after style and slot animations
- Same code path for preview and export

## Timeline UI (`components/Timeline.tsx`)
- Selected line shows a keyframe lane under its block with diamond markers
- Add keyframe at the playhead (button and K shortcut); drag diamonds to retime; Delete removes
- Right-click a diamond for easing, copy and delete
- Per-property toggle so only the properties you change get keyframed

## Canvas interaction
- With the playhead on a keyframe, moving or scaling the text on the canvas edits that keyframe
- Moving the text between keyframes with auto-key on creates a new keyframe at the playhead
- Optional motion-path line on the canvas showing the x / y trajectory

## Done when
- Dragging text at two points in time makes it move smoothly between them
- Keyframes survive line retiming, split and merge (split divides keyframes at the cut)
- Exports match the preview frame for frame
