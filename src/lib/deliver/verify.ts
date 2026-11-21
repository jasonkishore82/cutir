import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { isAudioOnly, type Container } from "./presets";

/** Check a finished file: length, frame count, audio sync and a test decode of the first and last frames. */
export type Expected = { container: Container; seconds: number; fps: number; hasAudio: boolean };
export type Measured = {
  videoSeconds?: number;
  frames?: number;
  audioSeconds?: number;
  firstFrame?: boolean;
  lastFrame?: boolean;
  firstAudio?: boolean;
  bytes: number;
  head?: string;
};
export type Check = { name: string; ok: boolean; detail: string };
export type Verdict = { ok: boolean; checks: Check[] };

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** Compare what was measured with what was asked for. Pure, so it is tested without a browser. */
export function judge(e: Expected, m: Measured): Verdict {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add("File is not empty", m.bytes > 0, `${m.bytes} bytes`);

  if (e.container === "gif") {
    add("GIF header", (m.head ?? "").startsWith("GIF8"), m.head ?? "none");
  } else if (e.container === "png-seq") {
    add("Zip header", (m.head ?? "").startsWith("PK"), m.head ?? "none");
  } else if (isAudioOnly(e.container)) {
    const d = m.audioSeconds ?? 0;
    add("Duration", Math.abs(d - e.seconds) <= 0.1, `${fmt(d)} s, expected ${fmt(e.seconds)} s`);
    add("First audio decodes", !!m.firstAudio, m.firstAudio ? "ok" : "no audio decoded");
  } else {
    const d = m.videoSeconds ?? 0;
    add("Duration", Math.abs(d - e.seconds) <= Math.max(0.1, 2 / e.fps), `${fmt(d)} s, expected ${fmt(e.seconds)} s`);
    const want = Math.max(1, Math.ceil(e.seconds * e.fps));
    if (m.frames !== undefined) add("Frame count", Math.abs(m.frames - want) <= 1, `${m.frames} frames, expected ${want}`);
    if (e.hasAudio) {
      const a = m.audioSeconds;
      add("Audio present", a !== undefined && a > 0, a === undefined ? "no audio track" : `${fmt(a)} s`);
      if (a !== undefined && a > 0) add("Audio in sync", Math.abs(a - d) <= 0.25, `audio ${fmt(a)} s, video ${fmt(d)} s`);
    }
    add("First frame decodes", !!m.firstFrame, m.firstFrame ? "ok" : "could not decode");
    add("Last frame decodes", !!m.lastFrame, m.lastFrame ? "ok" : "could not decode");
  }
  return { ok: checks.every((c) => c.ok), checks };
}

const headOf = async (blob: Blob) => {
  const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return String.fromCharCode(...b.filter((x) => x >= 32 && x < 127));
};

/** Open the file again with a demuxer and decoder, as a player would. Never throws: a failure is a failed check. */
export async function verifyOutput(blob: Blob, e: Expected): Promise<Verdict> {
  const m: Measured = { bytes: blob.size };
  try {
    m.head = await headOf(blob);
    if (e.container !== "gif" && e.container !== "png-seq") {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      try {
        const v = await input.getPrimaryVideoTrack();
        const a = await input.getPrimaryAudioTrack();
        if (v && !isAudioOnly(e.container)) {
          m.videoSeconds = await v.computeDuration();
          m.frames = (await v.computePacketStats()).packetCount;
          const sink = new VideoSampleSink(v);
          const first = await sink.getSample(await v.getFirstTimestamp());
          m.firstFrame = !!first;
          first?.close();
          const last = await sink.getSample(Math.max(0, m.videoSeconds - 0.5 / e.fps));
          m.lastFrame = !!last;
          last?.close();
        }
        if (a) {
          m.audioSeconds = await a.computeDuration();
          if (isAudioOnly(e.container)) {
            const buf = await new AudioBufferSink(a).getBuffer(await a.getFirstTimestamp());
            m.firstAudio = !!buf && buf.buffer.length > 0;
          }
        }
      } finally {
        input.dispose();
      }
    }
  } catch (err) {
    return { ok: false, checks: [{ name: "Open the file", ok: false, detail: (err as Error).message || "could not read it" }] };
  }
  return judge(e, m);
}
