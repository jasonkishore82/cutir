# Phase 5: Export, Polish and Docs

## MP4 export (`lib/exporter.ts`)
- Render every frame offscreen with the shared `drawFrame` at 1920x1080 / 1080x1920 / 1080x1080
- Feed frames to ffmpeg.wasm, mux the original audio, output H.264 MP4
- Progress bar and cancel button
- Risk: ffmpeg.wasm memory/speed on long songs. Consider spiking this early (after Phase 2)

## Other exports
- `.srt`
- `.ass` with karaoke tags

## Polish
- Empty states, large audio files, models without tool support
- Keyboard shortcut and undo/redo regression pass

## README
- Setup: `npm i`, `npm run dev`
- `ollama pull qwen3:8b`
- How to set `OLLAMA_ORIGINS` on Windows, Mac and Linux
- Note on COOP/COEP headers for ffmpeg.wasm

## Done when
- Exported MP4 plays with audio in sync and matches the preview
- Cancel works mid-export
- A fresh clone can be set up from the README alone
