import { create } from "zustand";
import { applyProfile, bind, keymapFromJson, keymapToJson, normalizeCombo, resetBindings, resolveBindings, unbind, PROFILES, type Bindings } from "../lib/commands/keymap";
import { defaultBindings } from "../lib/commands/registry";

/**
 * Interface preferences that follow the person (phase 27): the keymap, and the accessibility options. Kept in
 * localStorage. The theme classes are applied to the page root by `applyPrefs`.
 */

export type Motion = "system" | "reduce" | "full";
export type Contrast = "normal" | "high";
export const TEXT_SCALES = [0.9, 1, 1.15, 1.3, 1.5] as const;

type Saved = { keymap: Bindings; motion: Motion; contrast: Contrast; textScale: number; recent: string[] };

const KEY = "cutir:prefs";
const DEFAULTS: Saved = { keymap: {}, motion: "system", contrast: "normal", textScale: 1, recent: [] };

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<Saved>;
      const keymap: Bindings = {};
      for (const [id, list] of Object.entries(j.keymap ?? {})) {
        if (Array.isArray(list)) keymap[id] = list.map((c) => (typeof c === "string" ? normalizeCombo(c) : null)).filter((c): c is string => !!c);
      }
      return {
        keymap,
        motion: j.motion === "reduce" || j.motion === "full" ? j.motion : "system",
        contrast: j.contrast === "high" ? "high" : "normal",
        textScale: typeof j.textScale === "number" && j.textScale >= 0.8 && j.textScale <= 1.6 ? j.textScale : 1,
        recent: Array.isArray(j.recent) ? j.recent.filter((x): x is string => typeof x === "string").slice(0, 12) : [],
      };
    }
  } catch {
    /* storage unavailable or damaged */
  }
  return DEFAULTS;
}

type State = Saved & {
  setMotion: (m: Motion) => void;
  setContrast: (c: Contrast) => void;
  setTextScale: (n: number) => void;
  /** The key lists in force. */
  bindings: () => Bindings;
  addKey: (id: string, combo: string) => string[];
  removeKey: (id: string, combo: string) => void;
  resetKeys: (id?: string) => void;
  useProfile: (profileId: string) => void;
  importKeymap: (text: string) => { ok: boolean; skipped: number };
  exportKeymap: () => string;
  noteRun: (id: string) => void;
};

export const usePrefs = create<State>((set, get) => {
  const commit = (p: Partial<Saved>) => {
    set(p);
    try {
      const { keymap, motion, contrast, textScale, recent } = get();
      localStorage.setItem(KEY, JSON.stringify({ keymap, motion, contrast, textScale, recent }));
    } catch {
      /* storage unavailable */
    }
    applyPrefs();
  };
  return {
    ...load(),
    setMotion: (motion) => commit({ motion }),
    setContrast: (contrast) => commit({ contrast }),
    setTextScale: (textScale) => commit({ textScale }),
    bindings: () => resolveBindings(defaultBindings(), get().keymap),
    addKey: (id, combo) => {
      const r = bind(defaultBindings(), get().keymap, id, combo);
      commit({ keymap: r.overrides });
      return r.stolenFrom;
    },
    removeKey: (id, combo) => commit({ keymap: unbind(defaultBindings(), get().keymap, id, combo) }),
    resetKeys: (id) => commit({ keymap: resetBindings(get().keymap, id) }),
    useProfile: (profileId) => {
      const p = PROFILES.find((x) => x.id === profileId);
      if (p) commit({ keymap: applyProfile(defaultBindings(), p) });
    },
    importKeymap: (text) => {
      const r = keymapFromJson(text, new Set(Object.keys(defaultBindings())));
      if (!r) return { ok: false, skipped: 0 };
      commit({ keymap: r.overrides });
      return { ok: true, skipped: r.skipped };
    },
    exportKeymap: () => keymapToJson(get().keymap),
    noteRun: (id) => commit({ recent: [id, ...get().recent.filter((x) => x !== id)].slice(0, 12) }),
  };
});

/** Put the preferences on the page: classes on the root element and the text size. Safe to call often. */
export function applyPrefs() {
  if (typeof document === "undefined") return;
  const { motion, contrast, textScale } = usePrefs.getState();
  const root = document.documentElement;
  root.classList.toggle("contrast-high", contrast === "high");
  root.classList.toggle("motion-reduce", motion === "reduce");
  root.classList.toggle("motion-full", motion === "full");
  root.style.fontSize = `${Math.round(16 * textScale * 100) / 100}px`;
}
