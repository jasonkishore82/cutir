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
  /** Playback speed: 1 = normal, 0.5 = slow motion, 2/4/8 = fast, negative = reverse (JKL shuttle). */
  rate: number;
};

export const usePlayback = create<PlaybackState>(() => ({
  playing: false,
  duration: 0,
  hasAudio: false,
  loop: null,
  rate: 1,
}));

const audio = new Audio();
audio.preload = "auto";

/** The song's audio element, for the mixer to route through its strips. */
export const songElement = () => audio;

let hasAudio = false;
let fallbackDuration = 0;
let virtualTime = 0;
let lastNow = 0;

const set = usePlayback.setState;
const get = usePlayback.getState;

audio.addEventListener("loadedmetadata", () => set({ duration: audio.duration || 0 }));
audio.addEventListener("ended", () => set({ playing: false }));

/** The clock. The song is the master while it plays forward; otherwise (no song, reverse) a virtual clock runs. */
export function getTime(): number {
  return hasAudio && !reversing ? audio.currentTime : virtualTime;
}

let reversing = false;

/** Mute the song without stopping the clock (its track is muted, or another track is soloed). */
export function setSongMuted(muted: boolean) {
  if (audio.muted !== muted) audio.muted = muted;
}

/** Set the shuttle speed. Forward speeds keep the song as the clock (pitch preserved); reverse plays silently. */
export function setRate(rate: number) {
  const r = Math.max(-8, Math.min(8, rate || 1));
  const wasReverse = reversing;
  reversing = r < 0;
  if (reversing && !wasReverse) {
    virtualTime = hasAudio ? audio.currentTime : virtualTime;
    if (hasAudio) audio.pause();
  } else if (!reversing && wasReverse && hasAudio) {
    audio.currentTime = virtualTime;
    if (get().playing) audio.play().catch(() => set({ playing: false }));
  }
  if (r > 0 && hasAudio) {
    audio.preservesPitch = true;
    audio.playbackRate = Math.max(0.0625, Math.min(16, r));
  }
  lastNow = performance.now();
  set({ rate: r });
}

/** JKL: L plays forward (again: faster), J plays in reverse (again: faster), K stops. Shift gives half speed. */
export function shuttle(key: "J" | "K" | "L", slow = false) {
  const { playing, rate } = get();
  if (key === "K") {
    pause();
    setRate(1);
    return;
  }
  const dir = key === "L" ? 1 : -1;
  let next: number;
  if (slow) next = dir * 0.5;
  else if (!playing || Math.sign(rate) !== dir || Math.abs(rate) < 1) next = dir;
  else next = Math.max(-8, Math.min(8, rate * 2));
  setRate(next);
  if (!playing) play();
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
  virtualTime = clamped;
  if (hasAudio) audio.currentTime = clamped;
}

export function play() {
  if (get().playing) return;
  const { duration } = get();
  if (duration > 0 && getTime() >= duration - 0.01) seek(0);
  lastNow = performance.now();
  if (hasAudio && !reversing) {
    audio.play().catch(() => set({ playing: false }));
  }
  set({ playing: true });
}

export function pause() {
  if (hasAudio) {
    audio.pause();
    if (reversing) audio.currentTime = virtualTime;
  }
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

  const rate = get().rate;
  if (playing && (!hasAudio || reversing)) {
    virtualTime += ((now - lastNow) / 1000) * rate;
    if (duration > 0 && virtualTime >= duration) {
      virtualTime = duration;
      set({ playing: false });
    }
    if (virtualTime <= 0) {
      virtualTime = 0;
      if (reversing) set({ playing: false });
    }
  }
  lastNow = now;

  if (playing && loop) {
    if (rate >= 0 && getTime() >= loop.end) seek(loop.start);
    else if (rate < 0 && getTime() <= loop.start) seek(loop.end);
  }
}
