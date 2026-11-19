# Cutir MCP Server (design)

A plan for letting Claude (Claude Desktop, Claude Code, claude.ai with a local connector) edit Cutir projects through
the Model Context Protocol. Status: **design only, not built yet.** The last section says when to build it.

## Why

Cutir's in-app assistant already edits projects through tools (`src/lib/tools/`), and every edit is an undoable
operation (`src/model/ops.ts`). An MCP server exposes the same tools to Claude, so you can:

- ask Claude Desktop "sync these lyrics, use the Karaoke template and crossfade every line" while the editor is open
- let Claude Code drive the editor while developing Cutir (open a test project, make edits, grab a frame, check it)
- run batch jobs over saved projects ("apply Bold Caption to every project in this folder")

No new editing logic is needed: the server is a bridge to code that already exists and is tested.

## Two modes

| | Live mode (build first) | File mode (later) |
|---|---|---|
| Edits | The project open in your browser tab | Project `.json` files on disk |
| You see changes | Immediately, in the editor | When you open the project |
| Undo | Each tool call is one undo step in the editor | Keeps the original file (writes a new version) |
| Preview frames, export | Yes (the tab renders them) | No (needs a browser) |
| Needs the browser open | Yes | No |

## Architecture (live mode)

```
Claude Desktop / Claude Code
        │  MCP over stdio (JSON-RPC)
        ▼
mcp/cutir-mcp  (Node, @modelcontextprotocol/sdk)
        │  WebSocket on 127.0.0.1:<port>, pairing token
        ▼
Cutir tab: src/lib/mcpBridge.ts
        │
        ├─ applyCalls()        src/lib/tools/index.ts    (validate, apply as ONE undo step, report)
        ├─ editTimeline()      src/timeline/ui.ts        (timeline engine edits)
        ├─ renderFrame()       src/render/compositor.ts  (PNG of a frame)
        └─ store snapshots     src/store/project.ts      (resources)
```

### The server (`mcp/`)

- A small Node package, separate from the web app: `mcp/package.json`, `mcp/src/server.ts`, built to `mcp/dist/`.
- Uses the official TypeScript SDK (`@modelcontextprotocol/sdk`) with the stdio transport, so Claude starts it as a
  local process.
- Opens a WebSocket server on `127.0.0.1` only (never `0.0.0.0`) and waits for a Cutir tab to connect.
- Does not edit anything itself: it forwards each tool call to the tab and returns the tab's answer.
- Tool definitions come from the app (see "Tools"), so the server needs no changes when tools are added.

### The bridge in the app (`src/lib/mcpBridge.ts`)

- Off by default. Settings > AI models gets a card **"Let Claude control this editor (MCP)"** with an on/off switch,
  the port, the pairing code and a list of recent calls.
- When on, the tab connects to `ws://127.0.0.1:<port>` and sends a `hello` with the pairing token and the tool list.
- Handles four message types: `listTools`, `callTools`, `readResource`, `renderFrame`.
- Every `callTools` message runs through `applyCalls`, the same function the chat uses: one undo step, an
  "applied changes" card in the chat panel marked *via Claude (MCP)*, and the same validation and error messages.
- A visible badge in the top bar while connected ("Claude connected"), with a disconnect button.

### Messages (WebSocket, JSON)

```jsonc
// tab -> server, on connect
{ "type": "hello", "token": "…", "app": "cutir", "version": "0.1.0", "tools": [ /* MCP tool definitions */ ] }

// server -> tab
{ "id": 7, "type": "callTools", "calls": [{ "tool": "move_text", "args": { "index": 3, "place": "top-left" } }] }

// tab -> server
{ "id": 7, "ok": true, "results": [{ "tool": "move_text", "ok": true, "summary": "line 3 moved to top-left" }] }
```

## Tools

### Generated from the registry

Every tool in `src/lib/tools/` is offered as an MCP tool with the same name, description and JSON schema
(`paramsSchema()` already turns the zod schemas into JSON Schema for Ollama and the cloud providers). Today that is:

| Group | Tools |
|---|---|
| Style | `update_style`, `set_font`, `set_animation_in`, `set_animation_out`, `set_animation_loop` |
| Lines | `add_line`, `update_line`, `delete_line`, `move_line`, `shift_timings`, `split_line`, `merge_lines` |
| Layers | `add_layer`, `update_layer`, `delete_layer` |
| Scene | `set_background`, `set_aspect` |
| Sync | `auto_sync` |
| Placement | `move_text`, `scale_text`, `rotate_text` |
| Motion | `add_keyframe`, `clear_keyframes`, `set_transition`, `apply_template` |

Unlike small local models, Claude can handle the full list, so MCP sends every group (no keyword routing).
`set_animation` stays hidden (it is an alias).

