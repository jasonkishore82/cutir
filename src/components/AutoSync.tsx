import { useEffect, useRef, useState } from "react";
import { useProject } from "../store/project";
import { ALIGNER_HELP, DEFAULT_ALIGNER_URL, alignLines, checkAligner, isTagLine, type AlignProgress } from "../lib/aligner";

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

const LABELS: Record<AlignProgress["stage"], string> = {
  uploading: "Uploading song",
  separating: "Separating vocals",
  loading: "Loading model (the first run downloads it)",
  aligning: "Aligning lyrics",
};

/** Where each stage sits on the bar. Vocal separation is the long stage when it is on. */
function stageRange(stage: AlignProgress["stage"], separate: boolean): [number, number] {
  if (separate) {
    return { uploading: [0, 0.03], separating: [0.03, 0.6], loading: [0.6, 0.68], aligning: [0.68, 0.97] }[stage] as [number, number];
  }
  return { uploading: [0, 0.05], separating: [0.05, 0.05], loading: [0.05, 0.2], aligning: [0.2, 0.97] }[stage] as [number, number];
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Auto-sync lyrics to the song with the local Python aligner (tools/aligner). */
export default function AutoSync() {
  const audio = useProject((s) => s.project.audio);
  const lines = useProject((s) => s.project.lines);

  const [url, setUrl] = useState(() => read("cutir:alignerUrl", DEFAULT_ALIGNER_URL));
  const [language, setLanguage] = useState(() => read("cutir:alignLang", "en"));
  const [model, setModel] = useState(() => read("cutir:alignModel", "base"));
  const [separate, setSeparate] = useState(() => read("cutir:alignSeparate", "0") === "1");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  // progress bar state
  const [prog, setProg] = useState<AlignProgress | null>(null);
  const [shown, setShown] = useState(0); // what the bar displays (0..1), eased toward the target
  const [elapsed, setElapsed] = useState(0);
  const [flashDone, setFlashDone] = useState(false);
  const shownRef = useRef(0);
  const progRef = useRef<AlignProgress | null>(null);
  progRef.current = prog;

  // ease the bar toward the current stage's target; slow creep while a stage can't be measured
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      const p = progRef.current;
      if (p) {
        const [lo, hi] = stageRange(p.stage, separate);
        const measured = p.pct !== undefined;
        const target = measured ? lo + (hi - lo) * p.pct! : lo + (hi - lo) * 0.92;
        const rate = measured ? 0.25 : shownRef.current < lo ? 0.15 : 0.012;
        shownRef.current = Math.max(shownRef.current, shownRef.current + (target - shownRef.current) * rate);
        setShown(shownRef.current);
      }
      setElapsed(Math.floor((Date.now() - t0) / 1000));
    }, 100);
    return () => clearInterval(id);
  }, [busy, separate]);

  const sungCount = lines.filter((l) => !isTagLine(l.text)).length;
  const canRun = !!audio?.url && sungCount > 0 && !busy;

  const run = async () => {
    if (!audio?.url) return;
    setMsg(null);
    shownRef.current = 0;
    setShown(0);
    setElapsed(0);
    setProg({ stage: "uploading" });
    setFlashDone(false);
    setBusy(true);
    abort.current = new AbortController();
    try {
      const result = await alignLines(
        url,
        { url: audio.url, name: audio.name },
        useProject.getState().project.lines,
        { language, model, separate },
        abort.current.signal,
        setProg
      );
      useProject.getState().update((p) => ({ ...p, lines: result.lines })); // one undo step
      shownRef.current = 1;
      setShown(1);
      setFlashDone(true);
      setTimeout(() => setFlashDone(false), 1200);
      const tags = result.skippedTags ? ` Removed ${result.skippedTags} section tag${result.skippedTags === 1 ? "" : "s"}.` : "";
      setMsg({ ok: true, text: `Synced ${result.lines.length} lines.${tags} Undo with Ctrl+Z.` });
    } catch (e) {
      setMsg(
        (e as Error).name === "AbortError"
          ? { ok: false, text: "Cancelled." }
          : { ok: false, text: (e as Error).message }
      );
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const test = async () => {
    setMsg(null);
    try {
      const h = await checkAligner(url);
      setMsg({ ok: !!h.ffmpeg, text: h.ffmpeg ? `Aligner is running (${h.backend}, default model ${h.model}).` : "Aligner is running but ffmpeg is missing from PATH." });
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
            <span>Separate vocals first (Demucs). Slower, but much more accurate on produced songs like Suno tracks. Needs <code>pip install demucs</code>.</span>
          </label>
          <button className={btn} onClick={test}>Test connection</button>
        </div>
      )}

      {busy || flashDone ? (
        <div className="space-y-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown * 100)}>
          <div className="flex items-center justify-between text-[11px] text-gray-400">
            <span className="truncate">{busy ? `${LABELS[prog?.stage ?? "uploading"]}…` : "Done"}</span>
            <span className="tabular-nums shrink-0 ml-2">
              {Math.round(shown * 100)}%{busy ? ` · ${mmss(elapsed)}` : ""}
            </span>
          </div>
          <div className="h-2 rounded-full bg-bg overflow-hidden border border-edge">
            <div
              className={`h-full rounded-full bg-accent ${busy ? "progress-stripes" : ""}`}
              style={{ width: `${Math.max(2, shown * 100)}%`, transition: "width 120ms linear" }}
            />
          </div>
          {busy && <button className={`${btn} border-red-700 text-red-300`} onClick={() => abort.current?.abort()}>Cancel</button>}
        </div>
      ) : (
        <button className={`${btn} w-full disabled:opacity-40 disabled:hover:bg-transparent`} disabled={!canRun} onClick={run}>
          Auto-sync lyrics
        </button>
      )}

      {!audio?.url && <p className="text-[11px] text-gray-500">Upload the song first.</p>}
      {audio?.url && sungCount === 0 && <p className="text-[11px] text-gray-500">Add the lyrics first.</p>}
      {msg && <p className={`text-[11px] ${msg.ok ? "text-green-400" : "text-red-400"} break-words`}>{msg.text}</p>}
      <p className="text-[11px] text-gray-600">Lines like [Verse] or [Chorus] are skipped.</p>
    </div>
  );
}
