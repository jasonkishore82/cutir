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

## Status (partly built)
Built (`src/lib/audio/`, `src/render/audio.ts`, `src/components/AudioPanel.tsx`, tests in `tests/audio.test.ts`):
- Pure DSP shared by the export, the loudness measure and the tests: RBJ biquads (parametric EQ with low shelf, two peaking bands and high shelf, high pass, low pass), compressor with soft knee, limiter, gate, de-esser, noise reduction (a floor-following expander), reverb, delay.
- Loudness after BS.1770: integrated LUFS with both gates, short-term and momentary maxima, loudness range, true peak (4x oversampled). Targets for YouTube (-14), podcast (-16) and broadcast (-23), and "Match target", which renders the mix, sets the master gain and a peak ceiling.
- Mixer: a strip per audio track (gain, pan, reverb send, group, processors, meter with peak hold and clip light) and a master strip (gain, peak limiter, processors). The viewer routes the song and every clip through Web Audio strips with meters; EQ, filters, compressor and limiter are heard live. Track gain and pan automation lanes (keyframes at the playhead; edited as ordinary keyframes), and clip volume automation from phase 18.
- Export mix: each track is rendered on its own, run through its processors, then summed with gain, pan, sends and the master (`mixTracks`).
- Clip tools: fade in and out (equal power, also live), reverse (export and loudness only), clip gain, normalize to a peak, silence detection with a preview strip and "cut them out" (ripple, linked tracks follow).
- Voice-over: microphone recording with a count-in, placed on the audio target at the playhead; every take is kept in the media pool.
- Chat tools: `set_track_mix`, `set_master`, `set_audio_clip`.

Not built yet: gate, de-esser, noise reduction, reverb and delay are not heard live (export and loudness only; the live mixer maps only the Web Audio native nodes); reverse is not heard live; the reverb send bus is export only; a waveform view with fade handles and a gain line on the clip itself; sample-accurate AudioWorklet scheduling (clips still play through media elements and are nudged to the clock); take management beyond the media pool; linked and unlinked toggle for video and audio.
