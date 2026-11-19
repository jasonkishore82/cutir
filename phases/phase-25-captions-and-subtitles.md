# Phase 25: Captions and Subtitles

Reference: Lyric sync already exists. This phase makes it a general transcription and subtitle system for any spoken content.

## Transcription
- Speech to text with a local model (the aligner helper or a WASM model) and with the cloud providers set up in AI settings
- Word-level timing, speaker labels, language detection, custom vocabulary

## Transcript editing
- Transcript panel linked to the timeline; select text to select the clip range; delete text to delete video and audio
- Remove filler words and pauses in one pass with a preview

## Subtitle tracks
- Multiple subtitle tracks, one per language; style presets for caption looks; safe area and maximum line length rules
- Import and export SRT, VTT, LRC, ASS and iTT; burned-in or soft tracks at export
- Translation using the configured AI provider, with a side-by-side editor

## Checks
- Reading speed (characters per second), minimum duration, overlap and line count warnings with one-click fixes

## Done when
- A 10 minute interview is transcribed, edited by deleting text and exported with captions
- Subtitles import and export round trip without losing timing
- Translation produces a second subtitle track the user can edit
