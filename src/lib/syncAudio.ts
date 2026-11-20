import { SYNC_RATE, downsampleMono, findLag, type Lag } from "./sync";

/** Decode a media file's sound and reduce it to the mono, low-rate signal syncing works on. */
export async function syncSignal(url: string): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  return downsampleMono(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), buf.sampleRate, SYNC_RATE);
}

let worker: Worker | null = null;
let next = 1;
const pending = new Map<number, { resolve: (l: Lag) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./sync.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; lag?: number; confidence?: number; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve({ lag: e.data.lag!, confidence: e.data.confidence! });
    };
    worker.onerror = () => {
      for (const [, p] of pending) p.reject(new Error("the sync worker stopped"));
      pending.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Where `b` starts inside `a` (seconds), computed in a worker when there is one. */
export function lagInWorker(a: Float32Array, b: Float32Array, maxSeconds?: number): Promise<Lag> {
  const w = getWorker();
  if (!w) return Promise.resolve(findLag(a, b, SYNC_RATE, maxSeconds));
  return new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, a, b, sr: SYNC_RATE, maxSeconds });
  });
}
