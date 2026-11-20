import { create } from "zustand";
import type { AudioAnalysis, Clip, Marker, MediaRef, ProjectDoc, Timeline } from "../model/types";
import { useProject } from "../store/project";
import { useMedia } from "../store/media";
import { getAlignSettings } from "./autosync";
import { ANALYSIS_RATE } from "./energy";

/**
 * Beat detection (phase 16.5). A song is analysed once; results are stored as `kind: "beat"` markers on every
 * timeline that uses the song, plus `MediaRef.analysis` (tempo, first downbeat, loudness curve). The pool item keeps
 * a copy of the result (`MediaItem.beatResult`) so the song is never re-analysed when it is placed again.
 *
 * Analysis runs on the backend (librosa, or madmom for downbeats) when it is reachable, else in a Web Audio worker.
 */

export type BeatResult = {
  analysis: AudioAnalysis;
  /** Beat times in source seconds, with downbeat flags and onset strength 0..1. */
  beats: { time: number; downbeat: boolean; strength: number }[];
};

type Opts = { signal?: AbortSignal; onProgress?: (pct: number) => void };

/* ---------- analysis ---------- */

const base = (u: string) => u.trim().replace(/\/+$/, "");
let backendDown = 0; // time of the last failed health check; retried after a while

/** The backend URL when it is up and has librosa, else null. */
async function backendFor(signal?: AbortSignal): Promise<string | null> {
  if (Date.now() - backendDown < 30000) return null;
  const url = base(getAlignSettings().url);
  if (!url) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  const stop = () => ctl.abort();
  signal?.addEventListener("abort", stop);
  try {
    const res = await fetch(`${url}/api/health`, { signal: ctl.signal });
    const h = res.ok ? ((await res.json()) as { beats?: { librosa?: boolean } }) : null;
    if (h?.beats?.librosa) return url;
  } catch {
    /* offline */
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  backendDown = Date.now();
  return null;
}

type ServerBeats = {
  tempo: number;
  firstDownbeat: number;
  beatsPerBar: number;
  beats: BeatResult["beats"];
  energy: { rate: number; values: number[] };
};

const toResult = (r: ServerBeats, source: AudioAnalysis["source"]): BeatResult => ({
  analysis: { tempo: r.tempo, firstDownbeat: r.firstDownbeat, beatsPerBar: r.beatsPerBar, source, energy: r.energy },
  beats: r.beats,
});

async function analyzeOnBackend(url: string, audio: Blob, opts: Opts): Promise<BeatResult> {
  const form = new FormData();
  form.append("audio", audio instanceof File ? audio : new File([audio], "song"));
  opts.onProgress?.(0.1);
  const res = await fetch(`${url}/api/beats`, { method: "POST", body: form, signal: opts.signal });
  if (!res.ok) {
    let msg = `The backend answered ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j?.detail === "string") msg = j.detail;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  const r = (await res.json()) as ServerBeats;
  opts.onProgress?.(1);
  return toResult(r, "backend");
}

/** Decode to mono samples at ANALYSIS_RATE (on the main thread: workers have no AudioContext). */
async function decodeMono(audio: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_RATE);
  const buf = await ctx.decodeAudioData(await audio.arrayBuffer());
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

function analyzeInBrowser(audio: Blob, opts: Opts): Promise<BeatResult> {
  return (async () => {
    opts.onProgress?.(0);
    const samples = await decodeMono(audio);
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    opts.onProgress?.(0.1);
    const worker = new Worker(new URL("./beats.worker.ts", import.meta.url), { type: "module" });
    return new Promise<BeatResult>((resolve, reject) => {
      const stop = () => (worker.terminate(), reject(new DOMException("Aborted", "AbortError")));
      opts.signal?.addEventListener("abort", stop, { once: true });
      const end = () => (worker.terminate(), opts.signal?.removeEventListener("abort", stop));
      worker.onmessage = (e: MessageEvent<{ type: "progress"; pct: number } | { type: "result"; result: ServerBeats } | { type: "error"; message: string }>) => {
        const m = e.data;
        if (m.type === "progress") opts.onProgress?.(0.1 + 0.9 * m.pct);
        else if (m.type === "result") (end(), resolve(toResult(m.result, "browser")));
        else (end(), reject(new Error(m.message)));
      };
      worker.onerror = (e) => (end(), reject(new Error(e.message || "Beat analysis failed")));
      worker.postMessage({ samples, sampleRate: ANALYSIS_RATE }, [samples.buffer]);
    });
  })();
}

/** Analyse audio (backend when reachable, else Web Audio in a worker). */
export async function analyzeBeats(audio: Blob, opts: Opts = {}): Promise<BeatResult> {
  const url = await backendFor(opts.signal);
  if (url) {
    try {
      return await analyzeOnBackend(url, audio, opts);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      console.warn("Backend beat detection failed, using the browser:", e);
    }
  }
  return analyzeInBrowser(audio, opts);
}

/** Beats on a steady grid from a typed tempo and first-downbeat offset (for songs the detector gets wrong). */
export function manualBeats(tempo: number, firstDownbeat: number, duration: number, beatsPerBar = 4): BeatResult {
  const bpb = Math.max(1, Math.round(beatsPerBar));
  const analysis: AudioAnalysis = { tempo, firstDownbeat: Math.max(0, firstDownbeat), beatsPerBar: bpb, source: "manual" };
  if (!(tempo > 0) || !(duration > 0)) return { analysis, beats: [] };
  const period = 60 / tempo;
  const first = Math.max(0, firstDownbeat);
  const k0 = -Math.floor(first / period + 1e-9); // backfill to time 0
  const beats: BeatResult["beats"] = [];
  for (let k = k0; ; k++) {
    const time = Math.round((first + k * period) * 1e6) / 1e6;
    if (time > duration + 1e-9) break;
    if (time < 0) continue;
    const downbeat = ((k % bpb) + bpb) % bpb === 0;
    beats.push({ time, downbeat, strength: downbeat ? 1 : 0.6 });
  }
  return { analysis, beats };
}

/* ---------- storing results ---------- */

export const BEAT_COLOR = "#f5a623";

/** Doc media entries for an id that is either a document media id or a media-pool item id. */
const mediaMatching = (doc: ProjectDoc, id: string) => doc.media.filter((m) => m.id === id || m.poolId === id);

/** Source seconds -> timeline seconds for a clip, or null when that moment is not part of the clip. */
export function sourceToTimeline(c: Clip, src: number): number | null {
  const speed = c.speed > 0 ? c.speed : 1;
  if (src < c.sourceIn - 1e-6) return null;
  if (!c.fill) {
    if (c.sourceOut > c.sourceIn && src >= c.sourceOut - 1e-6) return null;
    const t = c.start + (src - c.sourceIn) / speed;
    if (t >= c.start + c.duration - 1e-6) return null;
    return Math.round(t * 1e6) / 1e6;
  }
  return Math.round((c.start + (src - c.sourceIn) / speed) * 1e6) / 1e6;
}

function beatMarkers(c: Clip, mediaId: string, result: BeatResult): Marker[] {
  const out: Marker[] = [];
  let bar = 0;
  result.beats.forEach((b, i) => {
    if (b.downbeat) bar++;
    const time = sourceToTimeline(c, b.time);
    if (time === null) return;
    out.push({
      id: `beat-${c.id}-${i}`,
      time,
      name: b.downbeat ? `Bar ${bar}` : "Beat",
      color: BEAT_COLOR,
      kind: "beat",
      downbeat: b.downbeat,
      strength: b.strength,
      sourceMediaId: mediaId,
    });
  });
  return out;
}

/**
 * Pure: store a result on the document. Sets `analysis` on the media item and replaces the beat markers of every
 * timeline whose clips use that media (mapped from source time to timeline time per clip). `mediaId` may be a
 * document media id or a media-pool item id (then every document entry of that pool item is updated, the lyric
 * project's song included). Returns `doc` itself when no media matches.
 */
export function applyBeatResult(doc: ProjectDoc, mediaId: string, result: BeatResult): ProjectDoc {
  const targets = mediaMatching(doc, mediaId);
  if (!targets.length) return doc;
  const ids = new Set(targets.map((m) => m.id));
  const media: MediaRef[] = doc.media.map((m) => (ids.has(m.id) ? { ...m, analysis: result.analysis } : m));
  const timelines: Timeline[] = doc.timelines.map((tl) => {
    const uses = tl.clips.filter((c) => c.mediaId && ids.has(c.mediaId));
    const hadOwn = tl.markers.some((m) => m.kind === "beat" && m.sourceMediaId && ids.has(m.sourceMediaId));
    if (!uses.length && !hadOwn) return tl;
    const kept = tl.markers.filter((m) => !(m.kind === "beat" && m.sourceMediaId && ids.has(m.sourceMediaId)));
    const added = uses.flatMap((c) => beatMarkers(c, c.mediaId!, result));
    const markers = [...kept, ...added].sort((a, b) => a.time - b.time); // stable: user markers keep their order
    return { ...tl, markers };
  });
  return { ...doc, media, timelines };
}

/* ---------- jobs (detection in the background, with progress) ---------- */

export type BeatJob = { progress: number; error?: string };
/** Running and failed detections, keyed by the id passed to detectBeatsFor (usually a pool item id). */
export const useBeatJobs = create<{ jobs: Record<string, BeatJob> }>(() => ({ jobs: {} }));
const setJob = (id: string, j: BeatJob | null) =>
  useBeatJobs.setState((s) => {
    const jobs = { ...s.jobs };
    if (j) jobs[id] = j;
    else delete jobs[id];
    return { jobs };
  });

/** The audio of a pool item or document media entry. */
async function blobFor(id: string): Promise<Blob | null> {
  const pool = useMedia.getState();
  if (pool.items.some((i) => i.id === id)) return pool.fileOf(id);
  const m = useProject.getState().doc.media.find((x) => x.id === id);
  if (!m) return null;
  if (m.poolId && pool.items.some((i) => i.id === m.poolId)) return pool.fileOf(m.poolId);
  if (m.url) {
    try {
      return await (await fetch(m.url)).blob();
    } catch {
      return null;
    }
  }
  return null;
}

/** The pool item behind an id (a pool id, or a doc media id with a poolId). */
const poolIdOf = (id: string): string | undefined => {
  if (useMedia.getState().items.some((i) => i.id === id)) return id;
  return useProject.getState().doc.media.find((m) => m.id === id)?.poolId;
};

/** Save a result: on the pool item (cache) and in the document with one undoable edit. */
export function storeBeatResult(id: string, result: BeatResult) {
  const poolId = poolIdOf(id);
  if (poolId) useMedia.getState().updateItem(poolId, { beatResult: result });
  useProject.getState().editDoc((doc) => applyBeatResult(doc, poolId ?? id, result));
}

const controllers = new Map<string, AbortController>();

/** Detect beats for a media item and apply the result with one undoable editDoc. */
export async function detectBeatsFor(mediaId: string, opts: Opts = {}): Promise<void> {
  controllers.get(mediaId)?.abort();
  const ctl = new AbortController();
  controllers.set(mediaId, ctl);
  const stop = () => ctl.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  setJob(mediaId, { progress: 0 });
  try {
    const blob = await blobFor(mediaId);
    if (!blob) throw new Error("Could not read the song's file.");
    let last = 0;
    const result = await analyzeBeats(blob, {
      signal: ctl.signal,
      onProgress: (p) => {
        opts.onProgress?.(p);
        if (p - last >= 0.02 || p >= 1) (last = p), setJob(mediaId, { progress: p });
      },
    });
    if (ctl.signal.aborted) throw new DOMException("Aborted", "AbortError");
    storeBeatResult(mediaId, result);
    setJob(mediaId, null);
  } catch (e) {
    if ((e as Error).name === "AbortError") setJob(mediaId, null);
    else setJob(mediaId, { progress: 0, error: (e as Error).message || "Beat detection failed" });
    throw e;
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    if (controllers.get(mediaId) === ctl) controllers.delete(mediaId);
  }
}

/** Stop a running detection. */
export const cancelBeats = (id: string) => controllers.get(id)?.abort();

/* ---------- automatic detection when a song is added ---------- */

let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

/** Detect in the background, one song at a time; failures show on the job, never as an exception. */
export function queueDetect(id: string) {
  if (queued.has(id) || controllers.has(id)) return;
  queued.add(id);
  setJob(id, { progress: 0 });
  queue = queue.then(() => {
    queued.delete(id);
    return detectBeatsFor(id).catch(() => undefined);
  });
}

const sameAnalysis = (a?: AudioAnalysis, b?: AudioAnalysis) =>
  !!a && !!b && a.tempo === b.tempo && a.firstDownbeat === b.firstDownbeat && a.beatsPerBar === b.beatsPerBar && a.source === b.source;

/** A newly imported pool item: analyse it if it is a song without a result. */
export function autoDetectPoolItem(poolId: string) {
  const it = useMedia.getState().items.find((i) => i.id === poolId);
  if (it?.kind === "audio" && !it.beatResult) queueDetect(poolId);
}

const seen = new Set<string>();
let watching = false;

/**
 * Keep songs on the document analysed: an audio media entry (the lyric project's song included) without analysis
 * gets the pool item's stored result, or is analysed once. Each entry is looked at once per session, so undoing the
 * result does not bring it straight back.
 */
export function watchSongs() {
  if (watching) return;
  watching = true;
  const scan = () => {
    const { doc } = useProject.getState();
    const { items, projectId } = useMedia.getState();
    const poolOf = (m: MediaRef) => (m.poolId ? items.find((i) => i.id === m.poolId) : undefined);
    for (const m of doc.media) {
      if (m.kind !== "audio") continue;
      const pool = poolOf(m);
      if (m.poolId && !pool) continue; // pool not loaded yet (or item removed): look again later
      const key = `${projectId}|${m.id}|${m.poolId ?? m.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (pool?.beatResult) {
        if (!sameAnalysis(m.analysis, pool.beatResult.analysis)) {
          const r = pool.beatResult;
          useProject.getState().editDoc((d) => applyBeatResult(d, m.id, r));
        }
      } else if (pool || !m.analysis) queueDetect(m.poolId ?? m.id); // a pool song without a result, or a song never analysed
    }
    // a clip of an analysed song placed on a timeline after detection gets its beat markers
    for (const tl of doc.timelines) {
      for (const c of tl.clips) {
        const m = c.mediaId ? doc.media.find((x) => x.id === c.mediaId) : undefined;
        const r = m && poolOf(m)?.beatResult;
        if (!m || m.kind !== "audio" || !r) continue;
        const key = `${projectId}|${tl.id}|${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!r.beats.length || tl.markers.some((k) => k.kind === "beat" && k.id.startsWith(`beat-${c.id}-`))) continue;
        useProject.getState().editDoc((d) => applyBeatResult(d, m.id, r));
      }
    }
  };
  // looked at after the change that triggered it, never inside another store update
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 50);
  };
  useProject.subscribe((s, p) => s.doc !== p.doc && (s.doc.media !== p.doc.media || s.doc.timelines !== p.doc.timelines) && later());
  useMedia.subscribe((s, p) => (s.items !== p.items || s.projectId !== p.projectId) && later());
  later();
}
