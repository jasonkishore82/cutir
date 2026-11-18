# Cutir: architecture review

A self-review of the codebase as it stands: what is solid, and what a reviewer would push back on.
Verdict: the direction is sound. Treat it as a prototype that works well, not a finished product.

## Snapshot

- About 6,300 lines across `src/` and `backend/app/`.
- Largest files: `Timeline.tsx` (860 lines), `ChatPanel.tsx` (370), `store/chat.ts` (350), `lib/exporter.ts` (340).
- Nine runtime dependencies: `react`, `react-dom`, `zustand`, `zod`, `wavesurfer.js`, `mediabunny`, `@ffmpeg/core`, `@ffmpeg/ffmpeg`, `@ffmpeg/util`.
- No automated tests, no lint script, no CI configuration.
- A handful of `any` casts (5), mostly at the tool-registry boundary.

## What works well

1. **One draw function.** The preview and the export both call `drawFrame` (`src/lib/renderer.ts`), so what you see is what you export. This is the best decision in the project.
2. **Clear layering.** UI components sit on stores (`project`, `chat`, `library`), which sit on `lib/` (renderer, exporter, tools, transport). Pure logic is kept out of React.
3. **Undo and redo built into the store.** Changes are grouped, so one AI reply or one drag is a single undo step.
4. **Tool registry.** Each AI tool is defined once (zod schema, description, apply function). The Ollama schemas, prompt text, validation and applying are all derived from that definition.
5. **Graceful fallbacks.** Fast export falls back to ffmpeg.wasm; models without tool support fall back to JSON replies; the backend is optional.
6. **Sensible security defaults.** The backend listens on `127.0.0.1` only, has a strict CORS rule, checks paths when serving files, and font names are validated before they are used.
7. **Small dependency surface.**

## What a reviewer would push back on

| # | Concern | Why it matters | Suggested fix |
|---|---|---|---|
| 1 | **No automated tests, lint or CI** | Everything was verified with throwaway scripts that are not in the repo. A regression would go unnoticed. | Vitest for the pure logic (tools, layers, subtitles, parsers, project store) plus one browser smoke test; add lint and a CI workflow. |
| 2 | **`Timeline.tsx` is 860 lines** | It mixes the waveform, drag handling, tap-sync, wheel handling, context menus and layer headers. | Split into components and hooks (layer header, lane, context menu, scroll/zoom hook, sync hook). |
| 3 | **Data lives only in the browser** | Projects are in localStorage and IndexedDB: no backup or sync, and clearing site data deletes them. The saved project format has no version number. | Add a `version` field and migrations; offer export/import of whole projects; consider a projects API on the backend. |
| 4 | **Cross-origin isolation requirement** | The compatibility export (ffmpeg.wasm) needs COOP/COEP headers, so any static host must send them. | Documented in the README; add a startup check that warns when the page is not isolated. |
| 5 | **Model compatibility is untested** | Tool calling depends on each Ollama model. One case already surfaced (qwen2.5-coder writes calls as text). | A small suite of fixed prompts with expected tool calls, run per model. |
| 6 | **Smaller points** | Module-level mutable state (clipboard, drag state); the undo history stores whole project copies (capped at 200); no crash reporting; backend has no tests and runs one alignment at a time behind a lock. | Address as the project grows. |

## Suggested order

1. Tests and CI (concern 1).
2. Split the timeline (concern 2).
3. Project format version and migrations (concern 3).
4. The rest as needed.

None of these needs a rewrite: the foundation is good enough to build on.
