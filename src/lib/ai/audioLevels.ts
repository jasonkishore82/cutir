import type { ProjectDoc } from "../../model/types";
import { useMedia } from "../../store/media";
import { LEVEL_RATE, levelsOf, type Levels } from "./silence";
import { mediaUrl } from "../captions/run";

/** Browser side of silence finding: decode the files the timeline plays and measure their loudness. */

const cache = new Map<string, Levels>();

async function bytesOf(doc: ProjectDoc, mediaId: string): Promise<ArrayBuffer> {
  const url = mediaUrl(doc, mediaId);
  if (url) return (await fetch(url)).arrayBuffer();
  const m = doc.media.find((x) => x.id === mediaId);
  const file = m?.poolId ? await useMedia.getState().fileOf(m.poolId) : null;
  if (!file) throw new Error(`${m?.name ?? "A file"} is not available to read. Open it from the media library first.`);
  return file.arrayBuffer();
}

/** Loudness curves for these media ids (decoded once and kept for the session). */
export async function levelsFor(doc: ProjectDoc, mediaIds: string[], signal?: AbortSignal): Promise<Record<string, Levels>> {
  const out: Record<string, Levels> = {};
  const ctx = new AudioContext();
  try {
    for (const id of new Set(mediaIds)) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const hit = cache.get(id);
      if (hit) {
        out[id] = hit;
        continue;
      }
      const buf = await ctx.decodeAudioData(await bytesOf(doc, id));
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
      }
      out[id] = cache.set(id, { rate: LEVEL_RATE, db: levelsOf(mono, buf.sampleRate, LEVEL_RATE) }).get(id)!;
    }
  } finally {
    void ctx.close();
  }
  return out;
}
