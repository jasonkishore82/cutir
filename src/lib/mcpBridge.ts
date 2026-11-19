import { create } from "zustand";
import { applyCalls, registry } from "./tools";
import { paramsSchema } from "./tools/registry";
import { lineWords, useProject, type LyricLine } from "../store/project";
import { useMedia } from "../store/media";
import { useLibrary } from "../store/library";
import { activeTimeline, IDS } from "../model/convert";
import { getTime, pause, play, seek, usePlayback } from "./transport";
import { ASPECT_SIZES, type MediaSource } from "./renderer";
import { ensureFont } from "./fonts";
import { needsAt, renderFrame } from "../render/compositor";
import { exactFrames } from "../render/sources";
import { downloadBlob, exportMp4, type ExportProgress } from "./exporter";
import { APP_TOOLS, DEFAULT_PORT, PROTOCOL_VERSION, type Content, type Reply, type ServerMessage, type ToolSpec } from "../mcp/protocol";

/**
 * Lets Claude (Claude Code or Claude Desktop, signed in with the user's own Claude account) edit the open project
 * through the Cutir MCP server in mcp/. Off until the user switches it on in Settings; then this tab connects to the
 * server on 127.0.0.1, proves the pairing code, and answers tool calls:
 *
 * - editing tools (src/lib/tools) run through applyCalls, exactly like the in-app chat: validated, one undo step each
 * - app tools (APP_TOOLS) read the project, render frames, control playback, undo/redo and export
 */

type Status = "off" | "connecting" | "connected" | "rejected" | "waiting";
type LogEntry = { at: number; name: string; ok: boolean; summary: string };
type Settings = { enabled: boolean; port: number; token: string };

const KEY = "cutir:mcp";
const readSettings = (): Settings => {
  try {
    return { enabled: false, port: DEFAULT_PORT, token: "", ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { enabled: false, port: DEFAULT_PORT, token: "" };
  }
};

type McpState = Settings & {
  status: Status;
  message: string;
  log: LogEntry[];
  exporting: { stage: string; fraction: number; done?: boolean; error?: string; file?: string } | null;
  set: (p: Partial<Settings>) => void;
};

export const useMcp = create<McpState>((set, get) => ({
  ...readSettings(),
  status: "off",
  message: "",
  log: [],
  exporting: null,
  set: (p) => {
    set(p);
    const { enabled, port, token } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled, port, token }));
    } catch {
      /* not remembered */
    }
    reconnect();
  },
}));

/** Editing tools from the registry, in MCP form. Every group is offered (Claude handles the full list). */
export function editingTools(): ToolSpec[] {
  return registry.list().map((t) => ({ name: t.name, description: t.hint ? `${t.description} (${t.hint})` : t.description, inputSchema: paramsSchema(t) }));
}

/* ---------- the connection ---------- */

let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;

function reconnect() {
  clearTimeout(retry);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  const { enabled, port, token } = useMcp.getState();
  if (!enabled) return useMcp.setState({ status: "off", message: "" });
  if (!token.trim()) return useMcp.setState({ status: "waiting", message: "Enter the pairing code the Cutir MCP server shows (ask Claude to run cutir_status)." });
  useMcp.setState({ status: "connecting", message: `Looking for the Cutir MCP server on port ${port}...` });
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    return schedule();
  }
  const sock = ws;
  sock.onopen = () => {
    attempt = 0;
    const project = useLibrary.getState().entries.find((e) => e.id === useLibrary.getState().currentId)?.name;
    sock.send(JSON.stringify({ type: "hello", token: token.trim(), app: "cutir", version: PROTOCOL_VERSION, project }));
  };
  sock.onmessage = (e) => void onMessage(sock, e.data);
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (useMcp.getState().status !== "rejected") schedule();
  };
}

function schedule() {
  const { enabled } = useMcp.getState();
  if (!enabled) return;
  attempt++;
  useMcp.setState({ status: "waiting", message: "Not connected. Start Claude Code or Claude Desktop with the Cutir plugin; this tab keeps trying." });
  retry = setTimeout(reconnect, Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)));
}

