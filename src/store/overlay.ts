import { create } from "zustand";

/** Overlays and one-shot hand-offs between parts of the interface (phase 27). Not saved. */
export const useOverlay = create<{
  palette: boolean;
  cheat: boolean;
  /** Text the command palette hands to the AI composer; the composer takes it and clears it. */
  chatDraft: string;
  setPalette: (v: boolean) => void;
  setCheat: (v: boolean) => void;
  setChatDraft: (v: string) => void;
}>((set) => ({
  palette: false,
  cheat: false,
  chatDraft: "",
  setPalette: (palette) => set({ palette, ...(palette ? { cheat: false } : {}) }),
  setCheat: (cheat) => set({ cheat, ...(cheat ? { palette: false } : {}) }),
  setChatDraft: (chatDraft) => set({ chatDraft }),
}));
