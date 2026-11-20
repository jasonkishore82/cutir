/// <reference lib="webworker" />
import { findLag } from "./sync";

/** Cross-correlation off the main thread: { id, a, b, sr, maxSeconds } in, { id, lag, confidence } out. */
self.onmessage = (e: MessageEvent<{ id: number; a: Float32Array; b: Float32Array; sr: number; maxSeconds?: number }>) => {
  const { id, a, b, sr, maxSeconds } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, ...findLag(a, b, sr, maxSeconds) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : "sync failed" });
  }
};
