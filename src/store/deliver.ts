import { create } from "zustand";
import { useProject, type Project } from "./project";
import { activeTimeline, docToView } from "../model/convert";
import type { ProjectDoc } from "../model/types";
import { timelineEnd } from "../timeline/engine";
import { usePlayback } from "../lib/transport";
import { useTimelineUi } from "../timeline/ui";
import { downloadBlob } from "../lib/exporter";
import { renderDeliver, targetOf } from "../lib/deliver/render";
import { verifyOutput } from "../lib/deliver/verify";
import { BUILTIN_PRESETS, fileName, presetsFromJson, presetsToJson, sanitizePreset, type DeliverPreset, type RangeChoice, type SourceChoice } from "../lib/deliver/presets";
import * as Q from "../lib/deliver/queue";

/**
 * The render queue and the saved presets (phase 26). Jobs render one at a time on the page's main thread (rendering
 * needs the canvas and the decoders, which a worker cannot reach), one frame per turn so the editor stays usable.
 * They keep going after the dialog closes. The job list and custom presets are kept in localStorage; a reload cuts a
 * running job off (it is shown as interrupted and can be retried) and the finished files, held in memory, are gone.
 */

const JOBS_KEY = "cutir:deliverJobs";
const PRESETS_KEY = "cutir:deliverPresets";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* storage unavailable or damaged */
  }
  return fallback;
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** Things too big to store: what each job renders from, its running controller and its finished file. */
const snapshots = new Map<string, { project: Project; doc: ProjectDoc }>();
const files = new Map<string, Blob>();
const controllers = new Map<string, AbortController>();

type DeliverState = {
  jobs: Q.Job[];
  held: boolean;
  custom: DeliverPreset[];
  note: string;
  add: (o: AddOptions) => Q.Job[];
  hold: (on: boolean) => void;
  holdJob: (id: string, on: boolean) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
  save: (id: string) => boolean;
  savePreset: (p: DeliverPreset) => void;
  deletePreset: (id: string) => void;
  importPresets: (text: string) => { added: number; skipped: number };
  exportPresets: () => string;
};

export type AddOptions = {
  preset: DeliverPreset;
  /** Timelines to render; the open one when empty. */
  timelineIds?: string[];
  range: RangeChoice;
  /** For "inout": seconds. */
  start?: number;
  end?: number;
  source: SourceChoice;
};

