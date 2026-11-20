import { editProjectStyle } from "./styleEdit";
import type { Project } from "../store/project";

/** A flat three-colour poster look: `bg` fills the frame, `text` is the lettering, `accent` the highlight / key words. */
export type Palette = { id: string; name: string; bg: string; text: string; accent: string };

export const POSTER_PALETTES: Palette[] = [
  { id: "berry", name: "Berry", bg: "#7a2b50", text: "#f5a44b", accent: "#43898b" },
  { id: "navy", name: "Navy", bg: "#1f2a52", text: "#f4e3b5", accent: "#e2674a" },
  { id: "plum", name: "Plum", bg: "#4a2a6b", text: "#ffd36b", accent: "#4fc2a8" },
  { id: "tomato", name: "Tomato", bg: "#c8402f", text: "#fbe6c8", accent: "#26413c" },
  { id: "bubblegum", name: "Bubblegum", bg: "#ee6f98", text: "#ffffff", accent: "#f9e060" },
  { id: "sunny", name: "Sunny", bg: "#f9d800", text: "#111111", accent: "#e23b2e" },
  { id: "orange", name: "Orange", bg: "#f7821b", text: "#ffffff", accent: "#ffe08a" },
  { id: "wine", name: "Wine", bg: "#852d4f", text: "#ffa94a", accent: "#8da878" },
  { id: "forest", name: "Forest", bg: "#1f4d3a", text: "#f2c75a", accent: "#e0734e" },
];

/** Apply a palette: flat background, text colour and highlight accent (one pure project edit, so one undo step). */
export function applyPalette(project: Project, pal: Palette): Project {
  const p = editProjectStyle(project, { scope: "project" }, { set: [["color", pal.text], ["highlight.color", pal.accent]] });
  return { ...p, background: { type: "gradient", colors: [pal.bg, pal.bg], angle: 0, noise: false } };
}
