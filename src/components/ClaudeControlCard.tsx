import { useState } from "react";
import { Card } from "./ui";
import { useMcp } from "../lib/mcpBridge";
import { DEFAULT_PORT } from "../mcp/protocol";

const DOT = { off: "bg-gray-500", waiting: "bg-yellow-400", connecting: "bg-yellow-400 animate-pulse", connected: "bg-green-500", rejected: "bg-red-500" } as const;

/**
 * Settings card: let Claude Code or Claude Desktop (signed in with your own Claude account) control this editor
 * through the Cutir MCP plugin. Off by default.
 */
export default function ClaudeControlCard() {
  const { enabled, port, token, status, message, log, set } = useMcp();
  const [code, setCode] = useState(token);
  return (
    <Card title="Claude control (MCP)" hint="Use Claude Code or Claude Desktop with your Claude subscription to edit this project. Needs the Cutir plugin; see docs/MCP.md.">
      <label className="flex items-start gap-2 text-[13px] text-gray-300">
        <input type="checkbox" className="mt-0.5" checked={enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>
          Let Claude control this editor
          <span className="block text-[11px] text-gray-500">Only Claude apps on this computer, with the pairing code, can connect. Every change is one undo step.</span>
        </span>
      </label>
      {enabled && (
        <>
          <div className="flex items-end gap-2">
            <label className="block flex-1">
              <span className="label">Pairing code</span>
              <input
                className="field font-mono tracking-widest"
                value={code}
                placeholder="ask Claude: cutir_status"
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onBlur={() => code !== token && set({ token: code })}
                onKeyDown={(e) => e.key === "Enter" && set({ token: code })}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="block w-24">
              <span className="label">Port</span>
              <input className="field" type="number" min={1024} max={65535} value={port} onChange={(e) => set({ port: Number(e.target.value) || DEFAULT_PORT })} />
            </label>
          </div>
          <p className="flex items-start gap-2 text-[12px] text-gray-300" role="status" aria-live="polite">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[status]}`} />
            <span>{status === "connected" ? "Connected. " : ""}{message}</span>
          </p>
          {status === "rejected" && (
            <button className="rounded-lg border border-edge px-3 py-1.5 text-[12px] text-gray-300 hover:bg-raised" onClick={() => set({ token: code })}>
              Try again
            </button>
          )}
          {log.length > 0 && (
            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-edge p-2 font-mono text-[10px]">
              {log.map((l, i) => (
                <div key={i} className={l.ok ? "text-gray-400" : "text-red-400"}>
                  {new Date(l.at).toLocaleTimeString()} {l.name}: {l.summary}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Small top-bar badge while Claude is connected. */
export function ClaudeBadge() {
  const status = useMcp((s) => s.status);
  if (status !== "connected") return null;
  return (
    <button
      className="flex items-center gap-1.5 rounded-full border border-green-500/40 bg-green-500/10 px-2.5 py-1 text-[11px] text-green-300 hover:bg-green-500/20"
      title="Claude Code / Claude Desktop can edit this project. Click to disconnect."
      onClick={() => useMcp.getState().set({ enabled: false })}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
      Claude connected
    </button>
  );
}
