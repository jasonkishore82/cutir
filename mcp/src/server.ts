import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, type WebSocket } from "ws";
import { registry } from "../../src/lib/tools";
import { paramsSchema } from "../../src/lib/tools/registry";
import { APP_TOOLS, DEFAULT_PORT, PROTOCOL_VERSION, RESOURCES, SERVER_TOOLS, type Content, type Hello, type Reply, type ToolSpec } from "../../src/mcp/protocol";
import { ANIMATION_DOC, VERSION } from "./generated";

/**
 * Cutir MCP server.
 *
 * Claude (Claude Code, Claude Desktop) starts this as a local stdio MCP server. It opens a WebSocket on 127.0.0.1
 * and waits for a Cutir tab that has "Claude control" switched on and sends the right pairing code. Every tool call
 * and resource read is forwarded to that tab, which applies it exactly like its own chat does (one undo step each).
 *
 * The tool list is built here from the same registry the app uses, so it is available before the tab connects.
 * stdout carries the MCP protocol: logs go to stderr only.
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg("port") ?? process.env.CUTIR_MCP_PORT ?? DEFAULT_PORT);
const log = (...a: unknown[]) => console.error("[cutir-mcp]", ...a);

/* ---------- pairing code: kept between runs so the tab only needs it once ---------- */

function pairingCode(): string {
  if (process.env.CUTIR_MCP_TOKEN) return process.env.CUTIR_MCP_TOKEN.trim().toUpperCase();
  const dir = arg("data") || process.env.CLAUDE_PLUGIN_DATA || join(process.env.APPDATA || join(homedir(), ".config"), "cutir-mcp");
  const file = join(dir, "pairing-code");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  } catch {
    /* first run */
  }
  const ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
  const code = Array.from({ length: 6 }, () => ABC[randomInt(ABC.length)]).join("");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, code, { mode: 0o600 });
  } catch (e) {
    log("could not save the pairing code:", (e as Error).message);
  }
  return code;
}
const CODE = pairingCode();

/** Pages allowed to connect: local Cutir (any port) plus any listed in --origin / CUTIR_MCP_ORIGINS. */
const extraOrigins = (arg("origin") ?? process.env.CUTIR_MCP_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const originOk = (o: string | undefined) => !o || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o) || extraOrigins.includes(o);

/* ---------- the bridge to the tab ---------- */

let tab: { ws: WebSocket; project?: string } | null = null;
let portError = "";
let nextId = 1;
const pending = new Map<number, { resolve: (r: Reply) => void; timer: NodeJS.Timeout }>();

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port,
  maxPayload: 32 * 1024 * 1024,
  verifyClient: ({ origin }: { origin?: string }) => originOk(origin),
});
wss.on("listening", () => log(`waiting for Cutir on ws://127.0.0.1:${port}  pairing code ${CODE}`));
wss.on("error", (e: NodeJS.ErrnoException) => {
  portError = e.code === "EADDRINUSE" ? `port ${port} is already in use (another Cutir MCP server may be running; close it or start this one with --port)` : e.message;
  log("websocket server error:", portError);
});
wss.on("connection", (ws) => {
  let hello = false;
  const timeout = setTimeout(() => !hello && ws.close(), 10000);
  ws.on("message", (data) => {
    let msg: Hello | Reply;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!hello) {
      const h = msg as Hello;
      if (h.type !== "hello" || h.app !== "cutir") return ws.close();
      if (h.token?.trim().toUpperCase() !== CODE) {
        ws.send(JSON.stringify({ type: "reject", reason: "Wrong pairing code. Ask Claude to run cutir_status to see the right one." }));
        return ws.close();
      }
      if (h.version !== PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ type: "reject", reason: `This Cutir speaks bridge version ${h.version}; the plugin speaks ${PROTOCOL_VERSION}. Update the one that is older.` }));
        return ws.close();
      }
      hello = true;
      clearTimeout(timeout);
      if (tab && tab.ws !== ws) tab.ws.close(); // the newest tab wins
      tab = { ws, project: h.project };
      ws.send(JSON.stringify({ type: "welcome" }));
      log(`Cutir connected${h.project ? ` (${h.project})` : ""}`);
      return;
    }
    const r = msg as Reply;
    const p = pending.get(r.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(r.id);
      p.resolve(r);
    }
  });
  ws.on("close", () => {
    clearTimeout(timeout);
    if (tab?.ws === ws) {
      tab = null;
      log("Cutir disconnected");
    }
  });
});