### Added for MCP (timeline and app)

These wrap code that already exists (phases 12 to 15):

| Tool | Does | Uses |
|---|---|---|
| `get_project_summary` | Aspect, fps, duration, counts, selection, playhead | store |
| `list_media` | Media library items with ids, kinds, durations, status | `useMedia` |
| `import_media_by_url` | Fetch a file from a URL the user gives and import it | `addFiles` |
| `add_clip` | Put a library item on a track at a time (overwrite) | `overwriteEdit` |
| `insert_clip` / `append_clip` | Insert or append a library item | `insertEdit`, `appendEdit` |
| `trim_clip` | Trim an edge, normal or ripple | `trimEdge` |
| `move_clips` | Move clips in time and across tracks | `moveClips` |
| `cut_at` | Blade at a time | `blade` |
| `delete_clips` | Delete, optionally ripple | `deleteClips`, `rippleDelete` |
| `add_track` / `set_track` | Add a track, lock, mute, solo, hide | `addTrack`, `setTrack` |
| `add_marker` / `set_range` | Markers and in / out | `addMarker`, `setRange` |
| `set_clip_transform` | Position, size, rotation, opacity, blend of a clip | clip `transform` |
| `seek` / `play` / `pause` | Move or run the playhead | `transport.ts` |
| `undo` / `redo` | Step through history | store |
| `render_frame` | PNG of the frame at a time (returned as an MCP image) | `renderFrame` |
| `export_video` | Start an MP4 export and report progress; the file downloads in the browser | `exportMp4` |

Each one is a `defineTool` entry in a new group file (`src/lib/tools/timeline.ts`), so the in-app chat gets them
too.

## Resources

Read-only context Claude can pull without spending tool calls:

| URI | Content |
|---|---|
| `cutir://project/summary` | Short JSON: aspect, fps, duration, counts, playhead, selection |
| `cutir://project/lines` | Every lyric line: index, layer, start, end, text, overrides in short form |
| `cutir://project/style` | The project text style |
| `cutir://timeline/active` | Tracks and clips of the active timeline (ids, times, media, transforms) |
| `cutir://media` | The media library |
| `cutir://docs/animation` | `docs/ANIMATION.md` (effects and how they combine) |

Large projects are summarised (first 200 lines, then counts) to keep context small.

## Prompts

MCP prompts (templates the user can pick in Claude):

- **Make a lyric video**: walks Claude through song, lyrics, sync, template, transitions, export
- **Restyle as…**: apply a template and adjust it to a described mood
- **Fix the timing**: check lines for overlaps, gaps and too-fast lines and propose edits
- **Kinetic pass**: the ideas from `docs/KINETIC-TYPOGRAPHY.md` that exist so far

## Safety and privacy

- **Opt in per tab**: nothing listens until the switch is on; turning it off closes the socket.
- **Localhost only**: the server binds to `127.0.0.1`; the tab only connects to `127.0.0.1`.
- **Pairing**: the server prints a short pairing code (also passed through an env var); the tab must send it, so other
  pages and programs on the machine cannot drive the editor.
- **Origin check**: the server only accepts the Cutir origin(s) it was configured for.
- **Undo everything**: each call is one undo step with an applied-changes card; destructive calls (delete project,
  remove media, overwrite export) are not offered, or ask in the tab first.
- **No content leaves the machine** through the bridge itself; whatever Claude reads is sent to Anthropic by the
  Claude app, as with any MCP server, which the settings card says plainly.
- **Rate and size limits**: at most N calls per second, resource bodies capped, frames capped at 1280 px wide.

## Setup (once built)

Claude Code:

```bash
cd mcp && npm install && npm run build
claude mcp add cutir -- node /path/to/Cutir/mcp/dist/server.js --port 8790
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cutir": { "command": "node", "args": ["C:/path/to/Cutir/mcp/dist/server.js", "--port", "8790"] }
  }
}
```

Then in Cutir: Settings > AI models > **Let Claude control this editor**, enter the pairing code the server printed
(Claude Desktop shows it in the server log), and ask Claude to "list the lines of my project".

## Packaging as a plugin

The same server can ship in two installable packages, so nobody has to edit config files by hand. Both wrap the one
server in `mcp/`; only the packaging differs. (Check the exact manifest fields against the current Claude Code and
Claude Desktop docs when building: both formats are still evolving.)

### Claude Code plugin

A plugin bundles the MCP server with skills and slash commands that know how to use Cutir well.

