import { create } from "zustand";
import { DEFAULT_RULES, type CaptionRules } from "../lib/captions/checks";
import { DEFAULT_FILLERS } from "../lib/captions/transcript";
import type { SafeArea } from "../lib/captions/presets";

/** Caption settings that follow the person, not the project: rules, look, engine, vocabulary. Kept in localStorage. */
export type CaptionPrefs = {
  rules: CaptionRules;
  presetId: string;
  safe: SafeArea;
  /** Draw the safe areas over the viewer. */
  showSafe: boolean;
  engine: "local" | "cloud";
  model: string;
  language: string;
  vocabulary: string;
  fillers: string;
  pauseMin: number;
  pauseKeep: number;
};

const KEY = "cutir:captionPrefs";
const DEFAULTS: CaptionPrefs = {
  rules: DEFAULT_RULES,
  presetId: "classic",
  safe: "title",
  showSafe: false,
  engine: "local",
  model: "base",
  language: "",
  vocabulary: "",
  fillers: DEFAULT_FILLERS.join(", "),
  pauseMin: 0.8,
  pauseKeep: 0.3,
};

function load(): CaptionPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<CaptionPrefs>;
      return { ...DEFAULTS, ...j, rules: { ...DEFAULT_RULES, ...(j.rules ?? {}) } };
    }
  } catch {
    /* storage unavailable or damaged: use the defaults */
  }
  return DEFAULTS;
}

export const useCaptionPrefs = create<CaptionPrefs & { set: (p: Partial<CaptionPrefs>) => void }>((setState, get) => ({
  ...load(),
  set: (p) => {
    setState(p);
    try {
      const { set: _s, ...rest } = get();
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      /* storage unavailable */
    }
  },
}));
