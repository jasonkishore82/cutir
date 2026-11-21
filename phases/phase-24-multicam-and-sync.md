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

## Status (built)
Built (`src/lib/sync.ts`, `sync.worker.ts`, `syncAudio.ts`, `fileTimecode.ts`, `src/lib/multicam.ts`, `src/components/MulticamCard.tsx`; tests in `tests/retime-multicam.test.ts` and `tests/compound.test.ts`):
- Sync by audio: cross-correlation by FFT at 4 kHz in a worker, with a sub-sample peak and a confidence figure (weak matches are reported). Sync by marker (a marker on each clip) and by timecode. Synced clips are moved and linked to the anchor, so external audio and camera audio move, trim and delete as one.
- Timecode is read from the file when it has one: the `tmcd` track of MP4 and MOV camera files and the time reference of Broadcast WAV field recordings. It is read at import (the probe worker) and can still be typed or overridden by hand.
- Drift: "Correct drift" re-measures the lag in windows along a long recording, fits a line, and plays the clip (and its linked clips on the same media) at the speed that keeps time with the anchor. Unreliable or tiny drift (under 20 ms over the clip) is left alone and reported.
- Multicam clip: made from selected, synced clips (angle offsets come from their positions on the timeline), optionally with a separate recorder as the sound. The viewer plays the angle the cuts name and the export mixes the sound of the angle, the recorder, or a cut's own audio angle.
- The sound goes through a chosen audio track's strip (first audio track by default). A change of sound source crossfades (0.12 s by default, adjustable, 0 for a hard cut), in the live mixer and the export, so an audio-only switch no longer clicks.
- Angle viewer: every angle live in a grid; click or press 1 to 9 to cut. Playing records (each cut replaces what followed); paused adds a cut at the playhead. Switch video only, audio only or both. The cut list shows a still of each angle at its cut, and each cut's sound angle can be set. "Convert cuts to clips" replaces the multicam clip with ordinary clips (video and sound) to trim like any others.
- The multicam clip on the timeline shows its cuts as a coloured strip (angle number, a note mark where the sound comes from another angle).
- Beats: recorded cuts snap to beat markers; "Assemble from the beats" makes a first-draft montage, one clip every 1, 2, 4 or 8 beats from the selected clips or the pool, cut on the beats.

Limits: drift correction fits a straight line (constant clock offset), not a wandering one, and anchors at the clip's start; the timeline strip is hidden on a clip with a speed ramp; timecode is not read from other containers (MXF, MKV) and drop-frame labelling is not shown, only the real time.
