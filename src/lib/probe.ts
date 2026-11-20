/**
 * Media probing in a worker (see probe.worker.ts), so importing many or very large files never blocks the UI.
 * Files are passed to the worker by reference; their contents are not copied.
 */

export type ProbeInfo = {
  readable: boolean;
  container?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  channels?: number;
  sampleRate?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  canDecodeVideo?: boolean;
  canDecodeAudio?: boolean;
};

let worker: Worker | null = null;
let next = 1;
const pending = new Map<number, { resolve: (v: ProbeInfo) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./probe.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ id: number; info?: ProbeInfo; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    if (e.data.info) p.resolve(e.data.info);
    else p.reject(new Error(e.data.error ?? "probe failed"));
  };
  worker.onerror = () => {
    // a crashed worker fails everything in flight; the next probe starts a fresh one
    for (const [, p] of pending) (clearTimeout(p.timer), p.reject(new Error("the media reader stopped")));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function probeMedia(file: File, timeoutMs = 30000): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("reading the file took too long"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    getWorker().postMessage({ id, file });
  });
}

/** Width and height of an image without decoding it on the main thread more than once. */
export async function probeImage(file: File): Promise<{ width: number; height: number } | undefined> {
  try {
    const bmp = await createImageBitmap(file);
    const r = { width: bmp.width, height: bmp.height };
    bmp.close();
    return r;
  } catch {
    return undefined;
  }
}

/** A short explanation when a file can be stored but not played back here. Empty when it is fine. */
export function playbackNote(info: ProbeInfo | undefined, kind: string): string {
  if (!info || kind === "image" || kind === "subtitle" || kind === "font") return "";
  if (!info.readable) return "This browser cannot read this file's format. Convert it to MP4 (H.264/AAC) or WebM to use it.";
  if (info.hasVideo && info.canDecodeVideo === false)
    return `The ${info.videoCodec ?? "video"} codec cannot be decoded in this browser. Convert to H.264 or VP9 to use the picture${info.hasAudio && info.canDecodeAudio ? "; the sound works" : ""}.`;
  if (info.hasAudio && info.canDecodeAudio === false) return `The ${info.audioCodec ?? "audio"} codec cannot be decoded in this browser. Convert the sound to AAC, Opus or MP3.`;
  return "";
}