async function onMessage(sock: WebSocket, raw: unknown) {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if ("type" in msg && msg.type === "welcome") return useMcp.setState({ status: "connected", message: "Claude can edit this project." });
  if ("type" in msg && msg.type === "reject") {
    useMcp.setState({ status: "rejected", message: msg.reason });
    sock.close();
    return;
  }
  if (!("id" in msg)) return;
  let reply: Reply;
  try {
    const content = msg.type === "call" ? await callTool(msg.name, msg.args) : [{ type: "text" as const, text: JSON.stringify(await readResource(msg.uri), null, 1) }];
    reply = { id: msg.id, ok: true, content };
  } catch (e) {
    reply = { id: msg.id, ok: false, error: (e as Error).message || String(e) };
    if (msg.type === "call") log(msg.name, false, reply.error);
  }
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
}

function log(name: string, ok: boolean, summary: string) {
  useMcp.setState((s) => ({ log: [{ at: Date.now(), name, ok, summary }, ...s.log].slice(0, 50) }));
}

/** Start (or stop) the bridge from the saved settings. Called once when the editor starts. */
export function startMcpBridge() {
  reconnect();
}

/* ---------- tools ---------- */

const text = (t: string): Content[] => [{ type: "text", text: t }];

async function callTool(name: string, args: unknown): Promise<Content[]> {
  if (useLibrary.getState().screen !== "editor") throw new Error("No project is open in Cutir. Open one from the Home screen first.");
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

  if (registry.get(name)) {
    const { results } = await applyCalls([{ tool: name, args }]); // one undo step, same validation as the chat
    const r = results[0];
    log(name, r.ok, r.summary);
    if (!r.ok) throw new Error(r.summary);
    return text(r.summary);
  }

  switch (name) {
    case "get_project":
      return text(JSON.stringify(projectSummary(), null, 1));
    case "list_media":
      return text(JSON.stringify(mediaList(), null, 1));
    case "render_frame": {
      const t = typeof a.time === "number" ? a.time : getTime();
      const png = await renderPng(t, typeof a.width === "number" ? a.width : 960);
      log(name, true, `frame at ${t.toFixed(2)}s`);
      return [{ type: "image", data: png, mimeType: "image/png" }, ...text(`Frame at ${t.toFixed(2)}s`)];
    }
    case "seek":
      seek(Number(a.time) || 0);
      return text(`Playhead at ${getTime().toFixed(2)}s`);
    case "play":
      play();
      return text("Playing");
    case "pause":
      pause();
      return text(`Paused at ${getTime().toFixed(2)}s`);
    case "undo":
    case "redo": {
      const n = Math.max(1, Math.min(50, Number(a.steps) || 1));
      let done = 0;
      for (; done < n; done++) {
        const now = useProject.getState();
        if (!(name === "undo" ? now.past.length : now.future.length)) break;
        if (name === "undo") now.undo();
        else now.redo();
      }
      log(name, true, `${done} step(s)`);
      return text(done ? `${name === "undo" ? "Undid" : "Redid"} ${done} step(s)` : `Nothing to ${name}`);
    }
    case "import_media_url": {
      const url = String(a.url ?? "");
      if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
      const res = await fetch(url).catch(() => null);
      if (!res || !res.ok) throw new Error(`could not download ${url}${res ? ` (HTTP ${res.status})` : " (blocked by the site or offline)"}`);
      const blob = await res.blob();
      const fileName = String(a.name ?? "") || decodeURIComponent(new URL(url).pathname.split("/").pop() || "download");
      const items = await useMedia.getState().addFiles([new File([blob], fileName, { type: blob.type })]);
      if (!items.length) throw new Error(`${fileName} is not a supported media file`);
      log(name, true, `imported ${items[0].name}`);
      return text(`Imported ${items[0].name} (id ${items[0].id})`);
    }
    case "export_video":
      return text(startExport());
    case "export_status": {
      const x = useMcp.getState().exporting;
      return text(!x ? "No export has run." : x.error ? `Export failed: ${x.error}` : x.done ? `Done: ${x.file} downloaded in the browser.` : `${x.stage} (${Math.round(x.fraction * 100)}%)`);
    }
  }
  throw new Error(`unknown tool ${name}`);
}

/* ---------- reading the project ---------- */

