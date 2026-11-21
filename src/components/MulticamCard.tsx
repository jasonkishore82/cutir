import { useEffect, useRef, useState } from "react";
import { Card } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline, beatsOf } from "../model/convert";
import { editTimeline, useTimelineUi, tlNow } from "../timeline/ui";
import * as C from "../timeline/compound";
import * as E from "../timeline/engine";
import { activeCut, addCut, angleColor, angleOf, crossfadeOf, removeCut, snapToBeats, montagePlan } from "../lib/multicam";
import { sourceAtRel } from "../lib/retime";
import { getTime, usePlayback } from "../lib/transport";
import { liveFrames } from "../render/sources";
import { useMedia } from "../store/media";
import { lagInWorker, syncSignal } from "../lib/syncAudio";
import { SYNC_RATE, formatTimecode, measureDrift, parseTimecode } from "../lib/sync";
import type { Clip, MulticamSpec } from "../model/types";

const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40";
const urlOf = (doc: { media: { id: string; poolId?: string }[] }, mediaId: string) => {
  const pool = doc.media.find((m) => m.id === mediaId)?.poolId;
  return pool ? useMedia.getState().urls[pool] : undefined;
};
type Mode = "both" | "video" | "audio";

/** A media item's start timecode: the one typed by hand, else the one read from the file. */
const timecodeOf = (doc: { media: { id: string; poolId?: string; timecode?: number }[] }, mediaId: string | undefined): number | undefined => {
  const m = doc.media.find((x) => x.id === mediaId);
  return m?.timecode ?? (m?.poolId ? useMedia.getState().items.find((i) => i.id === m.poolId)?.timecode : undefined);
};

