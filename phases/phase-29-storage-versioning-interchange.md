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
