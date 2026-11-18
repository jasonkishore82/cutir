import { useState } from "react";
import { layerIdOf, useProject } from "../store/project";
import { ALIGNER_HELP, DEFAULT_ALIGNER_URL, checkAligner, isTagLine } from "../lib/aligner";
import { useSyncJob } from "../lib/autosync";
import { applyCalls } from "../lib/tools";
import SyncProgress from "./SyncProgress";

const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

/** Auto-sync lyrics to the song with the Python backend (backend/). The chat can start the same job. */
export default function AutoSync() {
  const audio = useProject((s) => s.project.audio);
  const lines = useProject((s) => s.project.lines);
  const layers = useProject((s) => s.project.layers);
  const phase = useSyncJob((s) => s.phase);

  const [url, setUrl] = useState(() => read("cutir:alignerUrl", DEFAULT_ALIGNER_URL));
  const [language, setLanguage] = useState(() => read("cutir:alignLang", "en"));
  const [model, setModel] = useState(() => read("cutir:alignModel", "base"));
  const [separate, setSeparate] = useState(() => read("cutir:alignSeparate", "0") === "1");
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // only the main (first) layer is timed to the song
  const sungCount = lines.filter((l) => layerIdOf({ layers }, l) === layers[0].id && !isTagLine(l.text)).length;
  const busy = phase !== "idle";
  const canRun = !!audio?.url && sungCount > 0 && !busy;

  const run = async () => {
    setMsg(null);
    const { results } = await applyCalls([{ tool: "auto_sync", args: {} }]); // same path the chat uses; one undo step
    const r = results[0];
    setMsg({ ok: r.ok, text: r.ok ? `${r.summary}. Undo with Ctrl+Z.` : r.summary.replace(/^auto_sync: /, "") });
  };

  const test = async () => {
    setMsg(null);
    try {
      const h = await checkAligner(url);
      const a = h.aligner;
      const problem = !h.ffmpeg
        ? "ffmpeg is missing from PATH"
        : !a.stable_ts
          ? "stable-ts is not installed (pip install -r backend/requirements.txt)"
          : null;
      setMsg(
        problem
          ? { ok: false, text: `Backend is running, but ${problem}.` }
          : { ok: true, text: `Backend is running (v${h.version}): ${a.backend}, model ${a.model}${a.demucs ? ", vocal separation available" : ", no Demucs (pip install demucs)"}.` }
      );
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message || ALIGNER_HELP });
    }
  };

  const btn = "px-2 py-1.5 text-xs rounded border border-edge hover:bg-edge";

  return (
    <div className="mt-1 space-y-2 rounded border border-edge p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-300">Auto-sync with Python</span>
        <button className="text-[11px] text-gray-500 hover:text-gray-200" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide options" : "Options"}
        </button>
      </div>

      {open && (
        <div className="space-y-2 text-xs">
          <label className="block">
            <span className="label">Helper URL</span>
            <input className="field" value={url} onChange={(e) => (setUrl(e.target.value), write("cutir:alignerUrl", e.target.value))} />
          </label>
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="label">Language</span>
              <input
                className="field"
                value={language}
                placeholder="en, es, hi... or auto"
                onChange={(e) => (setLanguage(e.target.value), write("cutir:alignLang", e.target.value))}
              />
            </label>
            <label className="flex-1">
              <span className="label">Model</span>
              <select className="field" value={model} onChange={(e) => (setModel(e.target.value), write("cutir:alignModel", e.target.value))}>
                {["tiny", "base", "small", "medium", "large-v3"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-start gap-2 text-gray-400">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={separate}
              onChange={(e) => (setSeparate(e.target.checked), write("cutir:alignSeparate", e.target.checked ? "1" : "0"))}
            />
            <span>Separate vocals first (Demucs). Slower, but much more accurate on produced songs like Suno tracks.</span>
          </label>
          <button className={btn} onClick={test}>Test connection</button>
        </div>
      )}

      {busy ? (
        <SyncProgress />
      ) : (
        <button className={`${btn} w-full disabled:opacity-40 disabled:hover:bg-transparent`} disabled={!canRun} onClick={run}>
          Auto-sync lyrics
        </button>
      )}

      {!audio?.url && <p className="text-[11px] text-gray-500">Upload the song first.</p>}
      {audio?.url && sungCount === 0 && <p className="text-[11px] text-gray-500">Add the lyrics first.</p>}
      {msg && <p className={`text-[11px] ${msg.ok ? "text-green-400" : "text-red-400"} break-words`}>{msg.text}</p>}
      <p className="text-[11px] text-gray-600">Lines like [Verse] or [Chorus] are skipped. You can also type "auto sync" in the chat.</p>
    </div>
  );
}
