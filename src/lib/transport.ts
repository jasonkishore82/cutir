import { create } from "zustand";

/**
 * Playback transport. The audio element is the single source of truth for time;
 * when no audio is loaded a virtual clock stands in so the preview still plays.
 * Rendering reads getTime() every animation frame, never a timer.
 */

type PlaybackState = {
  playing: boolean;
  duration: number;
  hasAudio: boolean;
  loop: { start: number; end: number } | null;
};

export const usePlayback = create<PlaybackState>(() => ({
  playing: false,
  duration: 0,
  hasAudio: false,
  loop: null,
}));

const audio = new Audio();
audio.preload = "auto";

let hasAudio = false;
let fallbackDuration = 0;
let virtualTime = 0;
let lastNow = 0;

const set = usePlayback.setState;
const get = usePlayback.getState;

audio.addEventListener("loadedmetadata", () => set({ duration: audio.duration || 0 }));
audio.addEventListener("ended", () => set({ playing: false }));

export function getTime(): number {
  return hasAudio ? audio.currentTime : virtualTime;
}

export function setSource(url?: string) {
  pause();
  if (url) {
    hasAudio = true;
    audio.src = url;
    audio.load();
    set({ hasAudio: true, duration: 0 });
  } else {
    hasAudio = false;
    audio.removeAttribute("src");
    audio.load();
    virtualTime = 0;
    set({ hasAudio: false, duration: fallbackDuration });
  }
}

/** Used when there is no audio: playback length follows the last lyric line. */
export function setFallbackDuration(d: number) {
  fallbackDuration = d;
  if (!hasAudio) set({ duration: d });
}

export function seek(t: number) {
  const dur = get().duration;
  const clamped = Math.max(0, dur > 0 ? Math.min(t, dur) : t);
  if (hasAudio) audio.currentTime = clamped;
  else virtualTime = clamped;
}

export function play() {
  if (get().playing) return;
  const { duration } = get();
  if (duration > 0 && getTime() >= duration - 0.01) seek(0);
  lastNow = performance.now();
  if (hasAudio) {
    audio.play().catch(() => set({ playing: false }));
  }
  set({ playing: true });
}

export function pause() {
  if (hasAudio) audio.pause();
  set({ playing: false });
}

export function toggle() {
  get().playing ? pause() : play();
}

export function setLoop(loop: { start: number; end: number } | null) {
  set({ loop });
}

/** Call once per animation frame, before reading getTime(). */
export function tick() {
  const now = performance.now();
  const { playing, loop, duration } = get();

  if (playing && !hasAudio) {
    virtualTime += (now - lastNow) / 1000;
    if (duration > 0 && virtualTime >= duration) {
      virtualTime = duration;
      set({ playing: false });
    }
  }
  lastNow = now;

  if (playing && loop && getTime() >= loop.end) seek(loop.start);
}
