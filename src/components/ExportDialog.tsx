import { useEffect, useRef, useState } from "react";
import { useProject } from "../store/project";
import { ASPECT_SIZES } from "../lib/renderer";
import { downloadBlob, exportMp4, type ExportProgress } from "../lib/exporter";
import { toAss, toSrt } from "../lib/subtitles";
import { usePlayback } from "../lib/transport";

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const update = useProject((s) => s.update);
  const duration = usePlayback((s) => s.duration);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ url: string; size: number } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const { w, h } = ASPECT_SIZES[project.aspect];
  const frames = Math.ceil(duration * project.fps);
  const long = duration > 300;

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  const start = async () => {
    setError("");
    setResult(null);
    setRunning(true);
    setProgress({ stage: "Starting", fraction: 0 });
    abort.current = new AbortController();
    try {
      const blob = await exportMp4(useProject.getState().project, {
        duration,
        onProgress: setProgress,
        signal: abort.current.signal,
      });
      setResult({ url: URL.createObjectURL(blob), size: blob.size });
      downloadBlob(blob, "cutir-export.mp4");
    } catch (e) {
      if ((e as Error).name === "AbortError") setError("Export cancelled.");
      else setError((e as Error).message || "Export failed.");
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  const text = (name: string, mime: string, build: () => string) =>
    downloadBlob(new Blob([build()], { type: mime }), name);

  const btn = "px-3 py-1.5 text-xs rounded border border-edge hover:bg-edge disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !running && onClose()}>
      <div
        role="dialog"
        aria-label="Export"
        className="w-[440px] max-w-[92vw] rounded-lg border border-edge bg-panel p-4 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Export</h2>
          <button className="text-gray-500 hover:text-gray-100 text-lg leading-none" onClick={onClose} disabled={running} aria-label="Close">
            ×
          </button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span>{w}×{h}</span>
            <label className="flex items-center gap-1">
              FPS
              <select
                className="field !w-auto"
                value={project.fps}
                disabled={running}
                onChange={(e) => update((p) => ({ ...p, fps: Number(e.target.value) as 30 | 60 }))}
              >
                <option value={30}>30</option>
                <option value={60}>60</option>
              </select>
            </label>
            <span>{duration > 0 ? `${mmss(duration)} · ${frames} frames` : "no duration yet"}</span>
          </div>
          {long && (
            <p className="text-[11px] text-yellow-400">
              Long exports run in your browser and can take a while. 30 fps is much faster than 60.
            </p>
          )}
        </div>

        {running || progress ? (
          <div className="space-y-1.5">
            <div className="h-2 rounded bg-bg overflow-hidden">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
            </div>
            <div className="flex justify-between text-[11px] text-gray-400">
              <span className="truncate">
                {progress?.stage}
                {progress?.engine === "gpu" && <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] text-green-300">fast encoder</span>}
                {progress?.engine === "cpu" && <span className="ml-2 rounded bg-yellow-900/50 px-1.5 py-0.5 text-[10px] text-yellow-300">compatibility mode (slower)</span>}
              </span>
              <span>{Math.round((progress?.fraction ?? 0) * 100)}%</span>
            </div>
          </div>
        ) : null}

        {error && <p className="text-xs text-red-400">{error}</p>}
        {result && (
          <p className="text-xs text-green-400">
            Done ({(result.size / 1048576).toFixed(1)} MB). If the download did not start,{" "}
            <a className="underline" href={result.url} download="cutir-export.mp4">save it here</a>.
          </p>
        )}

        <div className="flex gap-2">
          {running ? (
            <button className={`${btn} border-red-700 text-red-300`} onClick={() => abort.current?.abort()}>Cancel</button>
          ) : (
            <button className={`${btn} bg-accent !border-accent text-black font-medium`} onClick={start} disabled={!(duration > 0)}>
              Export MP4
            </button>
          )}
          <button className={btn} disabled={running || !project.lines.length} onClick={() => text("cutir.srt", "text/plain", () => toSrt(project))}>
            .srt
          </button>
          <button className={btn} disabled={running || !project.lines.length} onClick={() => text("cutir-karaoke.ass", "text/plain", () => toAss(project))}>
            .ass (karaoke)
          </button>
        </div>
      </div>
    </div>
  );
}
