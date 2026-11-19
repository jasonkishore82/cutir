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
