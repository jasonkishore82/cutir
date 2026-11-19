# Phase 12: Media Pool and Import

Reference: In Resolve every page shares one Media Pool. Files come in by drag and drop or the Import Media menu, and import is reachable from any page.

## Media pool panel
- Grid and list views with thumbnails, name, type, duration, resolution, frame rate
- Bins (folders) with drag to move, rename, delete, and smart bins (all video, all audio, unused clips)
- Search and filter by type, bin and used or unused
- Context menu: import, rename, reveal in timeline, relink, generate proxy, remove

## Import paths
- Drag files or folders from the desktop onto the pool, the timeline or the viewer
- File menu and pool context menu: Import media
- Paste from clipboard; import project interchange files (phase 29)
- Accepted: mp4, mov, webm, mkv where WebCodecs can decode; mp3, wav, m4a, ogg, flac; png, jpg, webp, gif; srt, vtt, lrc, ass; ttf, otf, woff2

## Storage
- Files are stored in the Origin Private File System, not as base64 in localStorage; the project keeps only a `fileKey`
- Optional File System Access API link to the original file so large media is not duplicated; fall back to copying into OPFS
- Relink dialog when a linked file is missing or moved

## Probing and previews
- Probe with mediabunny in a worker: container, codecs, duration, size, frame rate, audio channels
- Generate thumbnails (filmstrip every N seconds) and waveform peaks once, cache them in OPFS
- Unsupported codec: import the file, mark it as needing a transcode, and explain what is possible

## Drag to timeline
- Dragging a clip from the pool to a track creates a timeline clip with a ghost preview and snapping (phase 13)

## Done when
- Dropping ten mixed files imports them without freezing the UI
- Reopening a project restores every asset, or offers relink for missing ones
- A 2 GB video imports without loading it into memory
