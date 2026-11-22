import { useEffect, useRef, useState } from "react";
import { Card, Slider } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import type { Clip, MasterStrip, Track } from "../model/types";
import { editTimeline, tlNow, useTimelineUi, withPoolMedia, poolMediaId } from "../timeline/ui";
import * as E from "../timeline/engine";
import { getTime, usePlayback } from "../lib/transport";
import { useMedia } from "../store/media";
import { setKey, type Key } from "../lib/keyframes/engine";
import { PROCESSORS, detectSilence, dbToGain, gainToDb, keepRanges, normalizeGain, processorDefaults, type AudioProcessor, type ProcessorType } from "../lib/audio/dsp";
import { LOUDNESS_TARGETS, matchGain, measureLoudness, type Loudness } from "../lib/audio/loudness";
import { mixInputs, mixPlan, mixdownChannels } from "../render/audio";
import { mixer } from "./Preview";
import { bestTake, newTakeGroup, nextTakeNumber, swapTake, tagClip, takesInGroup } from "../lib/takes";

const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40";
const fmtDb = (v: number) => (isFinite(v) ? `${v.toFixed(1)}` : "-inf");
let seq = 0;

/** The Audio tab (phase 21): mixer strips with meters, processors, clip tools, loudness and voice-over. */
export default function AudioPanel() {
  return (
    <>
      <Mixer />
      <ClipTools />
      <Loudness />
      <VoiceOver />
    </>
  );
}

/* ---------- mixer ---------- */

const setTrack = (id: string, patch: Partial<Track>, key?: string) => editTimeline((t) => E.setTrack(t, id, patch), key);

/** Edit a track's gain; tracks in the same group follow by the same ratio. */
function setGain(tracks: Track[], t: Track, gain: number) {
  const ratio = (t.gain ?? 1) > 0.001 ? gain / (t.gain ?? 1) : 1;
  editTimeline(
    (tl) => ({ ...tl, tracks: tl.tracks.map((x) => (x.id === t.id ? { ...x, gain } : t.group && x.group === t.group && x.kind === "audio" ? { ...x, gain: Math.max(0, Math.min(4, (x.gain ?? 1) * ratio)) } : x)) }),
    `gain:${t.id}`
  );
  void tracks;
}