const notConnected = () =>
  `Cutir is not connected. In the Cutir editor open Settings > AI models > "Claude control (MCP)", switch on "Let Claude control this editor", enter the pairing code ${CODE} (port ${port}).` +
  (portError ? ` Problem: ${portError}.` : "");

function ask(msg: { type: "call"; name: string; args: unknown } | { type: "read"; uri: string }, timeoutMs = 120000): Promise<Reply> {
  if (!tab) return Promise.resolve({ id: 0, ok: false, error: notConnected() });
  const id = nextId++;
  const ws = tab.ws;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, ok: false, error: "Cutir did not answer in time (is the tab still open?)." });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, ...msg }));
  });
}

/* ---------- MCP ---------- */

const editing: ToolSpec[] = registry.list().map((t) => ({ name: t.name, description: t.hint ? `${t.description} (${t.hint})` : t.description, inputSchema: paramsSchema(t) }));
const TOOLS = [...SERVER_TOOLS, ...APP_TOOLS, ...editing];

const server = new Server(
  { name: "cutir", version: VERSION },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions:
      "Cutir is a lyric video and video editor running in the user's browser. Call get_project first to see the project (lines, tracks, clips, media). " +
      "Make one change per tool call; each call is one undo step for the user. Lyric lines are 1-based indexes; clips are referred to by id. " +
      "Use render_frame to look at the result before saying you are done. If a tool says Cutir is not connected, tell the user the pairing steps from cutir_status.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "cutir_status") {
    const text = tab
      ? `Connected to Cutir${tab.project ? ` (project "${tab.project}")` : ""} on port ${port}. Pairing code ${CODE}.`
      : notConnected();
    return { content: [{ type: "text", text }] };
  }
  if (!TOOLS.some((t) => t.name === name)) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
  const r = await ask({ type: "call", name, args: args ?? {} });
  if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
  return { content: r.content as Content[] };
});

const DOC_URI = "cutir://docs/animation";
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [...RESOURCES, { uri: DOC_URI, name: "Animation guide", description: "Effects, transitions, keyframes and how they combine", mimeType: "text/markdown" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  if (uri === DOC_URI) return { contents: [{ uri, mimeType: "text/markdown", text: ANIMATION_DOC }] };
  const r = await ask({ type: "read", uri });
  if (!r.ok) throw new Error(r.error);
  const first = r.content[0];
  return { contents: [{ uri, mimeType: "application/json", text: first && first.type === "text" ? first.text : "" }] };
});

const PROMPTS = [
  {
    name: "lyric_video",
    description: "Build a lyric video in Cutir from the song and lyrics in the project",
    arguments: [{ name: "style", description: "The look you want, e.g. 'neon, energetic' or 'calm karaoke'", required: false }],
    text: (a: Record<string, string>) =>
      `Make a lyric video in Cutir. Steps: 1) get_project to see the song, lyrics and media. 2) If lines are not timed, run auto_sync. ` +
      `3) Pick a template that fits${a.style ? ` "${a.style}"` : " the song"} with apply_template, then adjust with update_style and set_animation_in/out. ` +
      `4) Add transitions with set_transition. 5) render_frame at three points (start, a chorus, the end) and fix anything hard to read. ` +
      `6) Tell me what you did; do not export unless I ask.`,
  },
  {
    name: "restyle",
    description: "Restyle the lyrics to a mood",
    arguments: [{ name: "mood", description: "e.g. cinematic, playful, dark", required: true }],
    text: (a: Record<string, string>) => `Restyle the lyrics in Cutir to feel ${a.mood ?? "different"}: font, colour, outline, shadow, animation and transitions. Check with render_frame before and after.`,
  },
  {
    name: "fix_timing",
    description: "Check the lyric timing and fix problems",
    arguments: [],
    text: () =>
      "Read the lyric lines with get_project. Find overlaps between lines on the same layer, lines shorter than 0.6 s, gaps over 3 s inside a verse and lines that run past the song. Propose fixes, then apply them with update_line / shift_timings.",
  },
];

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS.map(({ name, description, arguments: a }) => ({ name, description, arguments: a })) }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = PROMPTS.find((x) => x.name === req.params.name);
  if (!p) throw new Error(`Unknown prompt ${req.params.name}`);
  return { messages: [{ role: "user", content: { type: "text", text: p.text((req.params.arguments ?? {}) as Record<string, string>) } }] };
});

await server.connect(new StdioServerTransport());
log(`Cutir MCP server ${VERSION} ready (${TOOLS.length} tools)`);

const stop = () => {
  wss.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdin.on("close", stop);
