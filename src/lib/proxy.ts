import { create } from "zustand";
import { optimizedKey, proxyKey, useMedia, type MediaItem } from "../store/media";
import { putFile, removeFile, getFile } from "./filestore";
import { useProject } from "../store/project";
import { DEFAULT_PROXY, type ProxySettings } from "../model/types";

/**
 * Proxies and optimized media (phase 16): making them in a worker, one at a time, and choosing which file plays.
 *
 * Playback uses the proxy (or the optimized copy) when the project allows it and one exists; export always uses
 * the original unless the user chose "export from proxies". See `fileFor`.
 */

export type JobKind = "proxy" | "optimized";
type Job = { itemId: string; kind: JobKind; progress: number; error?: string; queued: boolean };

export const useProxyJobs = create<{ jobs: Record<string, Job> }>(() => ({ jobs: {} }));

/** The project's proxy settings with defaults filled in. */
export const proxySettings = (): ProxySettings => ({ ...DEFAULT_PROXY, ...(useProject.getState().doc.settings.proxy ?? {}) });

/** Height of a proxy for a source of `h` pixels (even, never larger than the source). */
export function proxyHeight(h: number | undefined, size: ProxySettings["size"]): number {
  const src = h && h > 0 ? h : 1080;
  const target = size === "half" ? src / 2 : size === "quarter" ? src / 4 : Number(size);
  return Math.max(2, Math.min(src, Math.round(target / 2) * 2));
}

/** Large enough to deserve a proxy: above 1080p. */
export const wantsProxy = (it: MediaItem) => it.kind === "video" && ((it.height ?? 0) > 1080 || (it.width ?? 0) > 1920);

/** Which stored file to read for a pool item: for playback (viewer) or for export. */
export function variantFor(it: MediaItem, purpose: "playback" | "export", s: ProxySettings): "proxy" | "optimized" | "original" {
  const allowed = purpose === "playback" ? s.use : s.exportFromProxies;
  if (!allowed || it.kind !== "video") return "original";
  if (it.proxy) return "proxy";
  if (it.optimized) return "optimized";
  return "original";
}

/** The file to decode for a pool item. Falls back to the original when a proxy file is missing. */
export async function fileFor(itemId: string, purpose: "playback" | "export"): Promise<Blob | null> {
  const m = useMedia.getState();
  const it = m.items.find((i) => i.id === itemId);
  const pid = m.projectId;
  if (!it || !pid) return null;
  const v = variantFor(it, purpose, proxySettings());
  if (v !== "original") {
    const f = await getFile(v === "proxy" ? proxyKey(pid, it.id) : optimizedKey(pid, it.id), it.name, "video/mp4");
    if (f) return f;
  }
  return m.fileOf(itemId);
}

/* ---------- the job queue ---------- */

let worker: Worker | null = null;
let nextId = 1;
let current: { id: number; itemId: string } | null = null;
const queue: { itemId: string; kind: JobKind }[] = [];
const listeners = new Set<() => void>();
/** Called when a proxy or optimized file appears or goes, so open decoders switch files. */
export const onVariantsChanged = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));

