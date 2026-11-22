import { useMacros } from "../../store/macros";
/**
 * Phase 27: the command registry. Every menu item, tool, page switch and AI action is registered here once, with a
 * title, a category and default keys. The menu bar, the command palette, the shortcut settings and the cheat sheet all
 * read this list, so nothing can be reachable in one place and missing in another.
 */

export type Category = "File" | "Edit" | "Playback" | "Timeline" | "Tools" | "Pages" | "View" | "Settings" | "AI" | "Project" | "Macros";

export type Command = {
  id: string;
  title: string;
  category: Category;
  /** Extra words the palette matches on. */
  keywords?: string;
  /** Default key combos, canonical form (see keymap.ts). */
  keys?: string[];
  /** Returns false when it did not apply, so the key press goes on to whatever else listens (typing, a focused button). */
  run: () => boolean | void | Promise<void>;
  /** Hidden from the palette and greyed out while this returns false. */
  enabled?: () => boolean;
  /** Also fires while a button has focus (Space on a button normally presses it). */
  fromButtons?: boolean;
  /** Fires even while typing in a text field (the palette and the cheat sheet). Other commands leave typing alone. */
  global?: boolean;
  /** Also fires in tap-sync mode, which otherwise owns the keyboard. */
  inSync?: boolean;
};

const commands = new Map<string, Command>();
type Source = () => Command[];
const sources: Source[] = [];

/** Register a command. A second registration with the same id replaces the first (hot reload friendly). */
export function register(...list: Command[]) {
  for (const c of list) commands.set(c.id, c);
}

export function unregister(...ids: string[]) {
  for (const id of ids) commands.delete(id);
}

/** A source of commands that change while the app runs (recent projects). Called on every palette open. */
export function registerSource(s: Source) {
  sources.push(s);
}

export const getCommand = (id: string) => commands.get(id);
export const staticCommands = () => [...commands.values()];
export const allCommands = () => [...commands.values(), ...sources.flatMap((s) => s())];

/** Default bindings of every command that has keys. */
export function defaultBindings(): Record<string, string[]> {
  const o: Record<string, string[]> = {};
  for (const c of commands.values()) if (c.keys) o[c.id] = c.keys;
  return o;
}

/** Run a command by id. Returns false when it is unknown, disabled or declined. */
export async function runCommand(id: string): Promise<boolean> {
  const c = allCommands().find((x) => x.id === id);
  if (!c || (c.enabled && !c.enabled())) return false;
  const r = await c.run();
  if (r !== false) useMacros.getState().recordCommand(c.id);
  return r !== false;
}

/* ---------- palette search ---------- */

/** Score a query against a text: higher is better, 0 is no match. Word starts and runs of letters score most. */
export function score(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return (t[at - 1] === " " || at === 0 ? 600 : 400) - at;
  // every query word must appear, anywhere
  const words = q.split(/\s+/);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 300 - t.length / 10;
  // letters in order (a subsequence), e.g. "tgl snp"
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q.replace(/\s+/g, "")) {
    const k = t.indexOf(ch, i);
    if (k < 0) return 0;
    if (last >= 0 && k !== last + 1) gaps++;
    last = k;
    i = k + 1;
  }
  return Math.max(1, 100 - gaps * 8 - t.length / 10);
}

/** The commands matching a query, best first. An empty query lists everything in registry order. */
export function search(query: string, list: Command[], recent: string[] = []): Command[] {
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? 0 : 50 - i;
  };
  return list
    .filter((c) => !c.enabled || c.enabled())
    .map((c, order) => ({ c, s: Math.max(score(query, c.title), score(query, `${c.category} ${c.title}`) * 0.9, score(query, c.keywords ?? "") * 0.6), order }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s + (query ? 0 : rank(b.c.id)) - (a.s + (query ? 0 : rank(a.c.id))) || a.order - b.order)
    .map((x) => x.c);
}
