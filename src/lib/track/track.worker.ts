import { TrackSession, type TrackSpec } from "./session";

/**
 * Tracking off the main thread (phase 22). The page draws each frame and sends its gray pixels; this worker does the
 * block matching (the slow part) and answers with the followed point. The page can draw the next frame while this one
 * is being matched.
 */
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
let session: TrackSession | null = null;

type Msg =
  | { type: "start"; spec: TrackSpec; w: number; h: number; data: ArrayBuffer }
  | { type: "frame"; id: number; w: number; h: number; data: ArrayBuffer };

self.onmessage = (e: MessageEvent<Msg>) => {
  const d = e.data;
  try {
    if (d.type === "start") {
      session = new TrackSession({ w: d.w, h: d.h, data: new Uint8Array(d.data) }, d.spec);
      post({ type: "ready", first: session.first() });
    } else if (d.type === "frame") {
      if (!session) throw new Error("tracking was not started");
      post({ type: "step", id: d.id, step: session.next({ w: d.w, h: d.h, data: new Uint8Array(d.data) }) });
    }
  } catch (err) {
    post({ type: "error", message: (err as Error).message || "Tracking failed" });
  }
};
