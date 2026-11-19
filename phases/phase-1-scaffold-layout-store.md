# Phase 1: Scaffold, Layout and Store

## Scaffold
- Vite + React 18 + TypeScript
- Tailwind CSS (dark, editor-style theme)
- Zustand, zod, wavesurfer.js
- Folders: `/components`, `/lib`, `/store`
- Configure COOP/COEP headers in the Vite dev server (needed later for ffmpeg.wasm multi-threading)

## Layout
- 3 columns + bottom timeline (200px)
- Left panel (280px): Project & Assets
- Center: Preview
- Right panel (360px, collapsible): AI Chat
- Components: `LeftPanel`, `Preview`, `Timeline`, `ChatPanel`

## Store (`store/project.ts`)
- Types: `LyricLine`, `Project`, `TextStyle`, `Background`, `AssetRef`
- Undo/redo history with support for grouping several changes into one step (an AI reply = one undo)
- Save/load project as JSON (download), localStorage autosave wrapped in try/catch

## LeftPanel controls wired to the store
- Audio upload (mp3/wav/m4a)
- Background: image/video upload or gradient preset
- Lyrics textarea (one line per row)
- Style: font, size, color, uppercase, letter spacing, line height, max chars per line, shadow, outline, position, animation
- Aspect ratio: 16:9, 9:16, 1:1

## Done when
- `npm run dev` shows the full layout
- Edits update the store, and undo/redo works
- Project survives a reload via autosave
