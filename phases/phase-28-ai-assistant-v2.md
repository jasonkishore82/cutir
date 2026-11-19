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