```
cutir-plugin/
  .claude-plugin/
    plugin.json            name "cutir", description, version, author
  .mcp.json                starts the server: node ${CLAUDE_PLUGIN_ROOT}/server/server.js --port 8790
  server/                  the built MCP server (mcp/dist), bundled into one file
  skills/
    lyric-video/SKILL.md   how to make a lyric video with Cutir's tools, step by step
    kinetic/SKILL.md       the kinetic typography pass (docs/KINETIC-TYPOGRAPHY.md)
    timeline-editing/SKILL.md  trims, ripple, insert/overwrite with source marks
  commands/
    cutir-status.md        /cutir-status: is the editor connected, what is open
    lyric-video.md         /lyric-video <song>: guided build from song + lyrics to export
    restyle.md             /restyle <mood>: template + adjustments
```

- Install: add the repo as a plugin marketplace (`.claude-plugin/marketplace.json` at the repo root listing the
  plugin), then `/plugin install cutir@<marketplace>`.
- The skills are what make it more than a bare MCP server: they teach Claude the order that works (sync before
  styling, check frames with `render_frame`, one change per call) and the vocabulary (templates, effects, transitions).
- Useful during development too: Claude Code working on this repo can load the plugin and test the editor through it.

### Claude Desktop extension

A one-click install for Claude Desktop: the server and a `manifest.json` (name, description, entry point, a
configurable port) packed into a single extension file with Anthropic's MCP bundle tool. Users double-click it,
Claude Desktop installs it and runs the bundled Node server; no Node install or JSON editing needed.

### What the user does

1. Install the plugin (Claude Code) or the extension (Claude Desktop).
2. In Cutir: Settings > AI models > **Let Claude control this editor**, enter the pairing code.
3. Ask Claude, or run `/lyric-video`.

## File mode (later)

Same server, started with `--files <folder>`: tools load a project JSON with `loadDoc` (any schema version), apply
calls to the lyric view with the same tool `apply` functions (they are pure), and write the result with
`serializeDoc` next to the original (`name.cutir-edit.json`) unless told to overwrite. Rendering and export are not
available in this mode. Because `src/model` and `src/lib/tools` are pure TypeScript, the server can import them
directly (bundled with rolldown, like `npm test` does).

## Implementation plan

1. `src/lib/tools/timeline.ts`: the timeline tools from the table above (also useful to the in-app chat).
2. `src/lib/mcpBridge.ts`: socket client, message handling, `render_frame` via an offscreen canvas.
3. Settings card, connection badge, call log.
4. `mcp/`: Node server with the SDK, stdio transport, WebSocket bridge, pairing, tool and resource forwarding.
5. File mode (`--files`).
6. Tests: tool schemas round-trip into MCP definitions; a fake socket drives the bridge (`callTools` gives one undo
   step and the right summaries); the server is tested with the SDK's in-memory client transport.
7. `docs/MCP.md` setup section updated with real commands and screenshots.
8. Packaging: the Claude Code plugin (manifest, `.mcp.json`, skills, commands, marketplace file) and the Claude
   Desktop extension, both built from `mcp/` by one script (`npm run package` in `mcp/`).

Size: steps 1 to 4 are about the size of one phase; steps 5 and 8 are small.

## When to build it

**Build a first version now, between phase 15 and phase 16, then grow it in phase 28 and finish it in phase 30.**

Why now (after phase 15):

- Everything it bridges to exists: the tool registry and zod schemas (phase 10), operations with one-step undo
  (phase 11), the media pool and timeline engine (phases 12 to 14) and the compositor for `render_frame` (phase 15).
- It speeds up the rest of the roadmap: Claude Code can open a test project, make edits and look at rendered frames,
  which helps test phases 16 to 27, much of which (effects, colour, audio mixing) is hard to check in unit tests.
- It is small and self-contained: a new folder plus one app module, no changes to existing behaviour, off by default.

Why not wait for phase 28 (AI assistant across the editor):

- Phase 28 makes a command registry the single source for every editor operation and generates AI tools from it.
  The MCP server should read tool definitions from that registry, so it automatically grows with it. Building v1 now
  costs little extra because it already reads the current tool registry; in phase 28 it simply starts reading the
  new one.

How it continues:

| Phase | MCP work |
|---|---|
| Now (15.5) | Live mode with the lyric tools, timeline tools, resources, `render_frame`, pairing; Claude Code plugin with the first skills |
| 16 to 27 | Each phase adds its operations as tools, so Claude can use them as they land (effects, colour, audio...) |
| 28 | Tools generated from the command registry; selection-context resource; macros callable from Claude |
| 29 | File mode over the new project packages; OpenTimelineIO import and export as tools |
| 30 | Documented as part of the public command API, permissions per tool, listed in the developer docs |
| 30 (release) | Claude Desktop extension, once the tool set is stable enough for non-developers |

If something more urgent comes first, the latest sensible point is **phase 28**, where it becomes the outside door to
the same command registry the in-app assistant uses.