function Meter({ get }: { get: () => { peak: number; hold: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { peak, hold: h } = get();
      const pos = (v: number) => Math.max(0, Math.min(1, (gainToDb(v) + 60) / 60));
      if (ref.current) ref.current.style.width = `${pos(peak) * 100}%`;
      if (hold.current) hold.current.style.left = `${pos(h) * 100}%`;
      if (clip.current) clip.current.style.opacity = h >= 1 ? "1" : "0.15";
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [get]);
  return (
    <div className="flex items-center gap-1" aria-hidden>
      <div className="relative h-2 flex-1 overflow-hidden rounded bg-black/50">
        <div ref={ref} className="h-full bg-gradient-to-r from-green-500 via-yellow-400 to-red-500" style={{ width: 0 }} />
        <div ref={hold} className="absolute top-0 h-full w-0.5 bg-white" />
      </div>
      <div ref={clip} className="h-2 w-2 rounded-full bg-red-500" style={{ opacity: 0.15 }} title="Clip warning: the level reached 0 dBFS" />
    </div>
  );
}

/** A meter source with peak hold (the hold falls 20 dB a second) and a clip latch. */
function useMeter(read: () => number) {
  const st = useRef({ peak: 0, hold: 0, at: 0 });
  return useRef(() => {
    const now = performance.now();
    const v = read();
    const s = st.current;
    const dt = Math.min(0.2, (now - s.at) / 1000);
    s.at = now;
    s.peak = Math.max(v, s.peak * Math.pow(0.1, dt * 2)); // quick fall
    s.hold = v >= s.hold ? v : s.hold * Math.pow(0.1, dt); // slower fall
    return { peak: s.peak, hold: s.hold };
  }).current;
}

function TrackMeter({ id }: { id: string }) {
  const get = useMeter(() => mixer.levels().tracks.get(id)?.peak ?? 0);
  return <Meter get={get} />;
}

function Mixer() {
  const doc = useProject((s) => s.doc);
  const tl = activeTimeline(doc);
  const audio = tl.tracks.filter((t) => t.kind === "audio");
  const master: MasterStrip = tl.master ?? { gainDb: 0 };
  const setMaster = (patch: Partial<MasterStrip>, key?: string) => editTimeline((t) => ({ ...t, master: { ...(t.master ?? { gainDb: 0 }), ...patch } }), key);
  const masterGet = useMeter(() => mixer.levels().master.peak);

  const keyAt = (t: Track, lane: "gain" | "pan", v: number) =>
    editTimeline((x) => ({ ...x, tracks: x.tracks.map((y) => (y.id === t.id ? { ...y, anim: { ...(y.anim ?? {}), [lane]: setKey(y.anim?.[lane] as Key[] | undefined, getTime(), v) } } : y)) }));

  return (
    <Card title="Mixer" hint="Gain, pan and meters per audio track, then the master. Every processor is heard live and applied the same way in the export and the loudness measure.">
      {audio.length === 0 && <p className="text-[12px] text-gray-500">No audio tracks.</p>}
      {audio.map((t) => (
        <div key={t.id} className="space-y-1 rounded-lg border border-edge p-2">
          <div className="flex items-center justify-between gap-1">
            <span className="truncate text-[12px] text-gray-200" title={t.name}>{t.name}</span>
            <span className="flex gap-0.5">
              <button className={`${btn} ${t.muted ? "!bg-accent/25 !text-accent" : ""}`} aria-pressed={t.muted} onClick={() => setTrack(t.id, { muted: !t.muted })}>M</button>
              <button className={`${btn} ${t.solo ? "!bg-accent/25 !text-accent" : ""}`} aria-pressed={t.solo} onClick={() => setTrack(t.id, { solo: !t.solo })}>S</button>
            </span>
          </div>
          <TrackMeter id={t.id} />
          <Slider label="Gain" value={Math.round(gainToDb(t.gain ?? 1) * 10) / 10} min={-60} max={12} step={0.5} unit=" dB" onChange={(v) => setGain(audio, t, v <= -60 ? 0 : dbToGain(v))} />
          <Slider label="Pan" value={Math.round((t.pan ?? 0) * 100)} min={-100} max={100} onChange={(v) => setTrack(t.id, { pan: v / 100 }, `pan:${t.id}`)} />
          <Slider label="Reverb send" value={Math.round((t.send ?? 0) * 100)} min={0} max={100} unit="%" onChange={(v) => setTrack(t.id, { send: v / 100 }, `send:${t.id}`)} />
          <div className="flex flex-wrap items-center gap-1">
            <button className={btn} title="Add a gain keyframe at the playhead" onClick={() => keyAt(t, "gain", t.gain ?? 1)}>Key gain</button>
            <button className={btn} title="Add a pan keyframe at the playhead" onClick={() => keyAt(t, "pan", t.pan ?? 0)}>Key pan</button>
            {(t.anim?.gain?.length || t.anim?.pan?.length) && <button className={btn} onClick={() => setTrack(t.id, { anim: undefined })}>Clear automation</button>}
            <input className="field !w-24 !py-0.5 text-[11px]" placeholder="Group" value={t.group ?? ""} onChange={(e) => setTrack(t.id, { group: e.target.value || undefined }, `grp:${t.id}`)} aria-label="Track group" title="Tracks in the same group move their gain together" />
          </div>
          <Processors list={t.processors} onChange={(processors) => setTrack(t.id, { processors })} />
        </div>
      ))}
      <div className="space-y-1 rounded-lg border border-accent/40 p-2">
        <div className="text-[12px] text-gray-200">Master</div>
        <Meter get={masterGet} />
        <Slider label="Gain" value={Math.round(master.gainDb * 10) / 10} min={-24} max={12} step={0.5} unit=" dB" onChange={(v) => setMaster({ gainDb: v }, "master-gain")} />
        <label className="flex items-center gap-2 text-[12px] text-gray-300">
          <input type="checkbox" checked={master.ceiling !== undefined} onChange={(e) => setMaster({ ceiling: e.target.checked ? -1 : undefined })} />
          Limit the peak to
          <input type="number" className="field !w-16 !py-0.5" disabled={master.ceiling === undefined} min={-12} max={0} step={0.5} value={master.ceiling ?? -1} onChange={(e) => setMaster({ ceiling: Number(e.target.value) })} /> dB
        </label>
        <Processors list={master.processors} onChange={(processors) => setMaster({ processors })} />
      </div>
    </Card>
  );
}

function Processors({ list, onChange }: { list?: AudioProcessor[]; onChange: (l: AudioProcessor[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = list ?? [];
  const set = (id: string, patch: Partial<AudioProcessor>) => onChange(items.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-1">
      {items.map((p) => {
        const def = PROCESSORS[p.type];
        return (
          <div key={p.id} className="rounded-md bg-black/20 p-1.5">
            <div className="flex items-center gap-1">
              <input type="checkbox" checked={p.enabled} onChange={(e) => set(p.id, { enabled: e.target.checked })} aria-label={`${def.name} on`} />
              <button className="flex-1 truncate text-left text-[11px] text-gray-200" onClick={() => setOpen(open === p.id ? null : p.id)}>
                {def.name}{def.live ? "" : " (export)"}
              </button>
              <button className={btn} onClick={() => onChange(items.filter((x) => x.id !== p.id))} aria-label={`Remove ${def.name}`}>×</button>
            </div>
            {open === p.id && def.params.map((s) => (
              <Slider key={s.key} label={s.label} value={p.params[s.key] ?? s.default} min={s.min} max={s.max} step={s.max - s.min > 50 ? 1 : 0.1} unit={s.unit ? ` ${s.unit}` : ""} onChange={(v) => set(p.id, { params: { ...p.params, [s.key]: v } })} />
            ))}
          </div>
        );
      })}
      <select className="field !py-0.5 text-[11px]" value="" onChange={(e) => e.target.value && onChange([...items, { id: `ap-${Date.now().toString(36)}-${seq++}`, type: e.target.value as ProcessorType, enabled: true, params: processorDefaults(e.target.value as ProcessorType) }])} aria-label="Add a processor">
        <option value="">+ Add processor</option>
        {(Object.keys(PROCESSORS) as ProcessorType[]).map((k) => (
          <option key={k} value={k}>{PROCESSORS[k].name}</option>
        ))}
      </select>
    </div>
  );
}

/* ---------- decoding ---------- */

async function decodeClip(clip: Clip): Promise<{ ch: Float32Array[]; sr: number } | null> {
  const doc = useProject.getState().doc;
  const media = doc.media.find((m) => m.id === clip.mediaId);
  const url = media?.poolId ? useMedia.getState().urls[media.poolId] : undefined;
  if (!url) return null;
  try {
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const from = Math.floor(clip.sourceIn * buf.sampleRate);
    const to = Math.min(buf.length, Math.ceil(clip.sourceOut * buf.sampleRate));
    return { ch: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(from, to)), sr: buf.sampleRate };
  } catch {
    return null;
  }
}

/* ---------- clip tools ---------- */

function ClipTools() {
  const selected = useTimelineUi((s) => s.selected);
  const doc = useProject((s) => s.doc);
  const tl = activeTimeline(doc);
  const clip = selected.length === 1 ? tl.clips.find((c) => c.id === selected[0]) : undefined;
  const isAudio = !!clip && !clip.fill && doc.media.find((m) => m.id === clip.mediaId)?.kind === "audio";
  const [target, setTarget] = useState(-1);
  const [thr, setThr] = useState(-45);
  const [minLen, setMinLen] = useState(0.4);
  const [found, setFound] = useState<[number, number][] | null>(null);
  const [busy, setBusy] = useState("");
  if (!clip || !isAudio) {
    return (
      <Card title="Audio clip">
        <p className="text-[12px] text-gray-500">Select one audio clip on the timeline to fade, reverse, normalize it or remove its silences.</p>
      </Card>
    );
  }
  const patch = (p: Partial<Clip>, key?: string) => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, ...p } : c)) }), key);
  const len = clip.duration;

  const normalize = async () => {
    setBusy("Measuring");
    const d = await decodeClip(clip);
    setBusy("");
    if (!d) return;
    patch({ volume: Math.min(2, Math.max(0, (clip.volume ?? 1) * normalizeGain(d.ch, target))) });
  };
  const scan = async () => {
    setBusy("Listening");
    const d = await decodeClip(clip);
    setBusy("");
    if (!d) return;
    const mono = Float32Array.from(d.ch[0], (v, i) => (d.ch.length > 1 ? (v + d.ch[1][i]) / 2 : v));
    // source seconds -> timeline seconds
    setFound(detectSilence(mono, d.sr, thr, minLen).map(([a, b]) => [clip.start + a / clip.speed, clip.start + b / clip.speed]));
  };
  const cut = () => {
    if (!found?.length) return;
    const keep = keepRanges(found.map(([a, b]) => [a - clip.start, b - clip.start]), len, 0.08);
    // remove the gaps between kept ranges, last first so earlier times stay valid
    const gaps: [number, number][] = [];
    for (let i = 1; i < keep.length; i++) gaps.push([clip.start + keep[i - 1][1], clip.start + keep[i][0]]);
    if (keep.length && keep[0][0] > 0) gaps.unshift([clip.start, clip.start + keep[0][0]]);
    const linkedTracks = [...new Set(E.withLinked(tlNow(), [clip.id]).map((id) => tlNow().clips.find((c) => c.id === id)?.trackId).filter((x): x is string => !!x))];
    editTimeline((t) => gaps.filter(([a, b]) => b > a + 0.01).sort((x, y) => y[0] - x[0]).reduce((acc, [a, b]) => E.extractRange(acc, a, b, linkedTracks), t));
    setFound(null);
  };

  return (
    <Card title="Audio clip" hint="Fades, reverse and level for the selected clip. Reverse is heard in the export and the loudness measure.">
      <Slider label="Fade in" value={Math.round((clip.fadeIn ?? 0) * 100) / 100} min={0} max={Math.max(0.1, len / 2)} step={0.05} unit=" s" onChange={(v) => patch({ fadeIn: v || undefined }, `fi:${clip.id}`)} />
      <Slider label="Fade out" value={Math.round((clip.fadeOut ?? 0) * 100) / 100} min={0} max={Math.max(0.1, len / 2)} step={0.05} unit=" s" onChange={(v) => patch({ fadeOut: v || undefined }, `fo:${clip.id}`)} />
      <Slider label="Clip gain" value={Math.round(gainToDb(clip.volume ?? 1) * 10) / 10} min={-30} max={6} step={0.5} unit=" dB" onChange={(v) => patch({ volume: v <= -30 ? 0 : dbToGain(v) }, `cg:${clip.id}`)} />
      <label className="flex items-center gap-2 text-[12px] text-gray-300">
        <input type="checkbox" checked={!!clip.reverse} onChange={(e) => patch({ reverse: e.target.checked || undefined })} /> Reverse
      </label>
      <div className="flex flex-wrap items-center gap-1">
        <button className={btn} disabled={!!busy} onClick={normalize}>Normalize to</button>
        <input type="number" className="field !w-16 !py-0.5" min={-24} max={0} step={0.5} value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Normalize peak target" /> dB peak
        {busy && <span className="text-[11px] text-gray-500">{busy}...</span>}
      </div>
      <div className="space-y-1 border-t border-edge pt-2">
        <div className="text-[12px] text-gray-300">Remove silence</div>
        <Slider label="Silence below" value={thr} min={-70} max={-20} unit=" dB" onChange={setThr} />
        <Slider label="At least" value={minLen} min={0.1} max={3} step={0.1} unit=" s" onChange={setMinLen} />
        <div className="flex gap-1">
          <button className={btn} disabled={!!busy} onClick={scan}>Find silences</button>
          <button className={btn} disabled={!found?.length} onClick={cut}>Cut them out</button>
        </div>
        {found && (
          <div className="text-[11px] text-gray-400" role="status">
            {found.length ? `${found.length} silence${found.length === 1 ? "" : "s"}, ${found.reduce((a, [s, e]) => a + (e - s), 0).toFixed(1)} s in total: ${found.slice(0, 6).map(([s, e]) => `${s.toFixed(1)}-${e.toFixed(1)}`).join(", ")}${found.length > 6 ? "..." : ""}` : "No silences found."}
          </div>
        )}
        {found && found.length > 0 && <SilenceStrip clip={clip} found={found} />}
      </div>
    </Card>
  );
}

