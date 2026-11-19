import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_MEDIUM, QUALITY_HIGH, StreamTarget, type Target } from "mediabunny";

/**
 * Makes proxies and optimized media off the main thread (phase 16).
 *
 *   proxy      smaller H.264 copy (keyframe every second) for smooth playback of large sources
 *   optimized  full-size H.264 copy with a keyframe every second, for sources that are slow to seek
 *
 * The result is streamed straight into the Origin Private File System, so large files never sit in memory. If this
 * browser cannot write OPFS files from a worker, the bytes are returned to the page instead.
 * Sound is left out: timeline audio always plays from the original file.
 */

type Job = { id: number; file: File; key: string; mode: "proxy" | "optimized"; height?: number };
const running = new Map<number, Conversion>();

async function opfsWritable(key: string): Promise<{ writable: FileSystemWritableFileStream; handle: FileSystemFileHandle } | null> {
  try {
    const parts = ["cutir", ...key.split("/").filter(Boolean)];
    let dir = await navigator.storage.getDirectory();
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    if (!("createWritable" in handle)) return null;
    return { writable: await handle.createWritable(), handle };
  } catch {
    return null;
  }
}

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<Job | { cancel: number }>) => {
  if ("cancel" in e.data) {
    await running.get(e.data.cancel)?.cancel();
    return;
  }
  const job = e.data;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(job.file) });
  const disk = await opfsWritable(job.key);
  const target: Target = disk ? new StreamTarget(disk.writable as unknown as WritableStream) : new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: {
        ...(job.mode === "proxy" && job.height ? { height: job.height } : {}),
        codec: "avc",
        keyFrameInterval: 1, // a keyframe every second: fast seeking
        bitrate: job.mode === "proxy" ? QUALITY_MEDIUM : QUALITY_HIGH,
        forceTranscode: true,
      },
      audio: { discard: true },
    });
    if (!conversion.isValid) throw new Error(conversion.discardedTracks.map((d) => d.reason).join(", ") || "this file cannot be converted here");
    running.set(job.id, conversion);
    conversion.onProgress = (p) => post({ id: job.id, progress: p });
    await conversion.execute();
    if (disk) {
      const size = (await disk.handle.getFile()).size;
      post({ id: job.id, done: true, size, stored: "opfs" });
    } else {
      const buf = (target as BufferTarget).buffer!;
      post({ id: job.id, done: true, size: buf.byteLength, stored: "page", buffer: buf }, [buf]);
    }
  } catch (err) {
    post({ id: job.id, error: (err as Error).name === "ConversionCanceledError" ? "cancelled" : (err as Error).message || "conversion failed" });
  } finally {
    running.delete(job.id);
    input.dispose();
  }
};
