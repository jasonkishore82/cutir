# Phase 14: Edit Tools and Trimming

Reference: Resolve uses one smart trim tool that picks ripple, roll, slip or slide from the pointer position, plus a blade, insert, overwrite and replace.

## Tools
- Selection tool (default), Trim tool, Blade tool, Hand tool, Zoom tool, with single-key shortcuts
- Smart pointer: edge of a clip trims, between two clips rolls, middle band slips, clip name area slides, with the cursor and a tooltip showing the mode

## Trim modes
- Ripple: trim an edge and shift later clips on the track
- Roll: move the cut between two clips, total length unchanged
- Slip: change the visible source range, clip length and position unchanged
- Slide: move a clip, neighbours absorb the change, clip length unchanged
- Each mode shows a live two-up or four-up viewer of the frames at the edit points

## Placement edits
- Insert (shift later clips), Overwrite, Replace, Place on top, Fit to fill, Append to end
- Three-point and four-point edits using source in and out marks and timeline in and out marks
- Lift and extract (delete range with or without closing the gap), split at playhead, join through edit

## Markers and ranges
- Markers with colour, name and note on the ruler and on clips; jump to next and previous
- In and out range on the timeline, used for playback loop, export range and range edits

## Operations
- Each tool emits phase 11 operations; one gesture is one undo step
- Ripple delete, ripple trim and roll are tested against edge cases (gaps, locked tracks, linked audio)

## Done when
- All four trim modes work with the smart pointer and match Resolve's behaviour on the same sequence
- Insert, overwrite and replace work with source marks
- Locked tracks are never changed by any edit
