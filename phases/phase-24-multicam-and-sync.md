# Phase 24: Multicam and Audio Sync

Reference: Multi-angle and dual-system sound are standard for interviews, concerts and events.

## Sync
- Sync clips by audio waveform (cross correlation in a worker), by timecode or by marker
- Sync external audio to camera audio and link them as one clip

## Multicam clip
- Create a multicam clip from several synced angles; angle viewer with a grid
- Switch angles live during playback (click or number keys) and record cuts to the timeline
- Switch video only, audio only or both; adjust cuts afterwards like normal edits

## Lyric and music use
- Snap cuts to the beat using the beat markers from phase 16.5
- Auto-assemble a montage from clips on the beat as a starting point

## Done when
- Three angles with an external audio track sync automatically
- A multicam edit can be recorded in real time and then trimmed
- Beat markers drive snapping

## Status (partly built)
Built (`src/lib/sync.ts`, `sync.worker.ts`, `syncAudio.ts`, `src/lib/multicam.ts`, `src/components/MulticamCard.tsx`; tests in `tests/retime-multicam.test.ts` and `tests/compound.test.ts`):
- Sync by audio: cross-correlation by FFT at 4 kHz in a worker, with a sub-sample peak and a confidence figure (weak matches are reported). Sync by marker (a marker on each clip) and by timecode (a start timecode typed per media). Synced clips are moved and linked to the anchor, so external audio and camera audio move, trim and delete as one.
- Multicam clip: made from selected, synced clips (angle offsets come from their positions on the timeline), optionally with a separate recorder as the sound. The viewer plays the angle the cuts name and the export mixes the sound of the angle, the recorder, or a cut's own audio angle.
- Angle viewer: every angle live in a grid; click or press 1 to 9 to cut. Playing records (each cut replaces what followed); paused adds a cut at the playhead. Switch video only, audio only or both. The cut list can be edited, and "Convert cuts to clips" replaces the multicam clip with ordinary clips (video and sound) to trim like any others.
- Beats: recorded cuts snap to beat markers; "Assemble from the beats" makes a first-draft montage, one clip every 1, 2, 4 or 8 beats from the selected clips or the pool, cut on the beats.

Not built yet: the cut list does not show angle thumbnails; recorded cuts are not drawn on the timeline clip; timecode is typed by hand (the probe does not read it from files); the sound of a multicam clip is mixed through the first audio track's strip; sync assumes constant speed clips and the same sample clock (no drift correction for long recordings); an audio-only switch does not offer a crossfade.
