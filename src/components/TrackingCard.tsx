import { useRef, useState } from "react";
import { Card, Slider } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { editTimeline, useTimelineUi } from "../timeline/ui";
import { trackClip, useTrackUi } from "../lib/track/run";
import type { Tracker } from "../lib/track/tracker";
import type { Clip } from "../model/types";

const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40";
let seq = 0;

/** Point tracker, pinning other clips to a tracked point, and stabilisation (phase 22). */
export default function TrackingCard() {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const pt = useTrackUi();
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const abort = useRef<AbortController | null>(null);
  const tl = activeTimeline(doc);
  const clip = selected.length === 1 ? tl.clips.find((c) => c.id === selected[0]) : undefined;
  const media = doc.media.find((m) => m.id === clip?.mediaId);
  const ok = !!clip && !clip.fill && (media?.kind === "video" || media?.kind === "image");
  if (!clip || !ok) {
    return (
      <Card title="Tracking">
        <p className="text-[12px] text-gray-500">Select one video clip to track a point in it, steady it, or pin a title to a moving object.</p>
      </Card>
    );
  }
  const patch = (p: Partial<Clip>) => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, ...p } : c)) }));
  const trackers = clip.trackers ?? [];
  const x = pt.clipId === clip.id ? pt.x : 0.5;
  const y = pt.clipId === clip.id ? pt.y : 0.5;
  const others = tl.clips.filter((c) => c.id !== clip.id && !c.fill && tl.tracks.find((t) => t.id === c.trackId)?.kind === "video");
  const label = (c: Clip) => c.name ?? doc.media.find((m) => m.id === c.mediaId)?.name ?? c.generator?.type ?? c.id;

  const run = async () => {
    setMsg("");
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(0);
    try {
      const r = await trackClip(useProject.getState().doc, clip.id, { x, y }, { signal: ctl.signal, onProgress: setBusy });
      if (r.samples.length > 1) {
        const tr: Tracker = { id: `tk-${Date.now().toString(36)}-${seq++}`, name: `Track ${trackers.length + 1}`, x, y, t0: 0, samples: r.samples };
        editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, trackers: [...(c.trackers ?? []), tr] } : c)) }));
      }
      setMsg(r.lost ? `${r.lost}. Kept ${r.samples.length} samples.` : `Tracked ${r.samples.length} frames.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Tracking failed");
    } finally {
      setBusy(null);
      abort.current = null;
    }
  };
  const pinned = tl.clips.filter((c) => c.follow?.clipId === clip.id);
  const stab = clip.stabilize;

  return (
    <Card title="Tracking" hint="Place the point on a detail with strong texture, then track. A tracker can pin another clip (a title) to it, drive a mask, or steady this clip.">
      <div className="grid grid-cols-2 gap-2">
        <Slider label="Point across" value={Math.round(x * 100)} min={0} max={100} unit="%" onChange={(v) => pt.set({ clipId: clip.id, x: v / 100, y })} />
        <Slider label="Point down" value={Math.round(y * 100)} min={0} max={100} unit="%" onChange={(v) => pt.set({ clipId: clip.id, x, y: v / 100 })} />
      </div>
      <div className="flex items-center gap-2">
        {busy === null ? (
          <button className={btn} disabled={media?.kind !== "video"} onClick={run}>Track from the clip start</button>
        ) : (
          <button className={btn} onClick={() => abort.current?.abort()}>Cancel ({Math.round(busy * 100)}%)</button>
        )}
        <button className={btn} onClick={() => pt.set({ clipId: pt.clipId === clip.id ? null : clip.id, x, y })} aria-pressed={pt.clipId === clip.id}>
          {pt.clipId === clip.id ? "Hide point" : "Show point"}
        </button>
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
      {trackers.map((tr) => (
        <div key={tr.id} className="space-y-1 rounded-md bg-black/20 p-1.5">
          <div className="flex items-center gap-1 text-[12px] text-gray-200">
            <span className="flex-1 truncate">{tr.name} ({tr.samples.length} frames)</span>
            <button className={btn} onClick={() => patch({ trackers: trackers.filter((t) => t.id !== tr.id), ...(stab?.trackerId === tr.id ? { stabilize: undefined } : {}) })} aria-label={`Delete ${tr.name}`}>×</button>
          </div>
          <label className="flex items-center gap-1 text-[11px] text-gray-400">
            Pin
            <select
              className="field !py-0.5 text-[11px]"
              value=""
              onChange={(e) => e.target.value && editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === e.target.value ? { ...c, follow: { clipId: clip.id, trackerId: tr.id } } : c)) }))}
              aria-label={`Pin a clip to ${tr.name}`}
            >
              <option value="">a clip to this point...</option>
              {others.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-gray-300">
            <input type="checkbox" checked={stab?.trackerId === tr.id} onChange={(e) => patch({ stabilize: e.target.checked ? { trackerId: tr.id, smoothing: 1, zoom: 3 } : undefined })} /> Stabilise this clip with it
          </label>
        </div>
      ))}
      {stab && (
        <>
          <Slider label="Smoothing" value={stab.smoothing} min={0} max={5} step={0.1} unit=" s" onChange={(v) => patch({ stabilize: { ...stab, smoothing: v } })} />
          <Slider label="Extra crop" value={stab.zoom} min={0} max={20} unit="%" onChange={(v) => patch({ stabilize: { ...stab, zoom: v } })} />
        </>
      )}
      {pinned.map((c) => (
        <div key={c.id} className="flex items-center gap-1 text-[11px] text-gray-400">
          <span className="flex-1 truncate">Pinned: {label(c)}</span>
          <button className={btn} onClick={() => editTimeline((t) => ({ ...t, clips: t.clips.map((x2) => (x2.id === c.id ? { ...x2, follow: undefined } : x2)) }))}>Unpin</button>
        </div>
      ))}
      {clip.follow && <p className="text-[11px] text-gray-500">This clip is pinned to a tracker of another clip.</p>}
    </Card>
  );
}