/** A strip of the clip with the silences to cut marked, so the cut can be checked before it is made. */
function SilenceStrip({ clip, found }: { clip: Clip; found: [number, number][] }) {
  return (
    <div className="relative h-4 overflow-hidden rounded bg-green-700/40" aria-label="Preview of the cut">
      {found.map(([s, e], i) => (
        <div key={i} className="absolute top-0 h-full bg-red-500/70" style={{ left: `${((s - clip.start) / clip.duration) * 100}%`, width: `${((e - s) / clip.duration) * 100}%` }} />
      ))}
    </div>
  );
}

/* ---------- loudness ---------- */

function Loudness() {
  const doc = useProject((s) => s.doc);
  const [m, setM] = useState<Loudness | null>(null);
  const [busy, setBusy] = useState(false);
  const [targetId, setTargetId] = useState<string>(LOUDNESS_TARGETS[0].id);
  const target = LOUDNESS_TARGETS.find((t) => t.id === targetId)!;
  const tl = activeTimeline(doc);

  /** Render the mix as it will be exported, without the master gain, and measure it. */
  const measure = async (): Promise<Loudness | null> => {
    const st = useProject.getState();
    const view = st.project;
    const d = st.doc;
    const duration = Math.max(1, view.lines.reduce((x, l) => Math.max(x, l.end), 0), E.timelineEnd(activeTimeline(d)), usePlayback.getState().duration);
    const urlOf = (id: string) => {
      const pool = d.media.find((x) => x.id === id)?.poolId;
      return pool ? useMedia.getState().urls[pool] : undefined;
    };
    const plan = mixPlan(d, duration, { gainDb: 0, ceiling: undefined });
    const ch = await mixdownChannels(mixInputs(d, view.audio?.url, duration, urlOf), duration, 48000, undefined, plan);
    return ch ? measureLoudness(ch, 48000) : null;
  };
  const run = async () => {
    setBusy(true);
    try {
      setM(await measure());
    } finally {
      setBusy(false);
    }
  };
  const match = async () => {
    setBusy(true);
    try {
      const r = await measure();
      setM(r);
      if (!r) return;
      const g = matchGain(r, target);
      editTimeline((t) => ({ ...t, master: { ...(t.master ?? { gainDb: 0 }), gainDb: Math.round(g.gainDb * 10) / 10, ceiling: target.truePeak } }));
    } finally {
      setBusy(false);
    }
  };
  const cur = tl.master;
  return (
    <Card title="Loudness" hint="Measures the whole mix (ITU-R BS.1770: integrated LUFS, true peak). Match sets the master gain to a delivery target and limits the peak.">
      <select className="field" value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label="Loudness target">
        {LOUDNESS_TARGETS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <div className="flex gap-1">
        <button className={btn} disabled={busy} onClick={run}>{busy ? "Measuring..." : "Measure"}</button>
        <button className={btn} disabled={busy} onClick={match}>Match target</button>
      </div>
      {m && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-gray-300" role="status">
          <dt>Integrated</dt><dd className="text-right">{fmtDb(m.integrated)} LUFS</dd>
          <dt>Short-term max</dt><dd className="text-right">{fmtDb(m.shortTermMax)} LUFS</dd>
          <dt>Momentary max</dt><dd className="text-right">{fmtDb(m.momentaryMax)} LUFS</dd>
          <dt>Range</dt><dd className="text-right">{m.range.toFixed(1)} LU</dd>
          <dt>True peak</dt><dd className={`text-right ${m.truePeak > -1 ? "text-red-300" : ""}`}>{fmtDb(m.truePeak)} dBTP</dd>
          <dt>Master now</dt><dd className="text-right">{fmtDb(cur?.gainDb ?? 0)} dB</dd>
        </dl>
      )}
    </Card>
  );
}

