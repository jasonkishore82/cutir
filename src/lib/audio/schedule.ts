import type { Clip } from "../../model/types";
import { sourceAtRel } from "../retime";

/**
 * Sample-accurate playback plans (phase 21). A clip that is decoded into an AudioBuffer is played by an
 * AudioBufferSourceNode that the audio clock drives: it starts at an exact context time, at an exact buffer position,
 * and a reversed clip simply reads a reversed copy of the buffer. These functions work out where in the buffer to
 * play and when the voice has drifted from where the timeline says it should be. Pure, so they run under node.
 */

export type VoicePlan = {
  /** Position in the buffer to start from (seconds of the buffer; the reversed copy for a reversed clip). */
  offset: number;
  /** Playback rate of the buffer. */
  rate: number;
  /** Seconds of the buffer left to play before the clip's out point. */
  remaining: number;
};

export const MIN_RATE = 0.0625;
export const MAX_RATE = 16;
/** Most decoded sound kept for one clip: about 5.5 minutes of 48 kHz stereo. Longer sources play through a media element. */
export const MAX_BUFFER_BYTES = 128 * 1024 * 1024;

/** Whether a source of `seconds` is small enough to decode (stereo, 32 bit float). */
export const fitsInMemory = (seconds: number, sampleRate = 48000, channels = 2) => seconds > 0 && seconds * sampleRate * channels * 4 <= MAX_BUFFER_BYTES;

/** Speed ramps change the rate continuously, which a buffer voice cannot follow: those clips use a media element. */
export const bufferable = (c: Pick<Clip, "ramp" | "multicam" | "timelineId">) => !c.ramp?.keys.length && !c.multicam && !c.timelineId;

/**
 * Where a buffer voice has to play for the clip to be right at timeline time `t`, or null when it should be silent
 * (outside the clip, past the end, or too fast for a buffer). `bufDuration` is the decoded sound's length.
 */
export function voicePlan(c: Clip, t: number, transportRate: number, bufDuration: number): VoicePlan | null {
  const rel = t - c.start;
  if (rel < -1e-9 || rel >= c.duration) return null;
  const want = c.speed * transportRate;
  if (!(want >= MIN_RATE) || want > MAX_RATE) return null;
  const src = sourceAtRel(c, Math.max(0, rel)); // source time at this moment (backwards for a reversed clip)
  const offset = c.reverse ? bufDuration - src : src;
  const remaining = c.reverse ? bufDuration - c.sourceIn - offset : c.sourceOut - offset;
  if (offset < -1e-6 || remaining <= 1e-6) return null;
  return { offset: Math.max(0, offset), rate: want, remaining };
}

/** A running voice: where it was started in the buffer and on the audio clock. */
export type Voice = { startedAt: number; offset: number; rate: number };

/** Where the voice is now in its buffer. */
export const voicePosition = (v: Voice, now: number) => v.offset + (now - v.startedAt) * v.rate;

/** Seconds the voice is ahead (positive) or behind the plan. */
export const voiceDrift = (v: Voice, now: number, plan: VoicePlan) => voicePosition(v, now) - plan.offset;

/** Keep a running voice unless it drifted more than this many seconds or its rate changed. */
export const DRIFT_LIMIT = 0.04;
export const needsRestart = (v: Voice, now: number, plan: VoicePlan) => Math.abs(voiceDrift(v, now, plan)) > DRIFT_LIMIT || Math.abs(v.rate - plan.rate) > 1e-3;

/** How far ahead clips that are about to start are scheduled on the audio clock, in seconds. */
export const LOOKAHEAD = 0.15;

/**
 * Clips that start within the lookahead window: each with the context time to start it. `clock` maps timeline
 * seconds to audio-clock seconds (now + (clipStart - t) / rate).
 */
export function upcoming(clips: Clip[], t: number, transportRate: number, now: number): { clip: Clip; when: number }[] {
  if (transportRate <= 0) return [];
  return clips
    .filter((c) => c.start > t && c.start - t <= LOOKAHEAD * transportRate)
    .map((clip) => ({ clip, when: now + (clip.start - t) / transportRate }));
}
