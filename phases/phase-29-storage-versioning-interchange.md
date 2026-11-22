# Phase 29: Storage, Versioning, Interchange and Collaboration

Reference: Professional work needs reliable saves, version history and ways to move projects in and out of other tools.

## Storage
- Projects stored in OPFS with an index in IndexedDB; autosave with crash recovery and integrity checks
- Storage manager showing usage per project and per asset, with cleanup
- Export and import a project package (zip with project file and media) for backup and moving machines

## Versions
- Automatic snapshots every N minutes and on major actions; named versions; compare and restore
- Duplicate timeline as a lightweight branch

## Interchange
- Import and export OpenTimelineIO, EDL (CMX 3600), FCPXML and AAF-lite where practical, so edits can move to and from Resolve, Premiere and Final Cut
- Import SRT, VTT and LRC as today; export stems and still frames
- Mapping report listing anything that did not translate

## Optional sync and collaboration
- Pluggable sync backend interface; the app stays fully functional offline and without any server
- Reference implementation: a small self-hostable service with accounts, project sync and review links
- Review mode: shareable link with comments pinned to timecode, resolved states and a changes list
- Conflict handling by operation log merge (phase 11 operations)

## Done when
- A project survives a browser crash with at most a few seconds of lost work
- A timeline round trips through OpenTimelineIO to another editor and back
- Without any backend configured nothing about the app changes


## Status

Built and covered by `tests/interchange.test.ts` (run with `node tests/run.mjs interchange`). Not yet tried in a real browser, with a real 2 GB file, or in Resolve, Premiere or Final Cut, so the phase is not marked done.

**Storage**
- Every save writes a checksum with the project, and a second copy to the file store a few seconds later (`src/lib/storage/recovery.ts`). On open, a save that does not parse or fails its checksum is replaced by the recovery copy, and a recovery copy newer than the save (the last write never landed) wins. The damaged data is kept, and a notice says what happened.
- Settings, Project data: browser usage, usage of the open project by kind and by media item, removal of files no item owns, and a request that the browser keeps the data.
- Project package (`.cutirpack.zip`): project, media pool, bins and every media file, written without loading the media into memory. Opening it verifies every file's CRC and names damaged ones. Limit: no zip64, so no single file over 4 GB.

**Versions**
- Automatic snapshots every 2, 5, 10 or 30 minutes (or never) when something changed, and the state before a big change (5 or more clips removed, 8 or more added, a timeline or media removed). Named versions are never pruned; 40 automatic ones are kept.
- Compare a version with the project as it is now (clips added, removed, moved, changed, markers, tracks, media, settings), and restore it as one undo step; the current state is saved first.
- Branch the active timeline (the existing timeline duplicate).

**Interchange**
- Export OpenTimelineIO, EDL (CMX 3600) and FCPXML 1.9; import OpenTimelineIO and EDL as a new timeline. Every export and import ends with a mapping report of what did not translate (text clips, generated clips, effects, transitions, multicam, nested timelines, extra video tracks in an EDL, drop frame).
- OTIO written by Cutir keeps each clip in metadata, so effects and keyframes survive a round trip through Cutir; another editor sees cuts, speed, gaps and markers.
- Files that are not in the project come in as offline media and are relinked by name when imported.

**Sync and review (optional)**
- `SyncBackend` interface with an HTTP client and an in-memory version. With nothing configured no code runs. The reference service is `sync-server/server.mjs` (plain Node, JSON files, accounts by token, no dependencies).
- Operation log merge: a client rebases its own changes onto what others pushed, translating array indexes through item ids. An edit to something deleted by the other side is dropped and reported; two edits to the same value keep ours and report it.
- Review: a link that opens a page with the changes list and a comment form; comments are pinned to a time, can be resolved, and show in Settings with a jump to that time.

**Not done, or different from the plan**
- FCPXML and AAF import, and AAF export.
- Stems and still frame export.
- Reviewers get no video from the server: they open the file from their own computer. The page cannot yet draw comments on the timeline.
- Sync is manual (Sync now), and after a reload a project reconnects by taking the server's version (the state before is kept as a version). Conflicts are reported, not resolved by a dialog. Media files are not synced.
- Projects are still stored as JSON in local storage with the recovery copy beside them; moving the project data itself into OPFS with an IndexedDB index was not done.
