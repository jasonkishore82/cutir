# Phase 28: AI Assistant Across the Editor

Reference: The chat already edits lyric projects through tools. With a full timeline, the same pattern can drive any edit.

## Tool registry
- Tools for every editor operation from phases 11 to 27: add clip, trim, ripple delete, add effect, set keyframe, colour grade, add track, export
- Tools are generated from the command registry and param specs so they stay in sync with the UI
- Group routing by topic, as in phase 10, so small models see only relevant tools

## Selection context
- The prompt includes the selected clips, the playhead position, the visible range and a compact timeline summary, not the whole project

## Smart actions
- Remove silences, remove filler words, auto-cut to the beat, find and mark moments from a transcript, suggest a title, summarise a video
- Scene detection with markers, and auto reframe to 9:16
- Generate captions and translations through the same providers as AI settings

## Safety
- Every AI edit is one undoable step with an applied-changes card showing what changed
- Destructive actions (delete, replace media, overwrite export) ask first
- Keys and project content leave the browser only to the provider the user chose, and a visible log lists every request

## Macros
- Record a sequence of commands and replay it as a macro; share macros as JSON

## Done when
- "Remove all pauses longer than half a second" works on a real interview
- "Make the second clip slow motion with a smooth ramp" works
- Every AI edit can be undone in one step

## Status

Built: the assistant now covers the timeline. Tools (all defined once in `src/lib/tools/`, as undoable single-step edits): `remove_silences` (finds pauses from the sound itself, no transcript needed), `cut_to_beats`, `find_moments` (word match on the captions, one marker per moment), `detect_scenes` (frame differences sampled from the video, one marker per cut), `generate_captions`, `translate_captions` (through the provider chosen in AI settings), `export_video` (queues a render with a preset) and `run_command`, which runs the view, page, tool and playback commands from the command registry so new commands reach the assistant without a change. Existing tools already cover add, trim, ripple delete, effects, keyframes, track and speed edits, and `make_version` does the 9:16 auto reframe. Routing: two new groups (`smart`, `ui`) chosen by words in the request, as in phase 10, so small models see only what matters. Prompt: the selected clips, the playhead, the visible range, in and out points, markers and a short clip list (nearest the view first, at most 24 besides the selection), plus the transcript when the request is about summaries, titles or finding moments. Safety: every reply is one undo step with the applied-changes card; deleting, cutting out and exporting wait for Apply or Cancel (Settings, Assistant can turn this off); a request log (Settings, Assistant) lists every call to an AI provider with its host and size, never the text or the key. Macros: record commands and assistant edits, play them back (a run of tool steps is one undo step), edit, export and import as JSON, play from the palette. Tests in `tests/ai.test.ts`.

Not done: "suggest a title" and "summarise a video" are answered by the model from the transcript in the prompt, there is no dedicated tool or button; remove filler words still needs a transcript, while silences do not; scene detection samples at most every quarter second and only on video clips already opened this session; auto-cut to the beat cuts at beats and does not choose the best shots; `find_moments` matches words, not meaning; the request log covers chat, translation and cloud speech to text but not the local Python helper; a macro that records a command acts on whatever is selected when it is played; "overwrite export" has no meaning in a browser download, so export only asks before queueing. Not yet checked in a real browser or against a real interview: type-check, build and unit tests pass, but decoding, frame sampling and the model calls were not exercised.
