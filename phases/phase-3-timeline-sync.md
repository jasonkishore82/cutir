# Phase 3: Timeline and Tap-Sync

## Timeline component
- wavesurfer.js waveform of the song
- One draggable/resizable block per lyric line (start/end), snapping to 0.05s
- Selection of a line, linked with the preview and lyrics list
- Playhead synced with audio

## Tap to sync
- Play the song; Space sets the start of the next line sequentially
- Enter sets the end of the current line
- Visual indicator of the current line being synced

## Keyboard shortcuts
- Space: play/pause (outside sync mode)
- Ctrl+Z / Ctrl+Shift+Z: undo/redo
- Left/Right arrows: nudge selected line by 0.05s

## Import
- `.lrc` and `.srt` import into lyric lines

## Done when
- A full song can be synced by tapping
- Blocks can be dragged and resized with snapping
- All timeline edits are undoable
