// End-to-end test of the bundled server: a real MCP client (as Claude would) plus a fake Cutir tab over WebSocket.
// Run: npm test (in mcp/), after npm run build.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 18790 + Math.floor(Math.random() * 500);
const CODE = "TEST42";
let fails = 0;
const check = (name, ok, got) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, "..", "plugin", "server", "cutir-mcp.mjs"), "--port", String(PORT)],
  env: { ...process.env, CUTIR_MCP_TOKEN: CODE },
  stderr: "pipe",
});
const client = new Client({ name: "test", version: "1" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
check(`lists tools before the editor connects (${tools.length})`, tools.length > 40 && ["cutir_status", "get_project", "render_frame", "add_line", "apply_template", "add_clip", "trim_clip"].every((n) => names.includes(n)));
check("tool schemas are JSON Schema objects", tools.every((t) => t.inputSchema && t.inputSchema.type === "object"));
check("the alias set_animation is not offered", !names.includes("set_animation"));

const st = await client.callTool({ name: "cutir_status", arguments: {} });
check("cutir_status explains how to connect, with the code", st.content[0].text.includes(CODE) && st.content[0].text.includes(String(PORT)));
const off = await client.callTool({ name: "get_project", arguments: {} });
check("calls before connecting say how to connect", off.isError && off.content[0].text.includes("not connected"));

// a tab with the wrong code is turned away
const bad = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "http://localhost:5173" });
const badMsg = await new Promise((r) => {
  bad.on("open", () => bad.send(JSON.stringify({ type: "hello", token: "NOPE", app: "cutir", version: 1 })));
  bad.on("message", (d) => r(JSON.parse(String(d))));
});
check("wrong pairing code is rejected", badMsg.type === "reject");

// a web page from another site cannot connect at all
const evil = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "https://evil.example" });
const evilResult = await new Promise((r) => {
  evil.on("open", () => r("open"));
  evil.on("error", () => r("refused"));
  evil.on("unexpected-response", () => r("refused"));
});
check("other websites are refused", evilResult === "refused", evilResult);

// the real tab
const seen = [];
const tab = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "http://localhost:5173" });
await new Promise((r) => tab.on("open", r));
tab.send(JSON.stringify({ type: "hello", token: CODE.toLowerCase(), app: "cutir", version: 1, project: "Demo" }));
tab.on("message", (d) => {
  const m = JSON.parse(String(d));
  if (m.type === "welcome") return seen.push("welcome");
  seen.push(m);
  let reply;
  if (m.type === "call" && m.name === "add_line") reply = { id: m.id, ok: true, content: [{ type: "text", text: `line 1 added: ${m.args.text}` }] };
  else if (m.type === "call" && m.name === "render_frame") reply = { id: m.id, ok: true, content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] };
  else if (m.type === "call") reply = { id: m.id, ok: false, error: "line 9 does not exist" };
  else reply = { id: m.id, ok: true, content: [{ type: "text", text: JSON.stringify({ lines: [] }) }] };
  tab.send(JSON.stringify(reply));
});
await wait(150);
check("the right code (any case) is welcomed", seen[0] === "welcome");

const status = await client.callTool({ name: "cutir_status", arguments: {} });
check("status shows the connected project", status.content[0].text.includes("Connected") && status.content[0].text.includes("Demo"));
const added = await client.callTool({ name: "add_line", arguments: { text: "hello world", start: 1 } });
check("tool calls are forwarded to the tab and answered", !added.isError && added.content[0].text === "line 1 added: hello world");
check("the tab got the name and arguments", seen.some((m) => m.name === "add_line" && m.args.text === "hello world"));
const frame = await client.callTool({ name: "render_frame", arguments: { time: 2 } });
check("images come back as MCP image content", frame.content[0].type === "image" && frame.content[0].mimeType === "image/png");
const err = await client.callTool({ name: "update_line", arguments: { index: 9, text: "x" } });
check("tab errors come back as tool errors", err.isError && err.content[0].text.includes("does not exist"));
const unknown = await client.callTool({ name: "rm_rf", arguments: {} });
check("unknown tools are refused by the server", unknown.isError);

const res = await client.listResources();
check("resources are listed", res.resources.some((r) => r.uri === "cutir://project/lines") && res.resources.some((r) => r.uri === "cutir://docs/animation"));
const doc = await client.readResource({ uri: "cutir://docs/animation" });
check("the animation guide is served without the editor", doc.contents[0].text.includes("Animation in Cutir"));
const lines = await client.readResource({ uri: "cutir://project/lines" });
check("project resources are read from the tab", lines.contents[0].text.includes("lines"));

const prompts = await client.listPrompts();
check("prompts are offered", prompts.prompts.some((p) => p.name === "lyric_video"));
const p = await client.getPrompt({ name: "restyle", arguments: { mood: "cinematic" } });
check("prompts fill in their arguments", p.messages[0].content.text.includes("cinematic"));

// a second tab replaces the first
const tab2 = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "http://127.0.0.1:8765" });
await new Promise((r) => tab2.on("open", r));
const closed = new Promise((r) => tab.on("close", r));
tab2.send(JSON.stringify({ type: "hello", token: CODE, app: "cutir", version: 1, project: "Second" }));
await closed;
check("the newest tab takes over", true);
tab2.close();
await wait(100);
const gone = await client.callTool({ name: "get_project", arguments: {} });
check("after the tab closes, calls say how to reconnect", gone.isError && gone.content[0].text.includes("not connected"));

await client.close();
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