/* ---------- voice-over ---------- */

function VoiceOver() {
  const [state, setState] = useState<"idle" | "count" | "rec">("idle");
  const [count, setCount] = useState(3);
  const [secs, setSecs] = useState(0);
  const [msg, setMsg] = useState("");
  const [countIn, setCountIn] = useState(true);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; at: number; t0: number } | null>(null);
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const items = useMedia((s) => s.items);
  const tlNow0 = activeTimeline(doc);
  // the selected audio clip: a new recording becomes another take of it (and replaces it on the timeline)
  const target = selected.length === 1 ? tlNow0.clips.find((c) => c.id === selected[0] && c.mediaId && !c.fill && tlNow0.tracks.find((t) => t.id === c.trackId)?.kind === "audio") : undefined;
  const [retake, setRetake] = useState(true);
  const [heard, setHeard] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);

  const begin = async () => {
    setMsg("");
    const targetId = retake ? target?.id : undefined;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    } catch {
      setMsg("The microphone is not available (permission denied or no device).");
      return;
    }
    const at = getTime();
    if (countIn) {
      setState("count");
      for (let i = 3; i > 0; i--) {
        setCount(i);
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const t0 = performance.now();
    mr.onstop = () => void finish(chunks, stream, at, mr.mimeType, (performance.now() - t0) / 1000, targetId);
    rec.current = { mr, stream, chunks, at, t0 };
    mr.start();
    setSecs(0);
    setState("rec");
  };
  useEffect(() => {
    if (state !== "rec") return;
    const t = setInterval(() => setSecs((s) => s + 0.2), 200);
    return () => clearInterval(t);
  }, [state]);

  const finish = async (chunks: Blob[], stream: MediaStream, at: number, type: string, seconds: number, targetId?: string) => {
    stream.getTracks().forEach((t) => t.stop());
    setState("idle");
    const blob = new Blob(chunks, { type });
    const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
    // the take belongs to the group of the clip being re-taken, else a new group of its own
    const cur = targetId ? activeTimeline(useProject.getState().doc).clips.find((c) => c.id === targetId) : undefined;
    const group = cur?.takeGroup ?? newTakeGroup();
    if (cur && !cur.takeGroup && cur.mediaId) {
      // the clip's current sound becomes take 1 of the new group
      const first = useMedia.getState().items.find((i) => poolMediaId(i.id) === cur.mediaId);
      if (first && !first.take) useMedia.getState().updateItem(first.id, { take: { group, n: 1 } });
    }
    const n = nextTakeNumber(useMedia.getState().items, group);
    const file = new File([blob], `Voice-over take ${n}.${ext}`, { type });
    const added = await useMedia.getState().addFiles([file]);
    const item = added[0];
    if (!item) return setMsg("The take could not be added to the media pool.");
    useMedia.getState().updateItem(item.id, { take: { group, n } });
    const dur = item.duration && isFinite(item.duration) ? item.duration : seconds; // a recorded webm often has no duration in its header
    useProject.getState().editDoc((d) => {
      const withMedia = withPoolMedia(d, item);
      if (cur) return E.onActive(withMedia, (t) => swapTake(t, cur.id, { mediaId: poolMediaId(item.id), duration: dur, group }));
      const tlx = activeTimeline(withMedia);
      const track = E.targetTrack(tlx, "audio") ?? tlx.tracks.find((t) => t.kind === "audio");
      if (!track) return withMedia;
      const src: E.Source = { mediaId: poolMediaId(item.id), name: item.name, kind: "audio", in: 0, out: dur };
      return E.onActive(withMedia, (t) => {
        const placed = E.overwriteEdit(t, src, at, { audio: track.id }).tl;
        const clip = placed.clips.find((c) => c.mediaId === poolMediaId(item.id) && c.trackId === track.id && Math.abs(c.start - at) < 0.01);
        return clip ? tagClip(placed, clip.id, group) : placed;
      });
    });
    setMsg(cur ? `Take ${n} replaced the clip. The earlier takes are listed below.` : `Recorded "${file.name}" and placed it at ${at.toFixed(1)} s.`);
  };
  const stop = () => rec.current?.mr.stop();

  return (
    <Card title="Voice-over" hint="Records the microphone onto the audio track at the playhead. Every take is kept in the media pool. With an audio clip selected, a new recording becomes another take of it and replaces it on the timeline.">
      <label className="flex items-center gap-2 text-[12px] text-gray-300">
        <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} disabled={state !== "idle"} /> Count in (3, 2, 1)
      </label>
      {target && (
        <label className="flex items-center gap-2 text-[12px] text-gray-300">
          <input type="checkbox" checked={retake} onChange={(e) => setRetake(e.target.checked)} disabled={state !== "idle"} /> Record over the selected clip as another take
        </label>
      )}
      <div className="flex items-center gap-2">
        {state === "idle" && <button className={btn} onClick={begin}>{target && retake ? "Record a new take" : "Record"}</button>}
        {state === "count" && <span className="text-[13px] text-yellow-300" role="status">{count}</span>}
        {state === "rec" && (
          <>
            <button className={`${btn} !border-red-500 !text-red-300`} onClick={stop}>Stop</button>
            <span className="text-[12px] text-red-300" role="status">● {secs.toFixed(1)} s</span>
          </>
        )}
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
      {target?.takeGroup && (
        <Takes
          group={target.takeGroup}
          clipId={target.id}
          current={target.mediaId}
          heard={heard}
          onHear={(id, url) => {
            player.current?.pause();
            if (!url || heard === id) return setHeard(null);
            const a = new Audio(url);
            a.onended = () => setHeard(null);
            player.current = a;
            setHeard(id);
            void a.play().catch(() => setHeard(null));
          }}
          items={items}
        />
      )}
    </Card>
  );
}

