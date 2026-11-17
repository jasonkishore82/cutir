# Phase 4: Ollama Chat with Tool Calls

## Ollama client (`lib/ollama.ts`)
- URL field (default http://localhost:11434) + connection status dot
- Model dropdown from `GET /api/tags`, with refresh button
- `POST /api/chat` with `stream: true`, parse NDJSON for streaming text
- Clear failure message: "Start Ollama with OLLAMA_ORIGINS=* (or your dev URL) so the browser can reach it."

## Tools (`lib/tools.ts`)
- `update_style(patch)`
- `update_line(id_or_index, { text?, start?, end? })`
- `shift_timings(from_index, to_index, seconds)`
- `split_line(index, at_word)` / `merge_lines(index_a, index_b)`
- `set_background(...)` (gradient or asset)
- `set_animation(name, durationMs)`
- `set_aspect(ratio)`
- zod validation for every call; invalid args rejected with the error shown in chat

## Prompting
- Compact system prompt: tool list, current style JSON, lines as `index | start-end | text`
- Prefer tool calls over prose, one edit per call (target is a small 8B model)
- Fallback for models without tool support: reply with a ```json block `{ "actions": [ { "tool", "args" } ] }` and parse it

## ChatPanel
- Chat history with streaming responses
- All tool calls from one reply applied as a single undoable history step
- "Applied changes" card per AI edit, with an Undo button

## Done when
- "Shift line 4 by 0.5s", "make the font bigger" and "pink-to-orange gradient" work with qwen3:8b
- Connection failures and invalid tool args are handled gracefully