/** Sync, multicam and beat montage (phase 24). */
export default function MulticamCard() {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [useAudio, setUseAudio] = useState(true);
  const [per, setPer] = useState(4);
  const tl = activeTimeline(doc);
  const picked = selected.map((id) => tl.clips.find((c) => c.id === id)).filter((c): c is Clip => !!c && !c.fill && !!c.mediaId);
  const kindOf = (c: Clip) => doc.media.find((m) => m.id === c.mediaId)?.kind;
  const videos = picked.filter((c) => kindOf(c) === "video");
  const sounds = picked.filter((c) => kindOf(c) === "audio");
  const multi = selected.length === 1 ? tl.clips.find((c) => c.id === selected[0] && c.multicam) : undefined;
  const beats = beatsOf(tl).map((b) => b.time);

  /* ---- sync ---- */
  const syncAudio = async () => {
    if (picked.length < 2) return setMsg("Select two or more clips; the first selected is the anchor the others line up with.");
    setBusy(true);
    setMsg("Listening...");
    try {
      const anchor = picked[0];
      const aUrl = urlOf(doc, anchor.mediaId!);
      if (!aUrl) throw new Error("The anchor clip has no sound to read.");
      const a = await syncSignal(aUrl);
      const lags: { clipId: string; lag: number }[] = [];
      const weak: string[] = [];
      for (const c of picked.slice(1)) {
        const url = urlOf(doc, c.mediaId!);
        if (!url) continue;
        const r = await lagInWorker(a, await syncSignal(url));
        lags.push({ clipId: c.id, lag: r.lag });
        if (r.confidence < 5) weak.push(c.name ?? doc.media.find((m) => m.id === c.mediaId)?.name ?? c.id);
      }
      editTimeline((t) => C.applySync(t, anchor.id, lags));
      setMsg(`Synced ${lags.length} clip${lags.length === 1 ? "" : "s"} to ${anchor.name ?? "the anchor"} and linked them.${weak.length ? ` Weak match (check by ear): ${weak.join(", ")}.` : ""}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  };
  const fixDrift = async () => {
    if (picked.length < 2) return setMsg("Select the clips that are already synced; the first selected is the anchor the others are measured against.");
    setBusy(true);
    setMsg("Measuring drift along the recordings...");
    try {
      const anchor = picked[0];
      const signals = new Map<string, Float32Array>();
      const signal = async (mediaId: string) => {
        let s = signals.get(mediaId);
        if (!s) {
          const url = urlOf(doc, mediaId);
          if (!url) throw new Error("A clip has no sound to read.");
          signals.set(mediaId, (s = await syncSignal(url)));
        }
        return s;
      };
      const a = await signal(anchor.mediaId!);
      const done: string[] = [];
      const skipped: string[] = [];
      const fixes: { id: string; speed: number }[] = [];
      for (const c of picked.slice(1)) {
        const name = c.name ?? doc.media.find((m) => m.id === c.mediaId)?.name ?? c.id;
        const b = await signal(c.mediaId!);
        const first = await lagInWorker(a, b);
        const d = await measureDrift(a, b, SYNC_RATE, first.lag, lagInWorker);
        if (!d.reliable) skipped.push(`${name} (too short or too uneven to measure)`);
        else if (Math.abs(d.total) < 0.02) skipped.push(`${name} (${Math.round(d.total * 1000)} ms over its length, fine as it is)`);
        else {
          fixes.push({ id: c.id, speed: d.speed });
          done.push(`${name} ${d.ppm >= 0 ? "ran slow" : "ran fast"} by ${Math.abs(Math.round(d.ppm))} ppm (${d.total >= 0 ? "+" : "-"}${Math.abs(d.total).toFixed(2)} s over the clip)`);
        }
      }
      if (fixes.length) editTimeline((t) => fixes.reduce((acc, f) => C.applyDrift(acc, f.id, f.speed), t));
      setMsg(`${done.length ? `Corrected: ${done.join("; ")}. ` : "Nothing needed correcting. "}${skipped.length ? `Left alone: ${skipped.join("; ")}.` : ""}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not measure drift");
    } finally {
      setBusy(false);
    }
  };
  const syncMarkers = () => {
    const anchor = picked[0];
    const mark = (c: Clip) => tl.markers.filter((m) => m.clipId === c.id).sort((x, y) => x.time - y.time)[0];
    const am = anchor && mark(anchor);
    if (!am) return setMsg("Put a marker on each clip (on the clip, at the clap) first; the first selected clip is the anchor.");
    const moves = picked.slice(1).map((c) => ({ c, m: mark(c) })).filter((x) => x.m);
    if (!moves.length) return setMsg("The other clips have no marker.");
    editTimeline((t) => ({ ...t, clips: t.clips.map((c) => { const mv = moves.find((x) => x.c.id === c.id); return mv ? { ...c, start: Math.max(0, c.start + (am.time - mv.m!.time)) } : c; }) }));
    setMsg(`Moved ${moves.length} clip${moves.length === 1 ? "" : "s"} so their markers meet the anchor's.`);
  };
  const syncTimecode = () => {
    const anchor = picked[0];
    const tcOf = (c: Clip) => timecodeOf(doc, c.mediaId);
    const a = anchor && tcOf(anchor);
    if (a === undefined) return setMsg("Enter a start timecode for each clip's media below first.");
    const lags = picked.slice(1).flatMap((c) => (tcOf(c) === undefined ? [] : [{ clipId: c.id, lag: tcOf(c)! - a }]));
    if (!lags.length) return setMsg("The other clips have no timecode.");
    editTimeline((t) => C.applySync(t, anchor.id, lags));
    setMsg(`Synced ${lags.length} clip${lags.length === 1 ? "" : "s"} by timecode.`);
  };

  /* ---- create multicam ---- */
  const create = () => {
    if (videos.length < 2) return setMsg("Select two or more video clips (already synced) to make angles.");
    const t0 = Math.min(...videos.map((c) => c.start));
    const end = Math.max(...videos.map((c) => E.clipEnd(c)));
    // multicam time zero is the earliest start; an angle's source time = multicam time + (t0 - start + sourceIn)
    const offsetOf = (c: Clip) => Math.round((t0 - c.start + c.sourceIn) * 1000) / 1000;
    const sound = useAudio ? sounds[0] : undefined;
    let ok: { clipId: string } | null = null;
    useProject.getState().editDoc((d) => {
      const r = C.makeMulticam(d, videos.map((c, i) => ({ mediaId: c.mediaId!, name: c.name ?? doc.media.find((m) => m.id === c.mediaId)?.name ?? `Angle ${i + 1}`, offset: offsetOf(c) })), t0, end - t0, videos[0].trackId, sound ? { mediaId: sound.mediaId!, offset: offsetOf(sound) } : undefined);
      if (!r) return d;
      ok = r;
      const gone = new Set([...videos.map((c) => c.id), ...(sound ? [sound.id] : [])]);
      return E.onActive(r.doc, (t) => ({ ...t, clips: t.clips.filter((c) => !gone.has(c.id)) }));
    });
    if (ok) {
      useTimelineUi.setState({ selected: [(ok as { clipId: string }).clipId] });
      setMsg(`Made a multicam clip of ${videos.length} angles. Play it and press 1 to ${videos.length} to cut between them.`);
    } else setMsg("The multicam clip could not be made (is the video track locked?).");
  };

  /* ---- montage ---- */
  const montage = () => {
    if (beats.length < per + 1) return setMsg("No beat markers on the timeline yet. Analyse the song's beats first (Media tab).");
    const pool = (videos.length ? videos.map((c) => c.mediaId!) : doc.media.filter((m) => m.kind === "video").map((m) => m.id)).filter((id, i, a) => a.indexOf(id) === i);
    const sources = pool.map((id) => ({ mediaId: id, duration: doc.media.find((m) => m.id === id)?.duration ?? 0 })).filter((s) => s.duration > 0);
    if (!sources.length) return setMsg("Add video to the media pool, or select the clips to use.");
    const plan = montagePlan(beats, sources, { beatsPerCut: per, from: tl.inPoint, to: tl.outPoint });
    if (!plan.length) return setMsg("The sources are too short for the beat spacing.");
    const video = (E.targetTrack(tl, "video") ?? tl.tracks.find((t) => t.kind === "video"))?.id;
    const audio = (E.targetTrack(tl, "audio") ?? tl.tracks.find((t) => t.kind === "audio"))?.id;
    if (!video) return setMsg("There is no video track.");
    editTimeline((t) => plan.reduce((acc, cut) => {
      const m = doc.media.find((x) => x.id === cut.mediaId)!;
      const src: E.Source = { mediaId: cut.mediaId, name: m.name, kind: "video", in: cut.sourceIn, out: cut.sourceIn + cut.duration };
      return E.overwriteEdit(acc, src, cut.start, { video }).tl;
    }, t));
    void audio;
    setMsg(`Placed ${plan.length} clips, one every ${per} beats, cut on the beat. It is a starting point: trim and reorder as usual.`);
  };

  return (
    <Card title="Sync and multicam" hint="Sync clips from different cameras and recorders, combine them as angles, then cut between them while it plays.">
      <div className="space-y-1">
        <div className="text-[12px] text-gray-300">Sync selected clips</div>
        <div className="flex flex-wrap gap-1">
          <button className={btn} disabled={busy || picked.length < 2} onClick={syncAudio}>By audio</button>
          <button className={btn} disabled={picked.length < 2} onClick={syncMarkers}>By marker</button>
          <button className={btn} disabled={picked.length < 2} onClick={syncTimecode}>By timecode</button>
          <button className={btn} disabled={busy || picked.length < 2} onClick={fixDrift} title="For long recordings: measures how far a recorder's clock has wandered from the anchor's and plays the clip slightly faster or slower to match">Correct drift</button>
        </div>
        {picked.map((c) => {
          const m = doc.media.find((x) => x.id === c.mediaId)!;
          return (
            <label key={c.id} className="flex items-center gap-1 text-[11px] text-gray-400">
              <span className="w-24 truncate" title={m.name}>{m.name}</span>
              <input className="field !w-28 !py-0.5" placeholder="hh:mm:ss:ff" key={`${m.id}:${timecodeOf(doc, m.id) ?? ""}`} defaultValue={timecodeOf(doc, m.id) !== undefined ? formatTimecode(timecodeOf(doc, m.id)!, doc.settings.fps) : ""} onBlur={(e) => { const v = e.target.value.trim() === "" ? undefined : parseTimecode(e.target.value, doc.settings.fps); if (v !== null) useProject.getState().editDoc((d) => ({ ...d, media: d.media.map((x) => (x.id === m.id ? { ...x, timecode: v } : x)) })); }} aria-label={`Start timecode of ${m.name}`} />
            </label>
          );
        })}
        <p className="text-[10px] text-gray-500">The first selected clip stays; the others move to line up with it and are linked to it. Timecode is read from the file when it has one (camera MP4 and MOV, field-recorder WAV); type it otherwise.</p>
      </div>
      <div className="space-y-1 border-t border-edge pt-2">
        <div className="text-[12px] text-gray-300">Multicam</div>
        <div className="flex flex-wrap items-center gap-2">
          <button className={btn} disabled={videos.length < 2} onClick={create}>Make multicam from selected</button>
          <label className="flex items-center gap-1 text-[11px] text-gray-400"><input type="checkbox" checked={useAudio} onChange={(e) => setUseAudio(e.target.checked)} disabled={!sounds.length} /> Use the selected audio clip as the sound</label>
        </div>
      </div>
      {multi && <AngleViewer clip={multi} beats={beats} />}
      <div className="space-y-1 border-t border-edge pt-2">
        <div className="text-[12px] text-gray-300">Beat montage</div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
          Cut every
          <select className="field !w-auto !py-0.5" value={per} onChange={(e) => setPer(Number(e.target.value))} aria-label="Beats per cut">
            {[1, 2, 4, 8].map((n) => <option key={n} value={n}>{n} beat{n > 1 ? "s" : ""}</option>)}
          </select>
          <button className={btn} onClick={montage}>Assemble from the beats</button>
        </div>
        <p className="text-[10px] text-gray-500">{beats.length ? `${beats.length} beats found. Uses the selected video clips, or all video in the pool, within the in and out points if set.` : "Needs beat markers (analyse the song first)."}</p>
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
    </Card>
  );
}

/** The angle viewer: every angle live in a grid, click or number keys to cut, record while playing, edit the cuts afterwards. */
function AngleViewer({ clip, beats }: { clip: Clip; beats: number[] }) {
  const spec = clip.multicam!;
  const doc = useProject((s) => s.doc);
  const tracks = activeTimeline(doc).tracks;
  const [mode, setMode] = useState<Mode>("both");
  const [snap, setSnap] = useState(true);
  const playing = usePlayback((s) => s.playing);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const [now, setNow] = useState(0);

  // multicam time of the playhead, and which angle is on
  const mtNow = (t = getTime()) => sourceAtRel(clip, Math.max(0, Math.min(clip.duration, t - clip.start)));
  const live = !!(getTime() >= clip.start && getTime() < clip.start + clip.duration);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = getTime();
      const mt = mtNow(t);
      const frames = liveFrames(usePlayback.getState().playing);
      spec.angles.forEach((a, i) => {
        const cv = canvases.current[i];
        if (!cv) return;
        const pic = frames.picture(a.mediaId, "video", Math.max(0, mt + a.offset));
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        if (pic) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, cv.width, cv.height);
          const s = Math.min(cv.width / pic.width, cv.height / pic.height);
          ctx.drawImage(pic, (cv.width - pic.width * s) / 2, (cv.height - pic.height * s) / 2, pic.width * s, pic.height * s);
        }
      });
      setNow((n) => (Math.abs(n - t) > 0.05 ? t : n));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip]);

  const set = (next: MulticamSpec) => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, multicam: next } : c)) }));
  const cutTo = (angleId: string) => {
    const t = getTime();
    if (t < clip.start || t >= clip.start + clip.duration) return;
    // a cut near a beat lands on it
    const tt = snap ? snapToBeats(t, beats, 0.12) : t;
    const mt = Math.max(clip.sourceIn, sourceAtRel(clip, Math.max(0, tt - clip.start)));
    const cur = activeCut(spec, mt);
    const video = mode === "audio" ? cur.video : angleId;
    const audio = mode === "video" ? cur.audio ?? cur.video : mode === "audio" ? angleId : undefined;
    // while playing it records over what follows; paused, it only inserts a cut
    set(addCut(spec, mt, video, audio, usePlayback.getState().playing));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= spec.angles.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        cutTo(spec.angles[n - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const current = live ? activeCut(spec, mtNow()) : null;
  void now;

  return (
    <div className="space-y-2 rounded-lg border border-edge p-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
        <span className="text-[12px] text-gray-300">Angles</span>
        <select className="field !w-auto !py-0.5" value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="Switch what">
          <option value="both">Switch video and audio</option>
          <option value="video">Switch video only</option>
          <option value="audio">Switch audio only</option>
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap to beats</label>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {spec.angles.map((a, i) => (
          <button key={a.id} onClick={() => cutTo(a.id)} className={`relative overflow-hidden rounded-md border ${current?.video === a.id ? "border-red-500" : "border-edge"} ${current && (current.audio ?? current.video) === a.id ? "ring-1 ring-green-500" : ""}`} aria-label={`Cut to ${a.name}`} aria-pressed={current?.video === a.id}>
            <canvas ref={(el) => { canvases.current[i] = el; }} width={160} height={90} className="block w-full bg-black" />
            <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white">{i + 1} {a.name}</span>
          </button>
        ))}
      </div>
      <p className="text-[10px] text-gray-500">{playing ? "Recording: each cut replaces what came after it." : "Paused: a cut is added at the playhead."} Click an angle or press its number.</p>
      <div className="space-y-1">
        {spec.cuts.map((c, i) => (
          <div key={i} className="flex items-center gap-1 text-[11px] text-gray-300">
            <CutThumb spec={spec} cut={c} />
            <input className="field !w-16 !py-0.5" type="number" step={0.1} min={0} value={Math.round(c.t * 100) / 100} onChange={(e) => set({ ...spec, cuts: spec.cuts.map((x, j) => (j === i ? { ...x, t: Math.max(0, Number(e.target.value)) } : x)).sort((a, b) => a.t - b.t) })} aria-label="Cut time" />
            <select className="field !py-0.5" value={c.video} onChange={(e) => set({ ...spec, cuts: spec.cuts.map((x, j) => (j === i ? { ...x, video: e.target.value } : x)) })} aria-label="Video angle">
              {spec.angles.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select className="field !py-0.5" value={c.audio ?? ""} onChange={(e) => set({ ...spec, cuts: spec.cuts.map((x, j) => { if (j !== i) return x; const { audio: _a, ...rest } = x; return e.target.value ? { ...rest, audio: e.target.value } : rest; }) })} aria-label="Sound from" title="Whose sound plays during this cut">
              <option value="">sound: with picture</option>
              {spec.angles.map((a) => <option key={a.id} value={a.id}>sound: {a.name}</option>)}
            </select>
            <button className={btn} aria-label="Remove cut" onClick={() => set(removeCut(spec, i))}>×</button>
          </div>
        ))}
        {!spec.cuts.length && <p className="text-[11px] text-gray-500">No cuts yet: it shows {angleOf(spec, undefined)?.name}.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
        <label className="flex items-center gap-1">Sound through
          <select className="field !w-auto !py-0.5" value={spec.audioTrackId ?? ""} onChange={(e) => set({ ...spec, audioTrackId: e.target.value || undefined })} aria-label="Audio track for the multicam sound">
            <option value="">first audio track</option>
            {tracks.filter((t) => t.kind === "audio").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1" title="When the sound changes from one source to another it fades over this long instead of jumping">Crossfade
          <input className="field !w-14 !py-0.5" type="number" min={0} max={2} step={0.05} value={Math.round(crossfadeOf(spec) * 100) / 100} onChange={(e) => set({ ...spec, crossfade: Math.max(0, Math.min(2, Number(e.target.value) || 0)) })} aria-label="Crossfade seconds" /> s
        </label>
      </div>
      <div className="flex flex-wrap gap-1">
        <button className={btn} disabled={!spec.cuts.length} onClick={() => set({ ...spec, cuts: [] })}>Clear cuts</button>
        <button className={btn} onClick={() => { const next = C.commitMulticam(doc, clip.id); if (next) useProject.getState().editDoc(() => next); }} title="Replace this clip by ordinary clips, one per cut, to trim and move like any others">Convert cuts to clips</button>
      </div>
    </div>
  );
}

/** A small still of the angle a cut switches to, taken at the cut. It fills in once the frame has loaded. */
function CutThumb({ spec, cut }: { spec: MulticamSpec; cut: { t: number; video: string } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const a = angleOf(spec, cut.video);
  useEffect(() => {
    let tries = 0;
    let done = false;
    const draw = () => {
      const cv = ref.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx || !a) return true;
      const pic = liveFrames(false).picture(a.mediaId, "video", Math.max(0, cut.t + a.offset));
      if (!pic) return false;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cv.width, cv.height);
      const s = Math.min(cv.width / pic.width, cv.height / pic.height);
      ctx.drawImage(pic, (cv.width - pic.width * s) / 2, (cv.height - pic.height * s) / 2, pic.width * s, pic.height * s);
      return true;
    };
    if (draw()) return;
    const id = setInterval(() => { if (done || draw() || ++tries > 20) (done = true), clearInterval(id); }, 300);
    return () => { done = true; clearInterval(id); };
  }, [a?.mediaId, a?.offset, cut.t]);
  return <canvas ref={ref} width={48} height={27} className="h-[27px] w-12 shrink-0 rounded-sm bg-black" style={{ outline: `2px solid ${angleColor(spec, cut.video)}` }} aria-label={`${a?.name ?? "Angle"} at the cut`} />;
}

void tlNow;