const setJob = (itemId: string, j: Partial<Job> | null) =>
  useProxyJobs.setState((s) => {
    const jobs = { ...s.jobs };
    if (j === null) delete jobs[itemId];
    else jobs[itemId] = { ...(jobs[itemId] ?? { itemId, kind: "proxy", progress: 0, queued: true }), ...j };
    return { jobs };
  });

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./proxy.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = async (e: MessageEvent<{ id: number; progress?: number; done?: boolean; size?: number; stored?: string; buffer?: ArrayBuffer; error?: string }>) => {
    const d = e.data;
    if (!current || d.id !== current.id) return;
    const { itemId } = current;
    const job = useProxyJobs.getState().jobs[itemId];
    if (d.progress !== undefined) return setJob(itemId, { progress: d.progress });
    if (d.error) {
      setJob(itemId, { error: d.error === "cancelled" ? undefined : d.error, progress: 0 });
      if (d.error === "cancelled") setJob(itemId, null);
      await cleanup(itemId, job?.kind ?? "proxy");
    } else if (d.done && job) {
      const pid = useMedia.getState().projectId;
      if (d.stored === "page" && d.buffer && pid) await putFile(keyOf(pid, itemId, job.kind), new Blob([d.buffer], { type: "video/mp4" }), "proxy.mp4");
      const it = useMedia.getState().items.find((i) => i.id === itemId);
      if (job.kind === "proxy") useMedia.getState().updateItem(itemId, { proxy: { height: proxyHeight(it?.height, proxySettings().size), size: d.size ?? 0 } });
      else useMedia.getState().updateItem(itemId, { optimized: { size: d.size ?? 0 } });
      setJob(itemId, null);
      listeners.forEach((f) => f());
    }
    current = null;
    void pump();
  };
  return worker;
}

const keyOf = (pid: string, itemId: string, kind: JobKind) => (kind === "proxy" ? proxyKey(pid, itemId) : optimizedKey(pid, itemId));

async function cleanup(itemId: string, kind: JobKind) {
  const pid = useMedia.getState().projectId;
  if (pid) await removeFile(keyOf(pid, itemId, kind));
}

async function pump() {
  if (current || !queue.length) return;
  const next = queue.shift()!;
  const m = useMedia.getState();
  const it = m.items.find((i) => i.id === next.itemId);
  const pid = m.projectId;
  const file = it && pid ? await m.fileOf(it.id) : null;
  if (!it || !pid || !file) {
    setJob(next.itemId, { error: "the original file is not available", queued: false });
    return void pump();
  }
  const id = nextId++;
  current = { id, itemId: it.id };
  setJob(it.id, { kind: next.kind, progress: 0, queued: false, error: undefined });
  getWorker().postMessage({ id, file, key: keyOf(pid, it.id, next.kind), mode: next.kind, height: next.kind === "proxy" ? proxyHeight(it.height, proxySettings().size) : undefined });
}

/** Queue proxies or optimized copies for pool items (videos only; items already done or queued are skipped). */
export function makeVariants(itemIds: string[], kind: JobKind) {
  const items = useMedia.getState().items;
  for (const id of itemIds) {
    const it = items.find((i) => i.id === id);
    if (!it || it.kind !== "video" || (kind === "proxy" ? it.proxy : it.optimized)) continue;
    if (queue.some((q) => q.itemId === id) || current?.itemId === id) continue;
    queue.push({ itemId: id, kind });
    setJob(id, { kind, progress: 0, queued: true, error: undefined });
  }
  void pump();
}

export function cancelJob(itemId: string) {
  const i = queue.findIndex((q) => q.itemId === itemId);
  if (i >= 0) {
    queue.splice(i, 1);
    setJob(itemId, null);
  } else if (current?.itemId === itemId) worker?.postMessage({ cancel: current.id });
  else setJob(itemId, null);
}

/** Delete an item's proxy or optimized copy. */
export async function removeVariant(itemId: string, kind: JobKind) {
  await cleanup(itemId, kind);
  useMedia.getState().updateItem(itemId, kind === "proxy" ? { proxy: undefined } : { optimized: undefined });
  listeners.forEach((f) => f());
}

/** Storage used by proxies and optimized copies of this project. */
export function variantUsage(): { proxies: number; proxyBytes: number; optimized: number; optimizedBytes: number } {
  const items = useMedia.getState().items;
  return {
    proxies: items.filter((i) => i.proxy).length,
    proxyBytes: items.reduce((n, i) => n + (i.proxy?.size ?? 0), 0),
    optimized: items.filter((i) => i.optimized).length,
    optimizedBytes: items.reduce((n, i) => n + (i.optimized?.size ?? 0), 0),
  };
}
