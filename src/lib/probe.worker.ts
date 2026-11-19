import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import type { ProbeInfo } from "./probe";

/**
 * Reads container and track information from a media file off the main thread. mediabunny only reads the parts of
 * the file it needs (headers and a sample of packets), so even very large files are probed quickly.
 */
self.onmessage = async (e: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = e.data;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const info: ProbeInfo = { readable: await input.canRead() };
    if (info.readable) {
      info.container = (await input.getFormat()).name;
      info.duration = await input.computeDuration();
      const v = await input.getPrimaryVideoTrack();
      const a = await input.getPrimaryAudioTrack();
      if (v) {
        info.width = v.displayWidth;
        info.height = v.displayHeight;
        info.videoCodec = v.codec ?? undefined;
        info.canDecodeVideo = await v.canDecode();
        const stats = await v.computePacketStats(120);
        if (stats.averagePacketRate > 0) info.fps = Math.round(stats.averagePacketRate * 100) / 100;
      }
      if (a) {
        info.audioCodec = a.codec ?? undefined;
        info.channels = a.numberOfChannels;
        info.sampleRate = a.sampleRate;
        info.canDecodeAudio = await a.canDecode();
      }
      info.hasVideo = !!v;
      info.hasAudio = !!a;
    }
    (self as unknown as Worker).postMessage({ id, info });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message || "could not read the file" });
  } finally {
    input.dispose();
  }
};
