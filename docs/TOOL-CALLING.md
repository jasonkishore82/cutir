# Tool calling in Cutir

Cutir does not use a tool-calling framework. It has its own small registry in `src/lib/tools/`.

## How it works today

- Each tool is defined once with `defineTool({...})`: a zod parameter schema, a description, an optional input-repair step, an optional async `prepare` step (for example downloading a font), and a pure `apply` function.
- From that single definition, Cutir derives:
  - the JSON schema sent to Ollama (`toOllamaTool`),
  - the one-line signature in the system prompt (`toolSignature`),
  - validation and application (`applyCalls` in `src/lib/tools/index.ts`).
- All calls from one AI reply are applied as one undoable history step.
- Tools are grouped (style, lines, layers, scene, sync, transform, motion, timeline, kinetic) so only relevant ones are sent per request.
- The kinetic group (`src/lib/tools/kinetic.ts`, phase 16.5) covers single words and beats: `set_word_style`, `emphasize_words`, `auto_emphasis`, `set_beat_reaction`, `set_energy`, `snap_to_beats`, `detect_beats`. It is offered when a message mentions beats, pulse, flash, shake, drums, emphasis, energy, kinetic or words, and the prompt then adds a line saying whether beats exist (and the tempo) and which words carry emphasis. Words are numbered from 1 within a line or named by their text. `detect_beats` analyses in `prepare` and writes in `applyDoc`, so it stays one undo step.
- Replies where a model writes its tool call as text (`{"name": ..., "arguments": ...}`, `<tool_call>` tags, and similar) are recognised and run.

To add a tool: write one `defineTool` in the right group file and add it to that file's export.

## Frameworks that could be used instead

| Framework | Language | What it would give | Fit for Cutir |
|---|---|---|---|
| Vercel AI SDK | TypeScript | zod tools, streaming, multi-step tool loops, Ollama provider | Best fit if one is wanted; the tools are already zod. |
| Ollama official JS library | TypeScript | Thin client for `/api/chat`, streaming, tools | Would replace only `src/lib/ollama.ts`. |
| LangChain / LangGraph | TypeScript or Python | Agents, memory, graphs of steps | Overkill for this app. |
| PydanticAI (or LangChain) | Python | Typed tools and an agent loop | Only if tool calling moved to the Python backend. |
| MCP (Model Context Protocol) | Any | A standard way to expose tools to other AI apps | Useful if Claude Desktop or other clients should control Cutir. |

## Recommendation

Stay with the custom registry for now:

- Cutir's tools change the project and must be undoable, which frameworks do not handle for you.
- Switching has a real cost: everything would need re-testing against Ollama.
- Frameworks mostly pay off for multi-step agent loops (call a tool, read the result, decide the next step), which Cutir does not have.

If the AI should later plan several steps and check its own work, add the Vercel AI SDK on top of the existing zod tools; the tool definitions would not need rewriting. If other apps should be able to edit Cutir projects, add an MCP server on the backend.
