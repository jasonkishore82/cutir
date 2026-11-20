import { useState } from "react";
import { Card, Slider } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { editTimeline, useTimelineUi } from "../timeline/ui";
import { durationFor, retimeClips } from "../timeline/compound";
import { RAMP_PRESETS, clampSpeed, rampSourceSpan, type Ramp } from "../lib/retime";
import { downloadViewerFrame, freezeFrame } from "../lib/freeze";
import { scopeSource } from "../lib/scopes";
import { getTime } from "../lib/transport";
import type { Clip } from "../model/types";

const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40";

/** Speed, reverse, ramps, frame blending, and freeze frames for the selected clip (phase 23). */
export default function SpeedCard() {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [holdFor, setHoldFor] = useState(2);
  const tl = activeTimeline(doc);
  const clip = selected.length === 1 ? tl.clips.find((c) => c.id === selected[0]) : undefined;
  const media = doc.media.find((m) => m.id === clip?.mediaId);
  if (!clip || clip.fill || !media || (media.kind !== "video" && media.kind !== "audio")) {
    return (
      <Card title="Speed and freeze">
        <p className="text-[12px] text-gray-500">Select one video or audio clip to change its speed, reverse it, ramp it or freeze a frame.</p>
      </Card>
    );
  }
  const isVideo = media.kind === "video";
  const span = Math.abs(clip.sourceOut - clip.sourceIn);
  const ramped = !!clip.ramp?.keys.length;
  const edit = (patch: (c: Clip) => Partial<Clip>) => editTimeline((t) => retimeClips(t, [clip.id], patch));

  const setSpeed = (pct: number) => {
    const s = clampSpeed(pct / 100);
    edit((c) => ({ speed: s, ramp: undefined, duration: durationFor(Math.abs(c.sourceOut - c.sourceIn), s) }));
  };
  const setRamp = (ramp: Ramp | undefined) =>
    edit((c) => {
      if (!ramp) return { ramp: undefined, duration: durationFor(Math.abs(c.sourceOut - c.sourceIn), c.speed) };
      // the clip keeps its length; the source it shows is whatever the ramp covers
      const covered = rampSourceSpan(ramp, c.duration);
      return c.reverse ? { ramp, sourceIn: Math.max(0, Math.round((c.sourceOut - covered) * 1e6) / 1e6) } : { ramp, sourceOut: Math.round((c.sourceIn + covered) * 1e6) / 1e6 };
    });
  const flip = () =>
    edit((c) => ({ reverse: c.reverse ? undefined : true }));
  const run = async (where: "playhead" | "start" | "end") => {
    setBusy(true);
    setMsg("");
    try {
      setMsg(await freezeFrame(clip.id, where, getTime(), holdFor));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Freeze failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Speed and freeze" hint="Speed changes the clip's length and keeps the part of the source it shows. A ramp keeps the length and speeds up or slows down inside it.">
      {!ramped && (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Slider label="Speed" value={Math.round(clip.speed * 100)} min={1} max={800} unit="%" onChange={setSpeed} />
          </div>
          <input className="field !w-20 !py-0.5" type="number" min={1} max={10000} value={Math.round(clip.speed * 100)} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed percent" title="1% to 10000%" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-gray-300">
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!clip.reverse} onChange={flip} /> Reverse</label>
        <label className="flex items-center gap-1" title="Keep the pitch of the sound when the speed changes"><input type="checkbox" checked={clip.pitch !== false} onChange={(e) => edit(() => ({ pitch: e.target.checked ? undefined : false }))} /> Keep pitch</label>
      </div>
      {isVideo && (
        <label className="block">
          <span className="label">Slow motion frames</span>
          <select className="field" value={clip.interp ?? "nearest"} onChange={(e) => edit(() => ({ interp: e.target.value === "nearest" ? undefined : (e.target.value as "blend") }))}>
            <option value="nearest">Repeat the nearest frame</option>
            <option value="blend">Blend the frames around</option>
          </select>
        </label>
      )}
      <div className="space-y-1 border-t border-edge pt-2">
        <div className="flex items-center gap-1">
          <span className="flex-1 text-[12px] text-gray-300">Speed ramp</span>
          <select className="field !w-auto !py-0.5 text-[11px]" value="" onChange={(e) => { const p = RAMP_PRESETS.find((x) => x.id === e.target.value); if (p) setRamp(p.make(clip.duration, clip.speed)); }} aria-label="Ramp preset">
            <option value="">{ramped ? "Replace with..." : "Add a ramp..."}</option>
            {RAMP_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {ramped && <button className={btn} onClick={() => setRamp(undefined)}>Remove</button>}
        </div>
        {ramped && clip.ramp && (
          <>
            <label className="flex items-center gap-2 text-[12px] text-gray-300"><input type="checkbox" checked={clip.ramp.ease} onChange={(e) => setRamp({ ...clip.ramp!, ease: e.target.checked })} /> Ease in and out</label>
            <RampGraph ramp={clip.ramp} duration={clip.duration} />
            {clip.ramp.keys.map((k, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1 text-[11px] text-gray-400">
                <label>at <input className="field !w-16 !py-0.5" type="number" step={0.1} min={0} max={clip.duration} value={Math.round(k.t * 100) / 100} onChange={(e) => setRamp({ ...clip.ramp!, keys: clip.ramp!.keys.map((x, j) => (j === i ? { ...x, t: Math.max(0, Math.min(clip.duration, Number(e.target.value))) } : x)) })} /> s</label>
                <label>speed <input className="field !w-16 !py-0.5" type="number" min={1} max={10000} value={Math.round(k.speed * 100)} onChange={(e) => setRamp({ ...clip.ramp!, keys: clip.ramp!.keys.map((x, j) => (j === i ? { ...x, speed: clampSpeed(Number(e.target.value) / 100) } : x)) })} />%</label>
                <button className={btn} disabled={clip.ramp!.keys.length <= 2} onClick={() => setRamp({ ...clip.ramp!, keys: clip.ramp!.keys.filter((_, j) => j !== i) })} aria-label="Remove point">×</button>
              </div>
            ))}
            <button className={btn} onClick={() => { const r = clip.ramp!; const t = Math.max(0, Math.min(clip.duration, getTime() - clip.start)); setRamp({ ...r, keys: [...r.keys.filter((k) => Math.abs(k.t - t) > 0.05), { t, speed: r.keys[0]?.speed ?? 1 }].sort((a, b) => a.t - b.t) }); }}>Add a point at the playhead</button>
            <p className="text-[10px] text-gray-500">The sound of a ramped clip follows the speed and changes pitch.</p>
          </>
        )}
      </div>
      <div className="space-y-1 border-t border-edge pt-2">
        <div className="text-[12px] text-gray-300">Freeze and hold</div>
        <label className="flex items-center gap-2 text-[11px] text-gray-400">Still lasts <input className="field !w-16 !py-0.5" type="number" min={0.1} max={60} step={0.5} value={holdFor} onChange={(e) => setHoldFor(Number(e.target.value))} /> s</label>
        <div className="flex flex-wrap gap-1">
          <button className={btn} disabled={busy || !isVideo} onClick={() => run("playhead")}>Freeze at playhead</button>
          <button className={btn} disabled={busy || !isVideo} onClick={() => run("start")}>Hold first frame</button>
          <button className={btn} disabled={busy || !isVideo} onClick={() => run("end")}>Hold last frame</button>
          <button className={btn} onClick={() => downloadViewerFrame(scopeSource.canvas, `frame-${getTime().toFixed(2)}s`)}>Export still (PNG)</button>
        </div>
        {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
        <p className="text-[10px] text-gray-500">{span.toFixed(1)} s of source in this clip.</p>
      </div>
    </Card>
  );
}

/** The speed curve of a ramp over the clip. */
function RampGraph({ ramp, duration }: { ramp: Ramp; duration: number }) {
  const W = 160;
  const H = 50;
  const max = Math.max(1.5, ...ramp.keys.map((k) => k.speed));
  const keys = [...ramp.keys].sort((a, b) => a.t - b.t);
  const pts = Array.from({ length: 41 }, (_, i) => {
    const t = (i / 40) * duration;
    // reuse the clip's own curve rather than redoing the maths: evaluate between the keys
    let v = keys[0].speed;
    if (t >= keys[keys.length - 1].t) v = keys[keys.length - 1].speed;
    else if (t > keys[0].t) {
      const j = keys.findIndex((k) => k.t >= t);
      const f = (t - keys[j - 1].t) / (keys[j].t - keys[j - 1].t || 1);
      const g = ramp.ease ? f * f * (3 - 2 * f) : f;
      v = keys[j - 1].speed + (keys[j].speed - keys[j - 1].speed) * g;
    }
    return `${i ? "L" : "M"}${(i / 40) * W} ${H - (v / max) * (H - 4) - 2}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[240px] rounded-md border border-edge bg-black/30" role="img" aria-label="Speed over the clip">
      <line x1={0} x2={W} y1={H - (1 / max) * (H - 4) - 2} y2={H - (1 / max) * (H - 4) - 2} stroke="#ffffff22" strokeDasharray="3 3" />
      <path d={pts} fill="none" stroke="#60a5fa" strokeWidth={1.8} />
      {keys.map((k, i) => <circle key={i} cx={(k.t / duration) * W} cy={H - (k.speed / max) * (H - 4) - 2} r={3} fill="#0b0b0f" stroke="#60a5fa" />)}
    </svg>
  );
}
