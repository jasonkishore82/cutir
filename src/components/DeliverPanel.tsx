import { useEffect, useState } from "react";
import { useProject } from "../store/project";
import { useTimelineUi } from "../timeline/ui";
import { useDeliver, askNotifications, lengthOf, selectionSpan } from "../store/deliver";
import { BUILTIN_PRESETS, CONTAINER_EXT, audioCodecsFor, estimateBytes, fileName, isAudioOnly, isStillOut, presetById, videoCodecsFor, type AudioCodecId, type Container, type DeliverPreset, type RangeChoice, type SourceChoice, type VideoCodecId } from "../lib/deliver/presets";
import { capabilityProblem, targetOf } from "../lib/deliver/render";
import { isActive, isFinished, summary, type Job } from "../lib/deliver/queue";
import { usePlayback, getTime } from "../lib/transport";
import { downloadBlob } from "../lib/exporter";
import { activeTimeline } from "../model/convert";

const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const btn = "px-2.5 py-1 text-xs rounded border border-edge hover:bg-edge disabled:opacity-40 disabled:hover:bg-transparent";
const NAMES: Record<string, string> = { avc: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1", aac: "AAC", opus: "Opus", flac: "FLAC", wav: "WAV" };

export default function DeliverPanel() {
  const doc = useProject((s) => s.doc);
  const project = useProject((s) => s.project);
  const selected = useTimelineUi((s) => s.selected);
  const duration = usePlayback((s) => s.duration);
  const { jobs, custom, held } = useDeliver();
  const store = useDeliver.getState();

  const [presetId, setPresetId] = useState("youtube-1080");
  const base = presetById(presetId, custom) ?? BUILTIN_PRESETS[0];
  const [edits, setEdits] = useState<Partial<DeliverPreset>>({});
  const preset: DeliverPreset = { ...base, ...edits };
  const [range, setRange] = useState<RangeChoice>("whole");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [source, setSource] = useState<SourceChoice>("original");
  const [timelines, setTimelines] = useState<string[]>([]);
  const [showEdit, setShowEdit] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => setEdits({}), [presetId]);
  const t = targetOf(preset, project);
  const span = selectionSpan(doc, selected);
  const ids = timelines.length ? timelines : [doc.activeTimelineId];
  const length = lengthOf(doc, ids[0]);
  const seconds = range === "whole" ? length : range === "selection" ? (span ? span.end - span.start : 0) : Math.max(0, Math.min(to || length, length) - from);

  useEffect(() => {
    let live = true;
    setProblem(null);
    capabilityProblem(preset, t.w, t.h, t.fps).then((p) => live && setProblem(p));
    return () => {
      live = false;
    };
  }, [preset.container, preset.video, preset.audio, preset.bitrateMbps, preset.audioKbps, t.w, t.h, t.fps]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    askNotifications();
    const made = store.add({ preset, timelineIds: ids, range, start: from, end: to || undefined, source });
    setMessage(made.length ? `Added ${made.length} job${made.length === 1 ? "" : "s"} to the queue.` : "Nothing to render in that range.");
  };

  const patch = (p: Partial<DeliverPreset>) => setEdits((e) => ({ ...e, ...p }));
  const setContainer = (c: Container) => {
    const v = videoCodecsFor(c);
    const a = audioCodecsFor(c);
    patch({ container: c, ...(v.length && !v.includes(preset.video) ? { video: v[0] } : {}), ...(a.length && !a.includes(preset.audio) ? { audio: a[0] } : {}) });
  };
  const savePreset = () => {
    const name = window.prompt("Preset name", edits.name ?? (base.builtin ? `${base.name} (custom)` : base.name));
    if (!name?.trim()) return;
    const id = base.builtin || edits.name !== undefined ? `custom-${Date.now().toString(36)}` : base.id;
    store.savePreset({ ...preset, id, name: name.trim(), builtin: undefined });
    setPresetId(id);
    setEdits({});
  };
  const importFile = async (f?: File | null) => {
    if (!f) return;
    const r = store.importPresets(await f.text());
    setMessage(r.added ? `Imported ${r.added} preset${r.added === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped}` : ""}.` : "No valid presets in that file.");
  };

  const sum = summary(jobs);
  const dirty = Object.keys(edits).length > 0;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <label className="flex items-center gap-1 flex-1">
            Preset
            <select className="field flex-1" value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="Delivery preset">
              <optgroup label="Built in">{BUILTIN_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
              {custom.length > 0 && <optgroup label="Yours">{custom.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
            </select>
          </label>
          <button className={btn} onClick={() => setShowEdit((v) => !v)}>{showEdit ? "Hide" : "Edit"}</button>
        </div>
        <p className="text-[11px] text-gray-500">
          {isAudioOnly(preset.container) ? `${preset.container.toUpperCase()} audio` : isStillOut(preset.container) ? `${preset.container === "gif" ? "GIF" : "PNG frames in a zip"}, ${t.w} x ${t.h}, ${t.fps} fps` : `${NAMES[preset.video]} + ${NAMES[preset.audio]} in ${preset.container.toUpperCase()}, ${t.w} x ${t.h}, ${t.fps} fps, ${preset.rateMode === "bitrate" ? `${preset.bitrateMbps} Mbps` : `${preset.quality} quality`}`}
          {seconds > 0 && estimateBytes(preset, seconds) > 0 ? `, about ${mb(estimateBytes(preset, seconds))}` : ""}
        </p>
        {problem && <p className="text-[11px] text-yellow-400">{problem}</p>}
      </div>

      {showEdit && (
        <div className="grid grid-cols-2 gap-2 rounded border border-edge p-2 text-xs text-gray-400">
          <label>Container
            <select className="field" value={preset.container} onChange={(e) => setContainer(e.target.value as Container)}>
              {(Object.keys(CONTAINER_EXT) as Container[]).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {videoCodecsFor(preset.container).length > 0 && (
            <label>Video codec
              <select className="field" value={preset.video} onChange={(e) => patch({ video: e.target.value as VideoCodecId })}>
                {videoCodecsFor(preset.container).map((c) => <option key={c} value={c}>{NAMES[c]}</option>)}
              </select>
            </label>
          )}
          {audioCodecsFor(preset.container).length > 0 && (
            <label>Audio
              <select className="field" value={preset.audio} onChange={(e) => patch({ audio: e.target.value as AudioCodecId })}>
                {audioCodecsFor(preset.container).map((c) => <option key={c} value={c}>{NAMES[c]}</option>)}
              </select>
            </label>
          )}
          {!isAudioOnly(preset.container) && !isStillOut(preset.container) && (
            <>
              <label>Rate
                <select className="field" value={preset.rateMode} onChange={(e) => patch({ rateMode: e.target.value as "quality" | "bitrate" })}>
                  <option value="bitrate">Target bitrate</option>
                  <option value="quality">Constant quality</option>
                </select>
              </label>
              {preset.rateMode === "bitrate" ? (
                <label>Mbps<input className="field" type="number" min={0.1} step={0.5} value={preset.bitrateMbps} onChange={(e) => patch({ bitrateMbps: Number(e.target.value) })} /></label>
              ) : (
                <label>Quality
                  <select className="field" value={preset.quality} onChange={(e) => patch({ quality: e.target.value as DeliverPreset["quality"] })}>
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="very-high">Very high</option>
                  </select>
                </label>
              )}
              <label>Keyframe every (s)<input className="field" type="number" min={0.1} step={0.5} value={preset.keyframeSeconds} onChange={(e) => patch({ keyframeSeconds: Number(e.target.value) })} /></label>
            </>
          )}
          {!isAudioOnly(preset.container) && (
            <>
              <label>Width (0 = project)<input className="field" type="number" min={0} value={preset.width} onChange={(e) => patch({ width: Number(e.target.value) })} /></label>
              <label>Height (0 = auto)<input className="field" type="number" min={0} value={preset.height} onChange={(e) => patch({ height: Number(e.target.value) })} /></label>
              <label>FPS (0 = project)<input className="field" type="number" min={0} max={240} value={preset.fps} onChange={(e) => patch({ fps: Number(e.target.value) })} /></label>
            </>
          )}
          {preset.audio !== "wav" && preset.audio !== "flac" && audioCodecsFor(preset.container).length > 0 && (
            <label>Audio kbps<input className="field" type="number" min={32} max={512} value={preset.audioKbps} onChange={(e) => patch({ audioKbps: Number(e.target.value) })} /></label>
          )}
          <label className="col-span-2">File name
            <input className="field" value={preset.pattern} onChange={(e) => patch({ pattern: e.target.value })} />
            <span className="text-[10px] text-gray-500">{"{project} {timeline} {preset} {date} {time} {n} {w} {h} {fps}"}: {fileName(preset.pattern, { project: "cutir", timeline: activeTimeline(doc).name, preset: preset.name, w: t.w, h: t.h, fps: t.fps }, preset.container)}</span>
          </label>
          <div className="col-span-2 flex flex-wrap gap-2">
            <button className={btn} onClick={savePreset} disabled={!dirty && !base.builtin}>Save as preset</button>
            {!base.builtin && <button className={`${btn} text-red-300`} onClick={() => { store.deletePreset(base.id); setPresetId("youtube-1080"); }}>Delete preset</button>}
            <label className={`${btn} cursor-pointer`}>
              Import
              <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <button className={btn} disabled={!custom.length} onClick={() => downloadBlob(new Blob([store.exportPresets()], { type: "application/json" }), "cutir-presets.json")}>Export presets</button>
          </div>
        </div>
      )}

      <div className="space-y-2 text-xs text-gray-400">
        {doc.timelines.length > 1 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <span>Timelines</span>
            {doc.timelines.map((tl) => (
              <label key={tl.id} className="flex items-center gap-1">
                <input type="checkbox" checked={ids.includes(tl.id)} onChange={(e) => setTimelines(e.target.checked ? [...new Set([...ids, tl.id])] : ids.filter((x) => x !== tl.id))} />
                {tl.name}
              </label>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">Range
            <select className="field !w-auto" value={range} onChange={(e) => setRange(e.target.value as RangeChoice)}>
              <option value="whole">Whole timeline</option>
              <option value="inout">In and out</option>
              <option value="selection" disabled={!span}>Selected clips</option>
            </select>
          </label>
          {range === "inout" && (
            <>
              <button className={btn} onClick={() => setFrom(Math.round(getTime() * 100) / 100)}>In {mmss(from)}</button>
              <button className={btn} onClick={() => setTo(Math.round(getTime() * 100) / 100)}>Out {to ? mmss(to) : "end"}</button>
            </>
          )}
          {range === "selection" && span && <span>{mmss(span.start)} to {mmss(span.end)}</span>}
          <label className="flex items-center gap-1">Media
            <select className="field !w-auto" value={source} onChange={(e) => setSource(e.target.value as SourceChoice)} aria-label="Source media">
              <option value="original">Original</option>
              <option value="proxy">Proxy (faster, lower quality)</option>
            </select>
          </label>
        </div>
        <p className="text-[11px] text-gray-500">{duration > 0 ? `${mmss(seconds)} to render` : "no duration yet"}</p>
      </div>

      <div className="flex items-center gap-2">
        <button className={`${btn} bg-accent !border-accent text-black font-medium`} onClick={add} disabled={!!problem || !(seconds > 0)}>Add to queue</button>
        <button className={btn} onClick={() => store.hold(!held)}>{held ? "Resume queue" : "Pause queue"}</button>
        {message && <span className="text-[11px] text-gray-400">{message}</span>}
      </div>

      {jobs.length > 0 && (
        <div className="space-y-1.5 border-t border-edge pt-2">
          <div className="flex items-center justify-between text-[11px] text-gray-400">
            <span>{sum.running} running, {sum.waiting} waiting, {sum.done} done{sum.failed ? `, ${sum.failed} failed` : ""}{held ? " (queue paused)" : ""}</span>
            <button className="underline disabled:opacity-40" disabled={!jobs.some(isFinished)} onClick={store.clearFinished}>Clear finished</button>
          </div>
          <ul className="max-h-56 space-y-1.5 overflow-auto">
            {jobs.map((j) => <JobRow key={j.id} job={j} />)}
          </ul>
        </div>
      )}
    </div>
  );
}

function JobRow({ job: j }: { job: Job }) {
  const s = useDeliver.getState();
  const [open, setOpen] = useState(false);
  const color = j.status === "failed" || j.status === "interrupted" ? "text-red-300" : j.status === "done" ? (j.verdict?.ok === false ? "text-yellow-300" : "text-green-300") : "text-gray-400";
  return (
    <li className="rounded border border-edge p-1.5 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate" title={j.name}>{j.name}</span>
        <span className={color}>{j.status === "running" ? `${Math.round(j.progress * 100)}%` : j.status}</span>
      </div>
      {j.status === "running" && (
        <div className="mt-1 h-1.5 rounded bg-bg overflow-hidden"><div className="h-full bg-sky-400" style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-gray-500">
        <span className="truncate">{j.status === "running" ? j.stage : j.error ?? (j.fileName ? `${j.fileName}${j.bytes ? `, ${mb(j.bytes)}` : ""}` : j.stage)}</span>
        <span className="flex-1" />
        {(j.status === "queued" || j.status === "paused") && (
          <>
            <button className="underline" onClick={() => s.move(j.id, -1)} aria-label="Move up">up</button>
            <button className="underline" onClick={() => s.move(j.id, 1)} aria-label="Move down">down</button>
            <button className="underline" onClick={() => s.holdJob(j.id, j.status === "queued")}>{j.status === "queued" ? "hold" : "release"}</button>
          </>
        )}
        {isActive(j) && <button className="underline text-red-300" onClick={() => s.cancel(j.id)}>cancel</button>}
        {j.status === "done" && j.hasFile && <button className="underline" onClick={() => s.save(j.id)}>save</button>}
        {j.verdict && <button className="underline" onClick={() => setOpen((v) => !v)}>{open ? "hide checks" : "checks"}</button>}
        {isFinished(j) && <button className="underline" onClick={() => s.retry(j.id)}>{j.status === "done" ? "re-render" : "retry"}</button>}
        {isFinished(j) && <button className="underline" onClick={() => s.remove(j.id)}>remove</button>}
      </div>
      {open && j.verdict && (
        <ul className="mt-1 space-y-0.5">
          {j.verdict.checks.map((c) => (
            <li key={c.name} className={c.ok ? "text-green-400" : "text-red-300"}>{c.ok ? "ok" : "FAIL"} {c.name}: {c.detail}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
