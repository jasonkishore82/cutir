# Cutir MCP Server and Claude Code Plugin

Lets Claude (Claude Code, including the VS Code extension, and Claude Desktop), signed in with your own Claude
account, edit the project open in Cutir through the Model Context Protocol.

**Status: live mode built (phase 15.5).** Source: `mcp/` (server), `src/lib/mcpBridge.ts` (the tab side),
`src/mcp/protocol.ts` (shared), `src/lib/tools/timeline.ts` (timeline tools), `plugin/` (the Claude Code plugin),
`.claude-plugin/marketplace.json` (so the repo installs as a plugin marketplace). File mode is not built yet.

## Quick start

1. **Install the plugin in Claude Code** (once):
   ```bash
   # from this repository on disk
   claude plugin marketplace add "D:/path/to/Cutir"
   # or, once the plugin is on the repository's default branch on GitHub
   claude plugin marketplace add <owner>/<repo>

   claude plugin install cutir@cutir
   ```
   To try it without installing: `claude --plugin-dir ./plugin`.
2. **Get the pairing code:** in Claude Code ask "connect to Cutir" (the `connect` skill runs `cutir_status`), or run
   `/cutir:connect`. The code is a 6-character word like `M25JZ8`; it stays the same between sessions.
3. **Switch it on in Cutir:** open a project, then **Settings > AI models > Claude control (MCP)**, tick
   **Let Claude control this editor** and type the code. A green **Claude connected** badge appears in the top bar.
4. Ask Claude: "make a lyric video in a neon style", or run `/cutir:lyric-video neon`.

Every change Claude makes is one undo step (Ctrl+Z) and is listed in the Claude control card's log. Click the badge to
disconnect.

**Claude Desktop** (no plugin system there): add the bundled server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cutir": { "command": "node", "args": ["D:/path/to/Cutir/plugin/server/cutir-mcp.mjs"] }
  }
}
```

Then ask Claude "what is my Cutir pairing code?" and continue from step 3. (Needs Node 18 or newer on the PATH.)

**Rebuilding the server** after changing tools: `cd mcp && npm install && npm run build` (writes
`plugin/server/cutir-mcp.mjs`), then `npm test` in `mcp/` runs the end-to-end test (a real MCP client and a fake
Cutir tab). The bundled file is committed so the plugin works without a build step.

**Options:** `--port <n>` or `CUTIR_MCP_PORT` (default 8790, must match Cutir's setting), `CUTIR_MCP_TOKEN` to set the
pairing code yourself, `--origin` / `CUTIR_MCP_ORIGINS` to allow a Cutir hosted somewhere other than localhost.

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

### Timeline tools (also in the in-app chat)

Defined with `defineTool` in `src/lib/tools/timeline.ts` (group `timeline`), working on the whole document
(`applyDoc`). The in-app chat offers them when a message mentions clips, tracks, video, audio, trims and so on, and
its prompt then lists the clip ids, tracks and library.

| Tool | Does | Uses |
|---|---|---|
| `add_clip` | Put a library item (by name or id) on a track; `mode` overwrite, insert, append or top; source `in` / `out` | `overwriteEdit`, `insertEdit`, `appendEdit`, `placeOnTop` |
| `trim_clip` | Trim an edge `by` seconds or `to` a time; `ripple` | `trimEdge` |
| `move_clips` | Move clips `by` / `to`, optionally to another track | `moveClips` |
| `cut_at` | Blade at a time | `blade` |
| `delete_clips` | Delete, optionally ripple | `deleteClips`, `rippleDelete` |
| `set_clip` | Position, size, rotation, opacity, blend, fit; volume; enabled | clip `transform`, `volume` |
| `add_track` / `set_track` | Add a track; rename, mute, solo, lock, hide, target | `addTrack`, `setTrack`, `setTarget` |
| `add_marker` / `set_range` | Markers and in / out | `addMarker`, `setRange` |

Without a marked target track, clips go on the top-most plain video track and the first plain audio track (never
the lyric background or song track).

### App tools (MCP only)

Answered by the tab in `src/lib/mcpBridge.ts`; listed in `APP_TOOLS` in `src/mcp/protocol.ts`.

| Tool | Does |
|---|---|
| `get_project` | Everything Claude needs first: aspect, fps, duration, playhead, lines, layers, tracks, clips, markers, range, library, selection |
| `list_media` | The media library with ids, kinds, durations, status |
| `render_frame` | PNG of the frame at a time, exactly as it exports (returned as an MCP image) |
| `seek` / `play` / `pause` | The playhead |
| `undo` / `redo` | History, by steps |
| `import_media_url` | Download a file into the library (the site must allow it) |
| `export_video` / `export_status` | Start an MP4 export (downloads in the browser) and follow it |
| `cutir_status` | Answered by the server itself: connected or not, the pairing code and port |

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

## Packaging as a plugin

The same server can ship in two installable packages, so nobody has to edit config files by hand. Both wrap the one
server in `mcp/`; only the packaging differs. (Check the exact manifest fields against the current Claude Code and
Claude Desktop docs when building: both formats are still evolving.)

### Claude Code plugin (built)

A plugin bundles the MCP server with skills that know how to use Cutir well.

```
plugin/
  .claude-plugin/plugin.json      name "cutir", version, description
  .mcp.json                       node ${CLAUDE_PLUGIN_ROOT}/server/cutir-mcp.mjs --data ${CLAUDE_PLUGIN_DATA}
  server/cutir-mcp.mjs            the server, SDK and Cutir tool definitions in one file (built by mcp/build.mjs)
  skills/
    connect/SKILL.md              /cutir:connect - status and pairing steps
    lyric-video/SKILL.md          /cutir:lyric-video [style] - sync, template, motion, transitions, check frames
    timeline-editing/SKILL.md     /cutir:timeline-editing - clips, tracks, trims, markers
    kinetic-pass/SKILL.md         /cutir:kinetic-pass - emphasis, meaning-matched motion, keyframes
.claude-plugin/marketplace.json   at the repo root: marketplace "cutir" listing ./plugin
```

- The pairing code lives in the plugin's persistent data folder (`${CLAUDE_PLUGIN_DATA}`), so it survives updates.
- Both manifests pass `claude plugin validate`.
- The skills are what make it more than a bare MCP server: they teach Claude the order that works (sync before
  styling, check frames with `render_frame`, one change per call) and the vocabulary (templates, effects, transitions).
- Useful during development too: Claude Code working on this repo can load the plugin and test the editor through it.

### Claude Desktop extension (later)

A one-click install for Claude Desktop: the server and a `manifest.json` packed into an MCP Bundle (`.mcpb`, made
with `npx @anthropic-ai/mcpb init` and `mcpb pack`). Users double-click it and Claude Desktop runs the bundled Node
server; no Node install or JSON editing needed. Anthropic's Desktop extension directory no longer takes submissions,
so the bundle would be shared directly (or shipped inside the plugin).

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
| 15.5 (done) | Live mode with the lyric tools, timeline tools, resources, `render_frame`, pairing; Claude Code plugin with four skills |
| 16 to 27 | Each phase adds its operations as tools, so Claude can use them as they land (effects, colour, audio...) |
| 28 | Tools generated from the command registry; selection-context resource; macros callable from Claude |
| 29 | File mode over the new project packages; OpenTimelineIO import and export as tools |
| 30 | Documented as part of the public command API, permissions per tool, listed in the developer docs |
| 30 (release) | Claude Desktop extension, once the tool set is stable enough for non-developers |

If something more urgent comes first, the latest sensible point is **phase 28**, where it becomes the outside door to
the same command registry the in-app assistant uses.
