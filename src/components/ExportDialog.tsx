import { Icon } from "./ui";
import { useEffect, useRef, useState } from "react";
import { useProject } from "../store/project";
import { ASPECT_SIZES } from "../lib/renderer";
import { downloadBlob, exportMp4, type ExportProgress, type ExportScale, type SoftTrack } from "../lib/exporter";
import { serializeCues } from "../lib/captions/cues";
import { linesToCues } from "../lib/captions/ops";
import { toAss, toSrt } from "../lib/subtitles";
import { usePlayback } from "../lib/transport";
import DeliverPanel from "./DeliverPanel";

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const update = useProject((s) => s.update);
  const duration = usePlayback((s) => s.duration);

  const [tab, setTab] = useState<"quick" | "deliver">("quick");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ url: string; size: number } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const [scale, setScale] = useState<ExportScale>(1);
  /** How captions leave: drawn into the picture, as tracks the viewer can switch (WebVTT in the MP4), or both. */
  const [captionMode, setCaptionMode] = useState<"burn" | "soft" | "both">("burn");
  const [note, setNote] = useState("");
  const shown = project.layers.filter((l) => l.visible && project.lines.some((x) => (x.layerId ?? project.layers[0].id) === l.id));
  const softTracks = (): SoftTrack[] =>
    shown.map((l) => ({ name: l.name, lang: l.lang ?? "en", vtt: serializeCues("vtt", linesToCues(project.lines.filter((x) => (x.layerId ?? project.layers[0].id) === l.id))) }));
  const base = ASPECT_SIZES[project.aspect];
  const w = base.w * scale;
  const h = base.h * scale;
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
      setNote("");
      const current = useProject.getState().project;
      const wantSoft = captionMode !== "burn" ? softTracks() : [];
      // soft only: the picture is drawn without captions
      const forPicture = captionMode === "soft" ? { ...current, layers: current.layers.map((l) => ({ ...l, visible: false })) } : current;
      const softResult = { written: false };
      const blob = await exportMp4(forPicture, {
        duration,
        scale,
        onProgress: setProgress,
        signal: abort.current.signal,
        softSubtitles: wantSoft,
        softResult,
      });
      setResult({ url: URL.createObjectURL(blob), size: blob.size });
      downloadBlob(blob, "cutir-export.mp4");
      if (wantSoft.length && !softResult.written) {
        // the compatibility encoder cannot write subtitle tracks: hand them over as files next to the video
        wantSoft.forEach((s) => downloadBlob(new Blob([s.vtt], { type: "text/vtt" }), `cutir-${s.lang}-${s.name.replace(/[^\w-]+/g, "_")}.vtt`));
        setNote(`This export used the compatibility encoder, which cannot store subtitle tracks in the video. They were saved as ${wantSoft.length} .vtt file${wantSoft.length === 1 ? "" : "s"} instead${captionMode === "soft" ? ", and the picture has no captions" : ""}.`);
      }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !running && onClose()}>
      <div
        role="dialog"
        aria-label="Export"
        className={`${tab === "deliver" ? "w-[560px]" : "w-[440px]"} max-w-[92vw] max-h-[92vh] overflow-auto rounded-2xl border border-white/10 bg-panel p-5 space-y-4 shadow-2xl shadow-black/60`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Export</h2>
          <button className="text-gray-500 hover:text-gray-100 text-lg leading-none" onClick={onClose} disabled={running} aria-label="Close">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-1 text-xs" role="tablist">
          {(["quick", "deliver"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-1 rounded border ${tab === k ? "border-accent text-gray-100" : "border-edge text-gray-400"}`} onClick={() => setTab(k)} disabled={running}>
              {k === "quick" ? "Quick MP4" : "Deliver and queue"}
            </button>
          ))}
        </div>

        {tab === "deliver" ? <DeliverPanel /> : (<>
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <label className="flex items-center gap-1">
              Size
              <select className="field !w-auto" value={scale} disabled={running} onChange={(e) => setScale(Number(e.target.value) as ExportScale)}>
                <option value={1}>{base.w} x {base.h}</option>
                <option value={2}>4K ({base.w * 2} x {base.h * 2})</option>
              </select>
            </label>
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
            <span>{duration > 0 ? `${mmss(duration)}, ${frames} frames` : "no duration yet"}</span>
          </div>
          {shown.length > 0 && (
            <label className="flex items-center gap-1 text-xs text-gray-400">
              Captions
              <select className="field !w-auto" value={captionMode} disabled={running} onChange={(e) => setCaptionMode(e.target.value as "burn" | "soft" | "both")} aria-label="How captions are exported">
                <option value="burn">Burned into the picture</option>
                <option value="soft">Soft tracks (viewer can switch them)</option>
                <option value="both">Burned in and soft tracks</option>
              </select>
              <span className="text-gray-500">{shown.length} track{shown.length === 1 ? "" : "s"}</span>
            </label>
          )}
          {scale === 2 && (
            <p className="text-[11px] text-yellow-400">
              4K ({w} x {h}) needs a browser and GPU that can encode H.264 at that size. Otherwise it falls back to the very slow compatibility encoder. Try 30 fps.
            </p>
          )}
          {long && (
            <p className="text-[11px] text-yellow-400">
              Long exports run in your browser and can take a while. 30 fps is much faster than 60.
            </p>
          )}
        </div>

        {running || progress ? (
          <div className="space-y-1.5">
            <div className="h-2 rounded bg-bg overflow-hidden">
              <div className="h-full bg-gradient-to-r from-sky-500 to-sky-300 transition-[width]" style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
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
        {note && <p className="text-xs text-yellow-400">{note}</p>}
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
        </>)}
      </div>
    </div>
  );
}
