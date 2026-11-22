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

## Status (done)
Built (`src/lib/retime.ts`, `src/timeline/compound.ts`, `src/lib/freeze.ts`, `src/components/SpeedCard.tsx`, `TimelinesCard.tsx`; tests in `tests/retime-multicam.test.ts` and `tests/compound.test.ts`):
- Speed from 1% to 10000%, reverse (video and, in the export, audio), pitch kept or not. Pitch is kept by a waveform-similarity time stretch in the export and by `preservesPitch` live. A clip's source time comes from one function (`sourceAtRel`) used by the viewer, the export, the tracker and the edit tools.
- Speed ramps: speed keys over the clip, straight or eased, with presets and a graph; the clip keeps its length and shows whatever source the ramp covers. Blade, trim and head trim all understand ramps and reverse; the audio of a ramped clip follows the speed (pitch changes).
- Frame interpolation: repeat the nearest frame, or blend the two frames around the time. Optical flow is not built.
- Freeze: freeze at the playhead (cuts the clip and ripples a still in), hold first frame, hold last frame, and export the viewer frame as a PNG. The still is an image added to the media pool.
- Nested timelines: make a compound clip from a selection (its clips move into a new timeline), place any timeline on another as one clip (loops are refused, nesting up to 4 deep), open it to edit inside with a breadcrumb and "Up a level", flatten it back (its speed is applied to the parts). Every use of a timeline follows edits made inside. Nested audio is mixed in the export.
- Versions: duplicate a timeline, or make a 9:16 or 1:1 version in one step. A version has its own frame shape; picture clips fill it, centred, or following a tracker with position keyframes you can edit.
- Subclips from source marks or the selected clip, placed with the normal edits.
- Chat tools: `set_clip_speed`, `make_compound_clip`, `make_version`.

Also built (the rest of the phase; tests/phase23-rest.test.ts):
- Optical flow slow motion (`src/lib/flow.ts`): "Follow the motion" next to repeat and blend. The two source frames are compared as small grey pictures (block matching with sub-pixel refinement, median-cleaned); each block is then drawn from frame A moved back and frame B moved forward along its vector and the two are mixed. Checked on a textured picture with a known shift: the halfway frame is much closer to the true one than a plain blend. A pair of frames where almost nothing moves falls back to a blend. Vectors are worked out once per frame pair and kept. The chat tool `set_clip_speed` takes `interpolation`.
- Sound inside nested clips is heard live (`src/lib/audio/nested.ts`): the nested clip's audio clips become stand-in clips on the host timeline (placed, trimmed and sped by the nested clip's window and speed, inner track level kept), so they play sample-accurately through the host strip like any others. Muted inner tracks and disabled nested clips are silent. Reverse sound live came with phase 21.
- A speed ramp is drawn on the timeline clip (the curve of the speed with a line at normal speed), and a reversed clip shows a ◀ mark.
- Markers set inside a nested timeline show as ticks on the clip that plays it.
- Auto-follow reframe now allows for how the clip sat in its frame (its fit, scale and position, and a picture of another shape than the frame): the tracker's point is turned into a place on the picture before the crop is worked out.
- Subclips are listed in the media pool (Import screen) with Place and delete, as well as in the Timelines card.

Not checked in a real browser (the flow drawing on a canvas, the nested sound on a real audio clock). Limits: flow is block based (a thin fast object can tear, and the first frames of a clip are blended when the motion is too large for the search); live sound inside a nested clip leaves out a ramped or reversed nested clip and inner pan and processors (the export has them); inner subtitle tracks are not shown inside a nested clip, because lyric layers belong to the project rather than to a timeline; the reframe uses the clip's fixed transform, not keyframes on it.
