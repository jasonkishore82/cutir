import { handleCall, MAX_CALLS, type ScriptHost } from "./api";

/**
 * Run a script in a worker (phase 30). The worker has no page: no DOM, no storage of the app. The usual ways out to
 * the network are removed before the script starts, and the script is cut off after `timeoutMs`. Scripts and plugins
 * are still code: install only ones you trust.
 */

export const WORKER_SOURCE = `
const blocked = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel", "SharedWorker", "Worker", "WebTransport"];
self.onmessage = async (e) => {
  const code = e.data.code;
  let n = 0;
  const pending = new Map();
  const call = (method, ...args) => new Promise((res, rej) => { const id = ++n; pending.set(id, { res, rej }); postMessage({ type: "call", id, method, args }); });
  self.onmessage = (m) => { const d = m.data; const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.error ? p.rej(new Error(d.error)) : p.res(d.result); };
  const cutir = { commands: () => call("commands"), run: (id) => call("run", id), tools: () => call("tools"), tool: (name, args) => call("tool", name, args), project: () => call("project"), clips: () => call("clips"), log: (t) => call("log", t), sleep: (ms) => call("sleep", ms) };
  const text = (a) => a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
  const con = { log: (...a) => call("log", text(a)), warn: (...a) => call("log", text(a)), error: (...a) => call("log", text(a)) };
  for (const k of blocked) { try { Object.defineProperty(self, k, { value: undefined, configurable: false }); } catch { try { self[k] = undefined; } catch {} } }
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction("cutir", "console", code)(cutir, con);
    let out = null;
    try { out = result === undefined ? null : JSON.parse(JSON.stringify(result)); } catch { out = String(result); }
    postMessage({ type: "done", result: out });
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};`;

export type WorkerLike = { postMessage: (m: unknown) => void; onmessage: ((e: { data: any }) => void) | null; terminate: () => void };
export type Spawn = (source: string) => WorkerLike;

export const browserSpawn: Spawn = (source) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const w = new Worker(url);
  const terminate = w.terminate.bind(w);
  w.terminate = () => (terminate(), URL.revokeObjectURL(url));
  return w as unknown as WorkerLike;
};

export type ScriptResult = { ok: boolean; result?: unknown; error?: string; logs: string[]; calls: number };

export function runScript(code: string, host: ScriptHost, opts: { timeoutMs?: number; spawn?: Spawn } = {}): Promise<ScriptResult> {
  const logs: string[] = [];
  const h: ScriptHost = { ...host, log: (t) => (logs.push(t), host.log(t)) };
  let calls = 0;
  return new Promise((resolve) => {
    const w = (opts.spawn ?? browserSpawn)(WORKER_SOURCE);
    let done = false;
    const finish = (r: Omit<ScriptResult, "logs" | "calls">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.terminate();
      resolve({ ...r, logs, calls });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `The script ran for more than ${Math.round((opts.timeoutMs ?? 15000) / 1000)} seconds and was stopped.` }), opts.timeoutMs ?? 15000);
    w.onmessage = async (e) => {
      const d = e.data;
      if (d.type === "done") return finish({ ok: true, result: d.result });
      if (d.type === "error") return finish({ ok: false, error: d.message });
      if (d.type !== "call" || done) return;
      if (++calls > MAX_CALLS) return finish({ ok: false, error: `The script made more than ${MAX_CALLS} calls and was stopped.` });
      try {
        const result = await handleCall(h, d.method, d.args);
        if (!done) w.postMessage({ id: d.id, result });
      } catch (err) {
        if (!done) w.postMessage({ id: d.id, error: (err as Error).message });
      }
    };
    w.postMessage({ code });
  });
}
