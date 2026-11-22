# Browser support and fallbacks

Cutir checks the browser at start and shows a message when something is missing. The same list is in **Settings > Plugins and system > This browser**.

| Feature | Need | Without it |
| --- | --- | --- |
| Web Workers, IndexedDB | required | Cutir cannot run |
| WebCodecs (video) | required | Video cannot be decoded or exported |
| WebGL 2 | recommended | Effects use the slower canvas path; plugin effects pass the picture through |
| Origin private file system | recommended | Media is kept in IndexedDB: works, slower for large files |
| OffscreenCanvas | recommended | Thumbnails and waveforms draw on the page |
| Cross-origin isolation | recommended | Multi-threaded ffmpeg is unavailable (the app is served with the headers it needs) |
| WebCodecs (audio) | recommended | Slower audio encoder, fewer readable audio formats |
| File System Access | optional | Normal file dialogs; saves go to Downloads |
| WebGPU | optional | Not used yet |
| Service workers | optional | No install or offline use |

Targets: current Chrome and Edge (full support), current Safari (no File System Access), current Firefox (availability of WebCodecs varies by version; the check names exactly what is missing).

## Release smoke test (manual, in each browser)

1. Open Cutir, import a video and a song, edit on the timeline, play with sound.
2. Add an effect, a transition and a title; undo and redo.
3. Close the tab while editing; reopen: the project is back.
4. Export to MP4 and play the file.
5. Install the starter plugin, use its effect, remove it.
6. Install as an app, go offline, reload.

## Automated checks

`npm test` runs the unit and integration tests and the benchmarks in `tests/perf.test.ts` (reference projects of 400 and 3,000 clips; a case fails when it is far over its time budget). CI runs the type check, the tests and the build on every push.