function projectSummary() {
  const { doc, project, selectedIds } = useProject.getState();
  const tl = activeTimeline(doc);
  const layerName = new Map(project.layers.map((l) => [l.id, l.name]));
  return {
    name: useLibrary.getState().entries.find((e) => e.id === useLibrary.getState().currentId)?.name,
    aspect: project.aspect,
    fps: project.fps,
    duration: usePlayback.getState().duration,
    playhead: Number(getTime().toFixed(3)),
    song: project.audio?.name ?? null,
    background: project.background.type === "gradient" ? { gradient: project.background.colors } : { file: project.background.asset?.name ?? null },
    layers: project.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked })),
    lines: project.lines.slice(0, 300).map((l, i) => ({
      index: i + 1,
      layer: layerName.get(l.layerId ?? "") ?? "",
      start: l.start,
      end: l.end,
      text: l.text,
      ...(l.keyframes ? { keyframes: l.keyframes.length } : {}),
      ...(l.styleOverride?.animation?.beat ? { beat: l.styleOverride.animation.beat } : {}),
      ...(l.styleOverride?.energy !== undefined ? { energy: l.styleOverride.energy } : {}),
      ...wordsOf(l),
    })),
    moreLines: Math.max(0, project.lines.length - 300),
    selectedLines: selectedIds,
    tracks: tl.tracks.filter((t) => t.kind !== "subtitle").map((t) => ({ id: t.id, name: t.name, kind: t.kind, muted: t.muted, solo: t.solo, locked: t.locked, hidden: t.hidden, target: !!t.target })),
    clips: tl.clips
      .filter((c) => !c.fill && !c.text)
      .map((c) => ({
        id: c.id,
        track: tl.tracks.find((t) => t.id === c.trackId)?.name,
        media: doc.media.find((m) => m.id === c.mediaId)?.name,
        start: c.start,
        end: Number((c.start + c.duration).toFixed(4)),
        sourceIn: c.sourceIn,
        speed: c.speed,
        ...(c.linkId ? { linked: c.linkId } : {}),
        ...(c.transform ? { transform: c.transform } : {}),
        ...(c.volume !== undefined ? { volume: c.volume } : {}),
        ...(c.enabled ? {} : { enabled: false }),
      })),
    markers: tl.markers.filter((m) => m.kind !== "beat").map((m) => ({ time: m.time, name: m.name, ...(m.clipId ? { clip: m.clipId } : {}) })),
    beats: beatSummary(),
    beatReaction: project.style.animation.beat ?? null,
    energy: project.style.energy ?? 0,
    range: tl.inPoint !== undefined || tl.outPoint !== undefined ? { in: tl.inPoint, out: tl.outPoint } : null,
    media: mediaList(),
  };
}

/** A line's word overrides (non-empty ones), 1-based like the word tools: emphasis levels and what else is set. */
function wordsOf(l: LyricLine): { emphasis?: Record<string, number>; words?: Record<string, unknown>[] } {
  const all = lineWords(l.text);
  const entries = Object.entries(l.wordOverrides ?? {}).filter(([, o]) => o && Object.keys(o).length);
  if (!entries.length) return {};
  const emphasis: Record<string, number> = {};
  const words: Record<string, unknown>[] = [];
  for (const [k, o] of entries) {
    const n = Number(k) + 1;
    if (o.emphasis) emphasis[`${n} ${all[Number(k)] ?? ""}`.trim()] = o.emphasis;
    const { emphasis: _e, keyframes, ...rest } = o;
    void _e;
    if (Object.keys(rest).length || keyframes?.length) words.push({ word: n, text: all[Number(k)], ...rest, ...(keyframes?.length ? { keyframes: keyframes.length } : {}) });
  }
  return { ...(Object.keys(emphasis).length ? { emphasis } : {}), ...(words.length ? { words } : {}) };
}

/** Beat count, tempo and where they came from; null before detect_beats. */
function beatSummary() {
  const { doc, project } = useProject.getState();
  if (!project.beats?.length) return null;
  const song = doc.media.find((m) => m.id === activeTimeline(doc).clips.find((c) => c.id === IDS.audioClip)?.mediaId);
  const a = song?.analysis;
  return {
    count: project.beats.length,
    downbeats: project.beats.filter((b) => b.downbeat).length,
    first: project.beats[0].time,
    last: project.beats[project.beats.length - 1].time,
    ...(a ? { tempo: Math.round(a.tempo * 10) / 10, beatsPerBar: a.beatsPerBar, source: a.source } : {}),
  };
}

