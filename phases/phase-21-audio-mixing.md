# Phase 21: Audio Editing and Mixing

Reference: Resolve's Fairlight page is a full audio workstation. Cutir needs a solid mixer and editor on top of the Web Audio API.

## Engine
- AudioWorklet based mixer; sample accurate scheduling from the timeline; shared clock with the video pipeline
- Offline render of the mix for export using the same graph

## Mixer
- One strip per audio track plus a master: gain, pan, mute, solo, meters with peak hold, clip warning
- Automation: record and draw volume and pan curves as keyframes (phase 18)
- Buses and sends for shared reverb; track grouping

## Clip editing
- Waveform view with zoom, fade handles, crossfades, gain line, clip gain, reverse, normalize to a level
- Silence detection and removal, with a preview of what will be cut
- Linked and unlinked video and audio

## Processors
- Parametric EQ, compressor, limiter, gate, de-esser, noise reduction, high and low pass, reverb, delay
- Loudness meter (LUFS, true peak) with targets for YouTube, broadcast and podcast, and one-click match

## Recording
- Voice-over recording from a microphone onto a track with count-in and take management

## Done when
- Multi-track mixes play glitch free and export identically to what was heard
- Loudness targets can be met with one action
- Volume automation is keyframed and editable in the curve editor

## Status (done)
Built (`src/lib/audio/`, `src/render/audio.ts`, `src/components/AudioPanel.tsx`, tests in `tests/audio.test.ts`):
- Pure DSP shared by the export, the loudness measure and the tests: RBJ biquads (parametric EQ with low shelf, two peaking bands and high shelf, high pass, low pass), compressor with soft knee, limiter, gate, de-esser, noise reduction (a floor-following expander), reverb, delay.
- Loudness after BS.1770: integrated LUFS with both gates, short-term and momentary maxima, loudness range, true peak (4x oversampled). Targets for YouTube (-14), podcast (-16) and broadcast (-23), and "Match target", which renders the mix, sets the master gain and a peak ceiling.
- Mixer: a strip per audio track (gain, pan, reverb send, group, processors, meter with peak hold and clip light) and a master strip (gain, peak limiter, processors). The viewer routes the song and every clip through Web Audio strips with meters; EQ, filters, compressor and limiter are heard live. Track gain and pan automation lanes (keyframes at the playhead; edited as ordinary keyframes), and clip volume automation from phase 18.
- Export mix: each track is rendered on its own, run through its processors, then summed with gain, pan, sends and the master (`mixTracks`).
- Clip tools: fade in and out (equal power, also live), reverse (export and loudness only), clip gain, normalize to a peak, silence detection with a preview strip and "cut them out" (ripple, linked tracks follow).
- Voice-over: microphone recording with a count-in, placed on the audio target at the playhead; every take is kept in the media pool.
- Chat tools: `set_track_mix`, `set_master`, `set_audio_clip`.

Also built (the rest of the phase):
- Every processor is heard live. Gate, de-esser, noise reduction, reverb and delay run in an AudioWorklet (`src/lib/audio/worklet.ts`), the streaming form of the functions in dsp.ts. tests/worklet.test.ts runs the worklet source block by block against the export's functions and the output is bit for bit the same. One difference: live noise reduction follows the quietest tenth of the last ten seconds instead of the whole clip, so it adapts over the first moments.
- The reverb send bus is live: each strip's send (after gain and pan, like the export) feeds one shared reverb that joins the master.
- Reverse is heard live, and clips are scheduled on the audio clock (`src/lib/audio/schedule.ts`): a clip that fits in memory (about 5.5 minutes of stereo) is decoded and played by an AudioBufferSourceNode that starts at an exact context time and buffer position, clips that begin in the next 150 ms are started at the exact sample, and a voice is restarted only when it drifts more than 40 ms or its rate changes. A reversed clip reads a reversed copy of the buffer, the way the export does.
- Clip gain line and fade handles on the clip itself (`src/components/ClipSoundHandles.tsx`): on a selected audio clip, drag a handle at each top corner for the fade in and out (the equal power curve is drawn) and drag the line for the clip gain (snaps to 0 dB, shows dB while dragging, double-click resets). They write the same fields as the Audio tab.
- Take management (`src/lib/takes.ts`): every recording is a take in a group. With an audio clip selected, Record makes a new take of that clip and swaps the clip to it (kept inside the free space before the next clip), and the Audio tab lists the clip's takes: listen, mark good or bad, bring one back with Use, delete. The best take (newest marked good) is flagged.
- Linked selection toggle (Linked button on the timeline, Shift+L, and palette commands to link and unlink the selection): with it off, picture and sound move, trim, cut and delete on their own; the links are kept and come back when it is turned on.
- Tests: tests/worklet.test.ts, tests/schedule.test.ts, tests/audio-editing.test.ts.

Not checked: none of the live audio was run in a real browser (node has no Web Audio), so the worklet loading from a blob address, the send bus wiring, buffer playback and its drift handling are verified only through their pure parts. Differences to know about: a reversed clip at a speed other than 1 plays at that rate live, so its pitch follows the speed (the export keeps the pitch); clips longer than about 5.5 minutes, clips with speed ramps, nested and multicam clips still play through media elements (reverse is silent for the first two kinds, as before); a processor chain is rebuilt when a setting changes, which restarts reverb and delay tails.
