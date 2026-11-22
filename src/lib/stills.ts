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

/* ---------- kept with the project (phase 20) ---------- */

/** The most stills kept per project, and the most characters of images (about 2 MB), oldest dropped first. */
export const MAX_STILLS = 24;
export const MAX_STILL_CHARS = 2_000_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const stillsKey = (projectId: string) => `cutir:stills:${projectId}`;

const valid = (s: unknown): s is Still => {
  const o = s as Still;
  return !!o && typeof o.id === "string" && typeof o.name === "string" && typeof o.url === "string" && o.url.startsWith("data:image/") && Array.isArray(o.grade);
};

export function loadStills(projectId: string, store: Store | null = typeof localStorage === "undefined" ? null : localStorage): Still[] {
  try {
    const raw = store?.getItem(stillsKey(projectId));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter(valid) : [];
  } catch {
    return [];
  }
}

/** Keep the newest stills that fit. Returns what was kept. An empty list removes the key. */
export function saveStills(projectId: string, list: Still[], store: Store | null = typeof localStorage === "undefined" ? null : localStorage): Still[] {
  let kept = list.slice(-MAX_STILLS);
  while (kept.length > 1 && kept.reduce((n, s) => n + s.url.length, 0) > MAX_STILL_CHARS) kept = kept.slice(1);
  try {
    if (!kept.length) store?.removeItem(stillsKey(projectId));
    else store?.setItem(stillsKey(projectId), JSON.stringify(kept));
  } catch {
    /* storage full: the stills stay in memory for this session */
  }
  return kept;
}