function mediaList() {
  const { items, status } = useMedia.getState();
  return items.map((i) => ({ id: i.id, name: i.name, kind: i.kind, duration: i.duration, size: i.width ? `${i.width}x${i.height}` : undefined, fps: i.fps, status: status[i.id] ?? "ok", ...(i.note ? { note: i.note } : {}) }));
}

async function readResource(uri: string): Promise<unknown> {
  const { doc, project } = useProject.getState();
  const s = projectSummary();
  switch (uri) {
    case "cutir://project/summary":
      return { ...s, lines: undefined, clips: undefined, media: undefined, lineCount: project.lines.length, clipCount: s.clips.length, mediaCount: s.media.length };
    case "cutir://project/lines":
      return s.lines;
    case "cutir://project/style":
      return project.style;
    case "cutir://timeline/active": {
      const tl = activeTimeline(doc);
      return { tracks: tl.tracks, clips: tl.clips.filter((c) => !c.text), markers: tl.markers, inPoint: tl.inPoint, outPoint: tl.outPoint };
    }
    case "cutir://media":
      return s.media;
  }
  throw new Error(`unknown resource ${uri}`);
}

/* ---------- frames and export ---------- */

async function renderPng(t: number, width: number): Promise<string> {
  const { doc, project } = useProject.getState();
  const full = ASPECT_SIZES[project.aspect];
  const w = Math.round(Math.min(1280, Math.max(160, width)));
  const h = Math.round((w * full.h) / full.w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  await ensureFont(project.style.fontFamily, project.lines.map((l) => l.text).join(" ")).catch(() => undefined);
  let bg: MediaSource | undefined;
  const asset = project.background.type === "asset" ? project.background.asset : undefined;
  if (asset?.url) bg = asset.kind === "video" ? await videoAt(asset.url, t) : await imageOf(asset.url);
  const frames = exactFrames();
  await frames.prepare(needsAt(doc, t));
  renderFrame(ctx, doc, project, t, w, h, { bg }, frames);
  return canvas.toDataURL("image/png").split(",")[1];
}

const imageOf = (url: string) =>
  new Promise<HTMLImageElement | undefined>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = url;
  });

const videoAt = (url: string, t: number) =>
  new Promise<HTMLVideoElement | undefined>((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.onloadeddata = () => {
      v.onseeked = () => resolve(v);
      v.currentTime = v.duration > 0 ? t % v.duration : 0;
    };
    v.onerror = () => resolve(undefined);
    v.src = url;
  });

let exportAbort: AbortController | null = null;

function startExport(): string {
  const cur = useMcp.getState().exporting;
  if (cur && !cur.done && !cur.error) return `An export is already running: ${cur.stage} (${Math.round(cur.fraction * 100)}%)`;
  const duration = usePlayback.getState().duration;
  if (!(duration > 0)) throw new Error("Nothing to export yet: add a song, lyrics or clips first.");
  const project = useProject.getState().project;
  const name = (useLibrary.getState().entries.find((e) => e.id === useLibrary.getState().currentId)?.name ?? "cutir").replace(/[^\w\- ]+/g, "").trim() || "cutir";
  exportAbort = new AbortController();
  useMcp.setState({ exporting: { stage: "Starting", fraction: 0 } });
  void exportMp4(project, { duration, signal: exportAbort.signal, onProgress: (p: ExportProgress) => useMcp.setState({ exporting: { stage: p.stage, fraction: p.fraction } }) })
    .then((blob) => {
      downloadBlob(blob, `${name}.mp4`);
      useMcp.setState({ exporting: { stage: "Done", fraction: 1, done: true, file: `${name}.mp4` } });
      log("export_video", true, `${name}.mp4`);
    })
    .catch((e) => useMcp.setState({ exporting: { stage: "Failed", fraction: 0, error: (e as Error).message } }));
  return `Export started (${duration.toFixed(1)}s of video). Use export_status to follow it.`;
}

/** Every tool Claude gets: editing tools from the registry plus the app tools. */
export const allTools = (): ToolSpec[] => [...editingTools(), ...APP_TOOLS];
