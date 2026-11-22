import { useState } from "react";
import { Card } from "./ui";
import { useAiLog, summarize, useAiSafety } from "../store/aiLog";
import { useMacros } from "../store/macros";
import { describeStep } from "../lib/ai/macroData";
import { missingSteps, playMacro } from "../lib/ai/playMacro";
import { downloadBlob } from "../lib/exporter";

const btn = "rounded-lg border border-edge px-3 py-1.5 text-[13px] text-gray-300 hover:bg-raised hover:text-white disabled:opacity-40";
const KIND: Record<string, string> = { chat: "Assistant", translate: "Translation", transcribe: "Speech to text", helper: "Local helper" };
const when = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const size = (n: number, unit: string) => (unit === "bytes" ? (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) : `${n.toLocaleString()} characters`);

/** Settings, Assistant: safety, the request log and macros (phase 28). */
export default function AssistantTab() {
  return (
    <div className="space-y-4">
      <SafetyCard />
      <LogCard />
      <MacrosCard />
    </div>
  );
}

function SafetyCard() {
  const askFirst = useAiSafety((s) => s.askFirst);
  return (
    <Card title="Safety" hint="Every change the assistant makes is one step you can undo with Ctrl+Z, and the chat shows exactly what changed.">
      <label className="flex items-start gap-2 text-[13px] text-gray-300">
        <input type="checkbox" className="mt-0.5" checked={askFirst} onChange={(e) => useAiSafety.getState().setAskFirst(e.target.checked)} />
        <span>
          Ask before deleting, cutting out or exporting
          <span className="block text-[11px] text-gray-500">The assistant shows what it wants to do and waits for you to press Apply.</span>
        </span>
      </label>
    </Card>
  );
}

function LogCard() {
  const entries = useAiLog((s) => s.entries);
  const { total, remote } = summarize(entries);
  const shown = [...entries].reverse().slice(0, 40);
  return (
    <Card title="Where your data went" hint="Your keys and project content leave this browser only for the AI provider you chose. Every request is listed here. Only the host and the amount are kept, never the text.">
      <div className="mb-2 flex items-center justify-between text-[12px] text-gray-400">
        <span role="status">{total === 0 ? "No requests yet." : `${total} request${total === 1 ? "" : "s"}, ${remote} to a service outside this computer.`}</span>
        <button className={btn} disabled={!total} onClick={() => useAiLog.getState().clear()}>Clear the log</button>
      </div>
      {shown.length > 0 && (
        <ul className="max-h-64 divide-y divide-edge/60 overflow-y-auto text-[12px] text-gray-300" aria-label="Requests sent to AI providers">
          {shown.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
              <span className="w-32 shrink-0 text-gray-500">{when(e.at)}</span>
              <span className="w-24 shrink-0">{KIND[e.kind] ?? e.kind}</span>
              <span className="min-w-0 flex-1 truncate" title={`${e.provider} ${e.model}`}>{e.provider} / {e.host}{e.model ? ` / ${e.model}` : ""}</span>
              <span className="shrink-0 text-gray-500">{size(e.size, e.unit)}</span>
              <span className={`shrink-0 rounded px-1.5 text-[10px] ${e.local ? "bg-green-500/15 text-green-300" : "bg-yellow-500/15 text-yellow-200"}`}>{e.local ? "this computer" : "online"}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MacrosCard() {
  const { macros, recording, draft } = useMacros();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const store = useMacros.getState();

  const pickFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      if (!input.files?.[0]) return;
      const r = store.importJson(await input.files[0].text());
      setNote(r.ok ? `Imported ${r.added} macro${r.added === 1 ? "" : "s"}${r.skipped ? `, ${r.skipped} skipped` : ""}.` : "That is not a macros file.");
    };
    input.click();
  };

  return (
    <Card title="Macros" hint="Record what you do (commands and assistant edits), then play it again on other clips. Macros are saved in this browser and can be shared as a file.">
      <div className="flex flex-wrap items-center gap-2">
        {recording ? (
          <>
            <span role="status" className="flex items-center gap-1.5 text-[13px] text-red-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> Recording, {draft.length} step{draft.length === 1 ? "" : "s"}
            </span>
            <button className={btn} onClick={() => setNote(store.stop() ? "Saved." : "Nothing was recorded.")}>Stop and save</button>
            <button className={btn} onClick={() => (store.discard(), setNote("Recording discarded."))}>Discard</button>
          </>
        ) : (
          <button className={btn} onClick={() => (store.start(), setNote(""))}>Start recording</button>
        )}
        <button className={btn} disabled={!macros.length} onClick={() => downloadBlob(new Blob([store.exportJson()], { type: "application/json" }), "cutir-macros.json")}>Export all</button>
        <button className={btn} onClick={pickFile}>Import</button>
      </div>
      {note && <p role="status" className="mt-2 text-xs text-yellow-300">{note}</p>}
      {macros.length === 0 && !recording && <p className="mt-2 text-xs text-gray-500">No macros yet. Press Start recording, do a few edits, then Stop and save.</p>}
      <ul className="mt-3 divide-y divide-edge/60">
        {macros.map((m) => {
          const missing = missingSteps(m);
          return (
            <li key={m.id} className="py-2 text-[13px] text-gray-300">
              <div className="flex flex-wrap items-center gap-2">
                <input className="field !w-48" value={m.name} aria-label="Macro name" onChange={(e) => store.rename(m.id, e.target.value)} />
                <span className="text-[11px] text-gray-500">{m.steps.length} step{m.steps.length === 1 ? "" : "s"}</span>
                <button className={btn} disabled={recording || missing.length > 0} onClick={async () => setNote((await playMacro(m)).message)}>Play</button>
                <button className="text-[11px] text-gray-500 underline hover:text-gray-200" onClick={() => setOpen(open === m.id ? null : m.id)}>{open === m.id ? "Hide steps" : "Steps"}</button>
                <button className="text-[11px] text-gray-500 underline hover:text-gray-200" onClick={() => downloadBlob(new Blob([store.exportJson([m.id])], { type: "application/json" }), `${m.name.replace(/[^\w-]+/g, "_")}.json`)}>Export</button>
                <button className="text-[11px] text-red-300 underline hover:text-red-200" onClick={() => store.remove(m.id)}>Delete</button>
              </div>
              {missing.length > 0 && <p className="mt-1 text-[11px] text-red-300">Needs {[...new Set(missing)].join(", ")}, which this version does not have.</p>}
              {open === m.id && (
                <ol className="mt-1.5 space-y-0.5 pl-1 font-mono text-[11px] text-gray-400">
                  {m.steps.map((s, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-5 text-right text-gray-600">{i + 1}</span>
                      <span className="min-w-0 flex-1 break-words">{describeStep(s)}</span>
                      <button aria-label={`Remove step ${i + 1}`} className="text-gray-500 hover:text-red-300" onClick={() => store.dropStep(m.id, i)}>x</button>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
