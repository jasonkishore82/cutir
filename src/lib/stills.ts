import { create } from "zustand";
import type { ClipEffect } from "../model/types";

/** The effects that make up a grade (phase 20): what a still remembers and what applying it copies. */
export const GRADE_EFFECTS = ["grade", "curves", "lut", "colour-space"];

export type Still = { id: string; name: string; /** A JPEG data URL of the frame as it was shown. */ url: string; /** The colour effects of the clip at the time. */ grade: ClipEffect[] };

export type CompareMode = "off" | "wipe";

type StillsState = {
  stills: Still[];
  /** The still shown against the viewer, and how. `pos` is the divider, 0..1 from the left. */
  compare: { id: string | null; mode: CompareMode; pos: number };
  add: (s: Omit<Still, "id">) => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  setCompare: (c: Partial<StillsState["compare"]>) => void;
};

let n = 0;
export const useStills = create<StillsState>((set) => ({
  stills: [],
  compare: { id: null, mode: "off", pos: 0.5 },
  add: (s) => set((st) => ({ stills: [...st.stills, { ...s, id: `still-${Date.now().toString(36)}-${n++}` }] })),
  remove: (id) => set((st) => ({ stills: st.stills.filter((x) => x.id !== id), compare: st.compare.id === id ? { ...st.compare, id: null, mode: "off" } : st.compare })),
  rename: (id, name) => set((st) => ({ stills: st.stills.map((x) => (x.id === id ? { ...x, name } : x)) })),
  setCompare: (c) => set((st) => ({ compare: { ...st.compare, ...c } })),
}));

/** Keep only the grade effects of a stack, as independent copies. */
export const gradeOf = (stack: ClipEffect[]): ClipEffect[] => structuredClone(stack.filter((e) => GRADE_EFFECTS.includes(e.type)));
