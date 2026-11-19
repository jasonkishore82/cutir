# Phase 11: Project Model v2 and Migration

Reference: Resolve keeps one project that holds a media pool, many timelines and project-wide settings. Cutir's project is currently one song plus lyric lines.

## Data model (`store/project.ts`)
- `Project { version, settings, media[], bins[], timelines[], activeTimelineId }`
- `settings`: resolution, frame rate, aspect, colour space, audio sample rate (today these are scattered fields)
- `MediaRef { id, name, kind: video | audio | image | subtitle, fileKey, duration, width, height, fps, hasAudio }`
- `Timeline { id, name, tracks[], markers[], inPoint?, outPoint? }`
- `Track { id, kind: video | audio | subtitle, name, muted, locked, solo, height }`
- `Clip { id, mediaId, trackId, start, duration, sourceIn, sourceOut, speed, enabled, effects[], keyframes{} }`
- Lyric lines become subtitle-track clips with a `text` payload, so lyric editing is one use of the general model

## Migration
- `schemaVersion` on every saved project; one migration function per version step
- Open any project saved by phases 1 to 10 and convert it: audio becomes an audio clip, the background becomes a video or image clip, lines become subtitle clips, layers become subtitle tracks
- Keep a read-only backup of the old JSON the first time a project is migrated

## Store
- Selectors per timeline so the UI re-renders only for the parts it shows
- All edits go through one `applyOperation(op)` that records an inverse operation for undo (replaces whole-project snapshots)
- Operations are plain data so they can later be sent to workers, replayed and synced

## Tests
- Unit tests for migration (every old fixture opens, round-trips and renders identically)
- Unit tests for operations and their inverses

## Done when
- Every project from phases 1 to 10 opens, looks the same and exports the same file
- A timeline can hold several video, audio and subtitle tracks in the data model, even before the UI shows them
- Undo and redo use operations, not full copies
