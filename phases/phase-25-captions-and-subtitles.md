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

## Status (built)
Built (`src/lib/captions/` cues, checks, transcript, transcribe, translate, presets, ops; `src/components/CaptionsPanel.tsx` (the Captions tab); `src/lib/tools/captions.ts`; `backend/app/routers/transcribe.py`; tests in `tests/captions.test.ts`):
- Transcription: the local helper (Whisper through the aligner backend, new `/api/transcribe_stream`) or OpenAI and Groq from the AI settings (`verbose_json` with word times). The timeline's mix (or one track) is rendered to 16 kHz mono and sent. Language is detected or chosen; a vocabulary list goes to the model as a prompt and is also applied afterwards to near-miss spellings.
- Transcript panel: every word is clickable (seeks), shift-click selects a run, Delete cuts the words from picture, sound and every caption track (ripple), "Delete text only" keeps the time, double-click corrects a word, "Select range" sets In and Out and selects the clips there. Speaker names are set by hand on the selected words and survive in the project and in VTT, ASS and iTT.
- Fillers and pauses: a filler list (one- and two-word, with optional extras like "like" and "so") and pauses over a threshold that keep a set amount of silence; the words are marked in the transcript, "Preview" plays the video skipping them, "Remove all" cuts them in one undo step.
- Caption tracks: one subtitle track per language (language code per track), looks (Classic, Outlined, Yellow, Social bold, Minimal) sized so a full line fits the safe width (action 93%, title 90%, wide 80%), line length from the rules.
- Formats: import and export SRT, WebVTT, LRC, ASS and iTT/TTML, with timing kept exactly (LRC and ASS hold hundredths of a second); several files at once, language read from `name.es.srt`.
- Export: captions burned in, as soft WebVTT tracks in the MP4 (language tagged), or both; when the compatibility encoder is used (it cannot write subtitle tracks) the tracks are saved as .vtt files instead and the dialog says so.
- Checks: reading speed, shortest and longest time, overlaps, line count and line width against rule sets (broadcast, streaming, social, children's, or your own numbers), with Fix per problem and Fix all (re-wrap evenly, split at sentence ends, trim overlaps, borrow time from the gap).
- Translation: the configured AI provider translates in batches with context into a new track with the same timing; a side-by-side editor edits the translation against the source. A bad answer is retried in halves.
- Chat tools: `check_captions`, `fix_captions`, `caption_look`, `remove_fillers`.

Not built: automatic speaker detection (diarization), translation of cues that were retimed after translating (the editor matches by overlap), a safe-area overlay in the preview, and soft tracks from the compatibility encoder. Nothing here was run against a real recording, a real Whisper model, a cloud account or a real LLM; the parsing, timing, cutting, checks and request building are tested, the network calls and the panel are not exercised in a browser.