/** The takes of the selected clip's group: listen, rate, bring one back onto the timeline, or delete it. */
function Takes({ group, clipId, current, heard, onHear, items }: { group: string; clipId: string; current?: string; heard: string | null; onHear: (id: string, url?: string) => void; items: ReturnType<typeof useMedia.getState>["items"] }) {
  const urls = useMedia((s) => s.urls);
  const list = takesInGroup(items, group);
  const best = bestTake(items, group);
  if (!list.length) return null;
  const use = (id: string, duration?: number) => editTimeline((t) => swapTake(t, clipId, { mediaId: poolMediaId(id), duration: duration && isFinite(duration) ? duration : 1, group }));
  return (
    <div className="space-y-1.5" role="group" aria-label="Takes of the selected clip">
      <p className="text-[11px] font-medium text-gray-400">Takes ({list.length})</p>
      {list.map((i) => {
        const on = current === poolMediaId(i.id);
        return (
          <div key={i.id} className={`flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1 ${on ? "border-accent" : "border-edge"}`}>
            <span className="min-w-0 flex-1 truncate text-[12px] text-gray-200">
              Take {i.take!.n}
              <span className="text-gray-500"> {i.duration ? `${i.duration.toFixed(1)} s` : ""}</span>
              {best?.id === i.id && !on && <span className="ml-1 text-[10px] text-accent">best</span>}
              {on && <span className="ml-1 text-[10px] text-accent">on the timeline</span>}
            </span>
            <button className={btn} onClick={() => onHear(i.id, urls[i.id])} disabled={!urls[i.id]} aria-pressed={heard === i.id}>{heard === i.id ? "Stop" : "Listen"}</button>
            <button className={btn} onClick={() => useMedia.getState().updateItem(i.id, { take: { ...i.take!, rating: i.take!.rating === "good" ? undefined : "good" } })} aria-pressed={i.take!.rating === "good"} title="Mark as good">{i.take!.rating === "good" ? "★" : "☆"}</button>
            <button className={btn} onClick={() => useMedia.getState().updateItem(i.id, { take: { ...i.take!, rating: i.take!.rating === "bad" ? undefined : "bad" } })} aria-pressed={i.take!.rating === "bad"} title="Mark as bad">{i.take!.rating === "bad" ? "✕" : "·"}</button>
            <button className={btn} disabled={on} onClick={() => use(i.id, i.duration)}>Use</button>
            <button className="text-[11px] text-gray-500 hover:text-red-400 disabled:opacity-30" disabled={on} onClick={() => useMedia.getState().remove(i.id)} aria-label={`Delete take ${i.take!.n}`}>delete</button>
          </div>
        );
      })}
    </div>
  );
}

