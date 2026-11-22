import { TrackSession, type TrackSpec, type TrackStep } from "./session";
import type { Gray } from "./tracker";

/**
 * Where the matching runs (phase 22): in a worker when the browser has them, else on the calling thread. Both answer
 * the same way, so the editor does not care which one it got. \`frame\` calls are answered in order.
 */
export type Matcher = {
  start: (first: Gray, spec: TrackSpec) => Promise<TrackStep>;
  frame: (g: Gray) => Promise<TrackStep | null>;
  close: () => void;
  readonly inWorker: boolean;
};

/** Runs the session right here (also what the tests use). */
export function inlineMatcher(): Matcher {
  let s: TrackSession | null = null;
  return {
    inWorker: false,
    start: async (first, spec) => ((s = new TrackSession(first, spec)), s.first()),
    frame: async (g) => (s ? s.next(g) : null),
    close: () => void (s = null),
  };
}

/** Runs the session in a worker; frames are handed over without copying. */
export function workerMatcher(): Matcher {
  const w = new Worker(new URL("./track.worker.ts", import.meta.url), { type: "module" });
  let id = 0;
  const waiting = new Map<number, (s: TrackStep | null) => void>();
  let ready: ((s: TrackStep) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  w.onmessage = (e: MessageEvent<{ type: string; id?: number; step?: TrackStep | null; first?: TrackStep; message?: string }>) => {
    const d = e.data;
    if (d.type === "ready") ready?.(d.first!);
    else if (d.type === "step") (waiting.get(d.id!)?.(d.step ?? null), waiting.delete(d.id!));
    else if (d.type === "error") fail?.(new Error(d.message));
  };
  w.onerror = (e) => fail?.(new Error(e.message || "The tracking worker stopped"));
  const copy = (g: Gray) => {
    const data = g.data.slice().buffer;
    return { w: g.w, h: g.h, data };
  };
  return {
    inWorker: true,
    start: (first, spec) =>
      new Promise((res, rej) => {
        ready = res;
        fail = rej;
        const c = copy(first);
        w.postMessage({ type: "start", spec, ...c }, [c.data]);
      }),
    frame: (g) =>
      new Promise((res, rej) => {
        fail = rej;
        const n = id++;
        waiting.set(n, res);
        const c = copy(g);
        w.postMessage({ type: "frame", id: n, ...c }, [c.data]);
      }),
    close: () => w.terminate(),
  };
}

export const createMatcher = (): Matcher => (typeof Worker !== "undefined" ? workerMatcher() : inlineMatcher());

/**
 * Follow a source of frames with a matcher. \`frames(i)\` gives the gray frame i (or null at the end). The next frame
 * is made while the matcher works on the current one. Stops at the first frame the point is lost in.
 */
export async function followFrames(m: Matcher, count: number, frames: (i: number) => Promise<Gray | null>, spec: (first: Gray) => TrackSpec, o: { onStep?: (i: number, s: TrackStep) => void; signal?: AbortSignal } = {}): Promise<{ steps: TrackStep[]; lostAt?: number; cancelled?: boolean; frameError?: boolean }> {
  const steps: TrackStep[] = [];
  const first = await frames(0);
  if (!first) return { steps, frameError: true };
  const s0 = await m.start(first, spec(first));
  steps.push(s0);
  o.onStep?.(0, s0);
  let pending: Promise<TrackStep | null> | null = null;
  let pendingIndex = 0;
  const settle = async (): Promise<number | null> => {
    if (!pending) return null;
    const r = await pending;
    pending = null;
    if (!r) return pendingIndex;
    steps.push(r);
    o.onStep?.(pendingIndex, r);
    return null;
  };
  for (let i = 1; i < count; i++) {
    if (o.signal?.aborted) {
      await settle();
      return { steps, cancelled: true };
    }
    const g = await frames(i); // drawn while the previous frame is being matched
    if (!g) {
      await settle();
      return { steps, frameError: true };
    }
    const lost = await settle();
    if (lost !== null) return { steps, lostAt: lost };
    pending = m.frame(g);
    pendingIndex = i;
  }
  const lost = await settle();
  return lost === null ? { steps } : { steps, lostAt: lost };
}
