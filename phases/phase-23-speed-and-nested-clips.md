# Phase 23: Speed, Retiming, Freeze Frames and Nested Timelines

Reference: Retiming and nesting are everyday editing needs and are also where timeline data models usually break.

## Speed
- Constant speed from 1 percent to 10000 percent, reverse, with audio pitch correction on or off
- Speed ramps: variable speed through a curve with ease in and out
- Frame interpolation: nearest, blend, optical flow (GPU, optional)

## Freeze and hold
- Freeze frame at playhead, hold the first or last frame, still image export

## Nested timelines
- Turn a selection into a compound clip; open to edit inside; changes inside update every use
- Timelines in the media pool can be placed on other timelines
- Breadcrumb navigation for nested levels and a flatten action

## Subclips and variants
- Subclips from source marks; duplicate timeline for versions (16:9 and 9:16 of the same edit)
- Reframe from 16:9 to 9:16 with a keyframable crop and auto-follow using the tracker

## Done when
- A clip can be retimed with a speed ramp and the audio stays in sync
- Editing inside a compound clip updates all its uses
- A 9:16 version of a timeline can be made without redoing the edit