let seq = 0;
const newId = () => `job-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const mm = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** The time span the selected timeline clips cover, or null when none are selected. */
export function selectionSpan(doc: ProjectDoc, selected: string[]): { start: number; end: number } | null {
  const tl = activeTimeline(doc);
  const picked = tl.clips.filter((c) => selected.includes(c.id));
  if (!picked.length) return null;
  return { start: Math.min(...picked.map((c) => c.start)), end: Math.max(...picked.map((c) => c.start + c.duration)) };
}

/** How long a timeline is: the open one follows the player (it includes the song), others the end of their last clip. */
export function lengthOf(doc: ProjectDoc, id: string): number {
  if (id === doc.activeTimelineId) return usePlayback.getState().duration || timelineEnd(activeTimeline(doc));
  const tl = doc.timelines.find((t) => t.id === id);
  return tl ? timelineEnd(tl) : 0;
}

export const useDeliver = create<DeliverState>((set, get) => {
  const setJobs = (f: (j: Q.Job[]) => Q.Job[]) => {
    set((s) => ({ jobs: f(s.jobs) }));
    persist();
    pump();
  };
  const persist = () => write(JOBS_KEY, get().jobs);
  const patchProgress = (id: string, fraction: number, stage: string) => set((s) => ({ jobs: Q.progress(s.jobs, id, fraction, stage) })); // not persisted: too frequent

  let busy = false;
  async function pump() {
    if (busy) return;
    const job = Q.nextRunnable(get().jobs, get().held);
    if (!job) return;
    busy = true;
    set((s) => ({ jobs: Q.start(s.jobs, job.id) }));
    persist();
    const ctl = new AbortController();
    controllers.set(job.id, ctl);
    try {
      const st = useProject.getState();
      const snap = snapshots.get(job.id) ?? (() => {
        const doc = st.doc.timelines.some((t) => t.id === job.timelineId) ? { ...st.doc, activeTimelineId: job.timelineId } : st.doc;
        return { doc, project: docToView(doc) };
      })();
      const { blob, audio } = await renderDeliver({
        preset: job.preset,
        project: snap.project,
        doc: snap.doc,
        start: job.start,
        end: job.end,
        source: job.source,
        signal: ctl.signal,
        onProgress: (p) => patchProgress(job.id, p.fraction * 0.95, p.stage),
      });
      patchProgress(job.id, 0.95, "Verifying");
      const t = targetOf(job.preset, snap.project);
      const verdict = await verifyOutput(blob, {
        container: job.preset.container,
        seconds: job.end - job.start,
        fps: t.fps,
        hasAudio: audio && (job.preset.container === "mp4" || job.preset.container === "webm"),
      });
      files.set(job.id, blob);
      const name = fileName(job.preset.pattern, { project: "cutir", timeline: job.timelineName, preset: job.preset.name, w: t.w, h: t.h, fps: t.fps, n: get().jobs.findIndex((j) => j.id === job.id) + 1 }, job.preset.container);
      set((s) => ({ jobs: Q.finish(s.jobs, job.id, { kind: "done", fileName: name, bytes: blob.size, verdict }) }));
      downloadBlob(blob, name);
    } catch (e) {
      files.delete(job.id);
      const err = e as Error;
      set((s) => ({ jobs: Q.finish(s.jobs, job.id, err.name === "AbortError" ? { kind: "cancelled" } : { kind: "failed", error: err.message || "Render failed" }) }));
    } finally {
      controllers.delete(job.id);
      snapshots.delete(job.id);
      busy = false;
      persist();
      if (!Q.nextRunnable(get().jobs, get().held) && !get().jobs.some((j) => j.status === "running")) notifyDone(get().jobs);
      void pump();
    }
  }

  const jobs = Q.recover(read<Q.Job[]>(JOBS_KEY, []));
  const custom = read<unknown[]>(PRESETS_KEY, []).map((p) => sanitizePreset(p)).filter((p): p is DeliverPreset => !!p);

  return {
    jobs,
    held: false,
    custom,
    note: "",
    add: (o) => {
      const st = useProject.getState();
      const ids = o.timelineIds?.length ? o.timelineIds : [st.doc.activeTimelineId];
      const created: Q.Job[] = [];
      for (const id of ids) {
        const tl = st.doc.timelines.find((t) => t.id === id);
        if (!tl) continue;
        const doc: ProjectDoc = { ...st.doc, activeTimelineId: id };
        const len = lengthOf(st.doc, id);
        let start = 0;
        let end = len;
        if (o.range === "inout") {
          start = Math.max(0, o.start ?? 0);
          end = Math.min(len, o.end ?? len);
        } else if (o.range === "selection") {
          const span = selectionSpan(doc, useTimelineUi.getState().selected);
          if (span) ({ start, end } = span);
        }
        if (!(end > start)) continue;
        const job: Q.Job = {
          id: newId(),
          name: `${tl.name} - ${o.preset.name}${o.range === "whole" ? "" : ` (${mm(start)} to ${mm(end)})`}`,
          preset: o.preset,
          timelineId: id,
          timelineName: tl.name,
          start,
          end,
          source: o.source,
          status: "queued",
          progress: 0,
          stage: "Waiting",
          attempts: 0,
          createdAt: Date.now(),
        };
        snapshots.set(job.id, { doc, project: docToView(doc) });
        created.push(job);
      }
      if (created.length) setJobs((j) => created.reduce(Q.enqueue, j));
      return created;
    },
    hold: (on) => {
      set({ held: on });
      pump();
    },
    holdJob: (id, on) => setJobs((j) => Q.setHold(j, id, on)),
    cancel: (id) => {
      const job = get().jobs.find((j) => j.id === id);
      if (job?.status === "running") controllers.get(id)?.abort();
      else setJobs((j) => Q.cancelWaiting(j, id));
    },
    retry: (id) => {
      files.delete(id);
      setJobs((j) => Q.retry(j, id));
    },
    move: (id, dir) => setJobs((j) => Q.move(j, id, dir)),
    remove: (id) => {
      files.delete(id);
      snapshots.delete(id);
      setJobs((j) => Q.remove(j, id));
    },
    clearFinished: () => {
      get().jobs.filter(Q.isFinished).forEach((j) => files.delete(j.id));
      setJobs(Q.clearFinished);
    },
    save: (id) => {
      const blob = files.get(id);
      const job = get().jobs.find((j) => j.id === id);
      if (!blob || !job?.fileName) return false;
      downloadBlob(blob, job.fileName);
      return true;
    },
    savePreset: (p) => {
      const clean = sanitizePreset({ ...p, name: p.name }, p.id);
      if (!clean) return;
      const next = [...get().custom.filter((x) => x.id !== clean.id), { ...clean, builtin: undefined }];
      write(PRESETS_KEY, next);
      set({ custom: next });
    },
    deletePreset: (id) => {
      const next = get().custom.filter((p) => p.id !== id);
      write(PRESETS_KEY, next);
      set({ custom: next });
    },
    importPresets: (text) => {
      const taken = new Set([...BUILTIN_PRESETS, ...get().custom].map((p) => p.id));
      const { presets, skipped } = presetsFromJson(text, taken);
      if (presets.length) {
        const next = [...get().custom, ...presets];
        write(PRESETS_KEY, next);
        set({ custom: next });
      }
      return { added: presets.length, skipped };
    },
    exportPresets: () => presetsToJson(get().custom),
  };
});

// jobs that were still waiting before a reload start by themselves once the editor is up
queueMicrotask(() => useDeliver.getState().hold(false));

function notifyDone(jobs: Q.Job[]) {
  const s = Q.summary(jobs);
  const text = s.failed ? `Render queue finished: ${s.done} done, ${s.failed} failed.` : `Render queue finished: ${s.done} file${s.done === 1 ? "" : "s"} ready.`;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) new Notification("Cutir", { body: text });
  } catch {
    /* notifications blocked */
  }
}

export const askNotifications = () => {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    /* not available */
  }
};
