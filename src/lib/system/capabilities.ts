/**
 * The start-up capability check (phase 30). Every browser feature Cutir leans on is listed with what happens without
 * it, so a missing feature gives a clear message instead of a blank preview. Pure: `detect` reads the browser,
 * `check` turns what was found into a report and is tested in node.
 */

export type Env = {
  webgl2: boolean;
  webgpu: boolean;
  webcodecsVideo: boolean;
  webcodecsAudio: boolean;
  opfs: boolean;
  filePicker: boolean;
  offscreenCanvas: boolean;
  workers: boolean;
  indexedDb: boolean;
  isolated: boolean;
  serviceWorker: boolean;
  cores: number;
  memoryGB: number;
};

export type Need = "required" | "recommended" | "optional";
export type Capability = { id: string; name: string; need: Need; ok: boolean; without: string };
export type Report = { items: Capability[]; blocking: Capability[]; degraded: Capability[]; ok: boolean };

const SPEC: { id: string; name: string; need: Need; without: string; test?: (e: Env) => boolean }[] = [
  { id: "workers", name: "Web Workers", need: "required", without: "Cutir cannot run: decoding, thumbnails and scripts all use workers." },
  { id: "indexedDb", name: "IndexedDB", need: "required", without: "Cutir cannot keep media between visits." },
  { id: "webcodecs", name: "WebCodecs", need: "required", without: "Video cannot be decoded or exported. Use a current Chrome, Edge or Safari.", test: (e) => e.webcodecsVideo },
  { id: "webgl2", name: "WebGL 2", need: "recommended", without: "Effects run on the slower canvas path and plugin effects are skipped. Playback of heavy projects may drop frames." },
  { id: "opfs", name: "Origin private file system", need: "recommended", without: "Media is kept in IndexedDB instead: it works, but large files are slower to read and write." },
  { id: "offscreenCanvas", name: "OffscreenCanvas", need: "recommended", without: "Thumbnails and waveforms are drawn on the page, which can make scrolling jerky." },
  { id: "isolated", name: "Cross-origin isolation", need: "recommended", without: "The multi-threaded ffmpeg fallback is unavailable; exports that need it run on one thread." },
  { id: "webcodecsAudio", name: "WebCodecs audio", need: "recommended", without: "Audio exports fall back to a slower encoder, and some audio formats cannot be read." },
  { id: "filePicker", name: "File System Access", need: "optional", without: "Files open through the normal file dialog and are saved to Downloads." },
  { id: "webgpu", name: "WebGPU", need: "optional", without: "Nothing: effects use WebGL 2." },
  { id: "serviceWorker", name: "Service workers", need: "optional", without: "Cutir cannot be installed or used offline." },
];

export function check(env: Env): Report {
  const items = SPEC.map((s) => ({ id: s.id, name: s.name, need: s.need, without: s.without, ok: s.test ? s.test(env) : !!(env as unknown as Record<string, unknown>)[s.id] }));
  const blocking = items.filter((i) => !i.ok && i.need === "required");
  const degraded = items.filter((i) => !i.ok && i.need === "recommended");
  return { items, blocking, degraded, ok: !blocking.length };
}

/** One message for the person: what is missing and what it means, most serious first. Empty when all is well. */
export function message(r: Report): string {
  const bad = [...r.blocking, ...r.degraded];
  return bad.map((i) => `${i.name}: ${i.without}`).join(" ");
}

/** Read the real browser. */
export function detect(g: any = globalThis): Env {
  const nav = g.navigator ?? {};
  let webgl2 = false;
  try {
    const c = typeof g.OffscreenCanvas !== "undefined" ? new g.OffscreenCanvas(1, 1) : g.document?.createElement("canvas");
    webgl2 = !!c?.getContext("webgl2");
  } catch {
    webgl2 = false;
  }
  return {
    webgl2,
    webgpu: !!nav.gpu,
    webcodecsVideo: typeof g.VideoEncoder !== "undefined" && typeof g.VideoDecoder !== "undefined",
    webcodecsAudio: typeof g.AudioEncoder !== "undefined" && typeof g.AudioDecoder !== "undefined",
    opfs: !!nav.storage?.getDirectory,
    filePicker: typeof g.showOpenFilePicker === "function",
    offscreenCanvas: typeof g.OffscreenCanvas !== "undefined",
    workers: typeof g.Worker !== "undefined",
    indexedDb: typeof g.indexedDB !== "undefined",
    isolated: !!g.crossOriginIsolated,
    serviceWorker: !!nav.serviceWorker,
    cores: Number(nav.hardwareConcurrency) || 1,
    memoryGB: Number(nav.deviceMemory) || 0,
  };
}
