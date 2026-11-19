/**
 * The bridge between the Cutir MCP server (mcp/) and the Cutir tab (src/lib/mcpBridge.ts).
 * Shared by both sides; plain types and data only, so the Node server can import it.
 *
 *   tab -> server   { type: "hello", token, app, version }
 *   server -> tab   { type: "welcome" } | { type: "reject", reason }
 *   server -> tab   { id, type: "call", name, args }        a tool call
 *   server -> tab   { id, type: "read", uri }               a resource read
 *   tab -> server   { id, ok, content } | { id, ok: false, error }
 */

export const DEFAULT_PORT = 8790;
export const PROTOCOL_VERSION = 1;

export type Hello = { type: "hello"; token: string; app: "cutir"; version: number; project?: string };
export type ServerMessage =
  | { type: "welcome" }
  | { type: "reject"; reason: string }
  | { id: number; type: "call"; name: string; args: unknown }
  | { id: number; type: "read"; uri: string };

/** MCP content: text, or an image (base64 PNG). */
export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type Reply = { id: number; ok: true; content: Content[] } | { id: number; ok: false; error: string };

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required });

/**
 * Tools answered by the app itself (not editing tools from the registry): reading the project, looking at frames,
 * playback, history and export. Editing tools come from src/lib/tools (the same ones the in-app chat uses).
 */
export const APP_TOOLS: ToolSpec[] = [
  {
    name: "get_project",
    description:
      "Summary of the project open in Cutir: aspect, frame rate, duration, playhead, lyric lines (index, layer, times, text), the timeline's tracks and clips with ids, markers, in/out, the media library and what is selected. Read this first.",
    inputSchema: obj(),
  },
  { name: "list_media", description: "Files in the Cutir media library: id, name, kind, duration, size, status.", inputSchema: obj() },
  {
    name: "render_frame",
    description: "Render the frame at a time (seconds; default: the playhead) exactly as it will export, and return it as a PNG so you can check the result.",
    inputSchema: obj({ time: { type: "number", minimum: 0 }, width: { type: "number", minimum: 160, maximum: 1280, description: "pixels, default 960" } }),
  },
  { name: "seek", description: "Move the playhead to a time in seconds.", inputSchema: obj({ time: { type: "number", minimum: 0 } }, ["time"]) },
  { name: "play", description: "Start playback in the editor.", inputSchema: obj() },
  { name: "pause", description: "Stop playback.", inputSchema: obj() },
  { name: "undo", description: "Undo the last edit (each tool call is one step).", inputSchema: obj({ steps: { type: "number", minimum: 1, maximum: 50 } }) },
  { name: "redo", description: "Redo an undone edit.", inputSchema: obj({ steps: { type: "number", minimum: 1, maximum: 50 } }) },
  {
    name: "import_media_url",
    description: "Download a file from a URL into the media library (the site must allow downloads from other sites).",
    inputSchema: obj({ url: { type: "string" }, name: { type: "string" } }, ["url"]),
  },
  {
    name: "export_video",
    description: "Start exporting the project to MP4 in the editor. The file downloads in the browser when done. Check progress with export_status.",
    inputSchema: obj(),
  },
  { name: "export_status", description: "Progress of the running or last export.", inputSchema: obj() },
];

/** Answered by the server alone, even when no tab is connected. */
export const SERVER_TOOLS: ToolSpec[] = [
  {
    name: "cutir_status",
    description: "Whether the Cutir editor is connected, and how to connect it (port and pairing code to enter in Cutir: Settings > AI models > Claude control).",
    inputSchema: obj(),
  },
];

export const RESOURCES = [
  { uri: "cutir://project/summary", name: "Project summary", description: "Aspect, fps, duration, counts, playhead, selection", mimeType: "application/json" },
  { uri: "cutir://project/lines", name: "Lyric lines", description: "Every lyric line: index, layer, start, end, text", mimeType: "application/json" },
  { uri: "cutir://project/style", name: "Text style", description: "The project's base text style and animation", mimeType: "application/json" },
  { uri: "cutir://timeline/active", name: "Timeline", description: "Tracks and clips of the active timeline", mimeType: "application/json" },
  { uri: "cutir://media", name: "Media library", description: "Files in the media library", mimeType: "application/json" },
] as const;
