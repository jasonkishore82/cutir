import { create } from "zustand";
import { MAX_STEPS, macrosFromJson, macrosToJson, sanitizeMacro, type Macro, type Step } from "../lib/ai/macroData";

/**
 * Macros (phase 28). While recording, tool calls that changed something and commands that ran are added to a draft;
 * stopping saves it under a name. Macros live in this browser and travel as JSON files.
 */

const KEY = "cutir:macros";
const newId = () => Math.random().toString(36).slice(2, 10);

function load(): Macro[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.map((m) => sanitizeMacro(m, newId)).filter((m): m is Macro => !!m) : [];
  } catch {
    return [];
  }
}
const save = (macros: Macro[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(macros));
  } catch {
    /* storage unavailable */
  }
};

type MacroState = {
  macros: Macro[];
  recording: boolean;
  /** True while a macro plays, so what it does is not recorded again. */
  playing: boolean;
  draft: Step[];
  start: () => void;
  /** Save the draft as a macro; null when nothing was recorded. */
  stop: (name?: string) => Macro | null;
  discard: () => void;
  recordCall: (tool: string, args: unknown) => void;
  recordCommand: (id: string) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  dropStep: (id: string, index: number) => void;
  exportJson: (ids?: string[]) => string;
  importJson: (text: string) => { ok: boolean; added: number; skipped: number };
  setPlaying: (on: boolean) => void;
};

export const useMacros = create<MacroState>((set, get) => ({
  macros: load(),
  recording: false,
  playing: false,
  draft: [],

  start: () => set({ recording: true, draft: [] }),
  stop: (name) => {
    const steps = get().draft;
    set({ recording: false, draft: [] });
    if (!steps.length) return null;
    const m: Macro = { id: newId(), name: name?.trim() || `Macro ${get().macros.length + 1}`, steps, created: Date.now() };
    const macros = [...get().macros, m];
    save(macros);
    set({ macros });
    return m;
  },
  discard: () => set({ recording: false, draft: [] }),

  recordCall: (tool, args) => {
    const s = get();
    if (!s.recording || s.playing || s.draft.length >= MAX_STEPS) return;
    let plain: Record<string, unknown> = {};
    try {
      plain = JSON.parse(JSON.stringify(args ?? {}));
    } catch {
      return;
    }
    set({ draft: [...s.draft, { kind: "tool", tool, args: plain }] });
  },
  recordCommand: (id) => {
    const s = get();
    if (!s.recording || s.playing || id.startsWith("macro.") || id.startsWith("ai.") || s.draft.length >= MAX_STEPS) return;
    set({ draft: [...s.draft, { kind: "command", id }] });
  },

  rename: (id, name) => {
    const macros = get().macros.map((m) => (m.id === id ? { ...m, name: name.trim().slice(0, 60) || m.name } : m));
    save(macros);
    set({ macros });
  },
  remove: (id) => {
    const macros = get().macros.filter((m) => m.id !== id);
    save(macros);
    set({ macros });
  },
  dropStep: (id, index) => {
    const macros = get()
      .macros.map((m) => (m.id === id ? { ...m, steps: m.steps.filter((_, i) => i !== index) } : m))
      .filter((m) => m.steps.length);
    save(macros);
    set({ macros });
  },

  exportJson: (ids) => macrosToJson(get().macros.filter((m) => !ids || ids.includes(m.id))),
  importJson: (text) => {
    const r = macrosFromJson(text, newId);
    if (!r) return { ok: false, added: 0, skipped: 0 };
    const macros = [...get().macros, ...r.macros];
    save(macros);
    set({ macros });
    return { ok: true, added: r.macros.length, skipped: r.skipped };
  },
  setPlaying: (on) => set({ playing: on }),
}));
