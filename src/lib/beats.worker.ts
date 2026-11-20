import { analyzeSamples } from "./energy";

/**
 * Browser fallback of beat detection: the main thread decodes the song to mono samples (workers have no
 * AudioContext) and this worker finds the beats and the energy curve off the main thread.
 */
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  try {
    let last = 0;
    const result = analyzeSamples(e.data.samples, e.data.sampleRate, (pct) => {
      if (pct - last >= 0.02) (last = pct), post({ type: "progress", pct });
    });
    post({ type: "result", result });
  } catch (err) {
    post({ type: "error", message: (err as Error).message || "Beat analysis failed" });
  }
};
