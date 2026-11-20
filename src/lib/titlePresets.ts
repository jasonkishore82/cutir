import type { TitleSpec } from "../model/types";
import { titleOf } from "./titles";

/**
 * User title presets (phase 19): the look of a title (font, colours, box, animator...) saved under a name and kept
 * in the browser, so it can be added again with new words. The text and its styled ranges are not part of a look.
 */

export type TitlePreset = { id: string; name: string; look: Omit<TitleSpec, "text" | "runs"> };

const KEY = "cutir.titlePresets.v1";

type Store = Pick<Storage, "getItem" | "setItem">;
const browserStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadPresets(store: Store | null = browserStore()): TitlePreset[] {
  try {
    const raw = store?.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as TitlePreset[]).filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && p.look) : [];
  } catch {
    return [];
  }
}

export function savePreset(name: string, title: TitleSpec, store: Store | null = browserStore()): TitlePreset[] {
  const clean = name.trim();
  if (!clean) throw new Error("give the preset a name");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { text, runs, ...look } = structuredClone(title);
  const rest = loadPresets(store).filter((p) => p.name.toLowerCase() !== clean.toLowerCase());
  const next = [...rest, { id: `tp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean, look }];
  store?.setItem(KEY, JSON.stringify(next));
  return next;
}

export function deletePreset(id: string, store: Store | null = browserStore()): TitlePreset[] {
  const next = loadPresets(store).filter((p) => p.id !== id);
  store?.setItem(KEY, JSON.stringify(next));
  return next;
}

/** A title with this preset's look and the given words. Fields missing from an old preset take the defaults. */
export const titleFromPreset = (p: TitlePreset, text: string): TitleSpec => titleOf({ ...structuredClone(p.look), text, runs: [] });
