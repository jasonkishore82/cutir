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

## Status (partly built)
Built (`src/lib/retime.ts`, `src/timeline/compound.ts`, `src/lib/freeze.ts`, `src/components/SpeedCard.tsx`, `TimelinesCard.tsx`; tests in `tests/retime-multicam.test.ts` and `tests/compound.test.ts`):
- Speed from 1% to 10000%, reverse (video and, in the export, audio), pitch kept or not. Pitch is kept by a waveform-similarity time stretch in the export and by `preservesPitch` live. A clip's source time comes from one function (`sourceAtRel`) used by the viewer, the export, the tracker and the edit tools.
- Speed ramps: speed keys over the clip, straight or eased, with presets and a graph; the clip keeps its length and shows whatever source the ramp covers. Blade, trim and head trim all understand ramps and reverse; the audio of a ramped clip follows the speed (pitch changes).
- Frame interpolation: repeat the nearest frame, or blend the two frames around the time. Optical flow is not built.
- Freeze: freeze at the playhead (cuts the clip and ripples a still in), hold first frame, hold last frame, and export the viewer frame as a PNG. The still is an image added to the media pool.
- Nested timelines: make a compound clip from a selection (its clips move into a new timeline), place any timeline on another as one clip (loops are refused, nesting up to 4 deep), open it to edit inside with a breadcrumb and "Up a level", flatten it back (its speed is applied to the parts). Every use of a timeline follows edits made inside. Nested audio is mixed in the export.
- Versions: duplicate a timeline, or make a 9:16 or 1:1 version in one step. A version has its own frame shape; picture clips fill it, centred, or following a tracker with position keyframes you can edit.
- Subclips from source marks or the selected clip, placed with the normal edits.
- Chat tools: `set_clip_speed`, `make_compound_clip`, `make_version`.

Not built yet: optical-flow interpolation; reverse sound and sound inside a nested clip are not heard live (the export has them); a ramp is not drawn on the timeline clip itself; a nested clip's markers, effects on inner tracks' strips and subtitle tracks are not shown inside it; the auto-follow reframe assumes the tracked picture fills the original frame; subclips are not shown in the media pool, only in the Timelines card.
