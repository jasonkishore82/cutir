import type { Generator, Timeline } from "../model/types";
import type { ClipPlan, TemplateField } from "./titleTemplates";

/**
 * Saved multi-clip templates (phase 19). Select several generator clips (a bar and its text, a lower third with an
 * icon...), save them under a name, and add the whole group again later with new words. Positions in time are kept
 * relative to the first clip; the stacking order of the tracks is kept. Every title's words are exposed as a field.
 * Kept in the browser, like the single-title presets.
 */

export type SavedClip = { name: string; generator: Generator; duration: number; delay: number };
export type UserTemplate = { id: string; name: string; clips: SavedClip[]; /** Field key -> index of the clip whose words it fills. */ fields: { key: string; label: string; clip: number }[] };

const KEY = "cutir.userTemplates.v1";
type Store = Pick<Storage, "getItem" | "setItem">;
const browserStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadTemplates(store: Store | null = browserStore()): UserTemplate[] {
  try {
    const raw = store?.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as UserTemplate[]).filter((t) => t && typeof t.id === "string" && typeof t.name === "string" && Array.isArray(t.clips) && t.clips.length) : [];
  } catch {
    return [];
  }
}

/** Capture the generator clips among `clipIds` as a template. Clips that are not generators are left out. */
export function captureTemplate(tl: Timeline, clipIds: string[], name: string): UserTemplate {
  const clean = name.trim();
  if (!clean) throw new Error("give the template a name");
  const order = new Map(tl.tracks.map((t, i) => [t.id, i]));
  const picked = tl.clips
    .filter((c) => clipIds.includes(c.id) && c.generator)
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start);
  if (!picked.length) throw new Error("select at least one title, shape or other generated clip first");
  const t0 = Math.min(...picked.map((c) => c.start));
  const clips: SavedClip[] = picked.map((c) => ({ name: c.name ?? "Clip", generator: structuredClone(c.generator!), duration: c.duration, delay: Math.round((c.start - t0) * 1000) / 1000 }));
  const fields: UserTemplate["fields"] = [];
  clips.forEach((c, i) => {
    if (c.generator.type === "title") {
      const text = c.generator.title.text.replace(/\s+/g, " ").trim();
      fields.push({ key: `t${fields.length + 1}`, label: `Text ${fields.length + 1}: ${text.slice(0, 24)}${text.length > 24 ? "..." : ""}`, clip: i });
    }
  });
  return { id: `ut${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean, clips, fields };
}

export function saveTemplate(t: UserTemplate, store: Store | null = browserStore()): UserTemplate[] {
  const rest = loadTemplates(store).filter((x) => x.name.toLowerCase() !== t.name.toLowerCase());
  const next = [...rest, t];
  store?.setItem(KEY, JSON.stringify(next));
  return next;
}

export function deleteTemplate(id: string, store: Store | null = browserStore()): UserTemplate[] {
  const next = loadTemplates(store).filter((t) => t.id !== id);
  store?.setItem(KEY, JSON.stringify(next));
  return next;
}

/** The fields to fill in, with the saved words as defaults. */
export function templateFields(t: UserTemplate): TemplateField[] {
  return t.fields.map((f) => {
    const g = t.clips[f.clip]?.generator;
    return { key: f.key, label: f.label, default: g?.type === "title" ? g.title.text : "", multiline: true };
  });
}

/** Clip plans for the template with the given words. A title whose words changed drops its styled ranges (they would point at the wrong letters). */
export function buildUserTemplate(t: UserTemplate, values: Record<string, string> = {}): ClipPlan[] {
  return t.clips.map((c, i) => {
    const gen = structuredClone(c.generator);
    const f = t.fields.find((x) => x.clip === i);
    if (gen.type === "title" && f && typeof values[f.key] === "string" && values[f.key] !== gen.title.text) {
      gen.title = { ...gen.title, text: values[f.key], runs: [] };
    }
    return { name: c.name, generator: gen, duration: c.duration, delay: c.delay };
  });
}
