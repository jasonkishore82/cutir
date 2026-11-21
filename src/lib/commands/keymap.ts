/**
 * Phase 27: key combinations and the keymap. Pure: no DOM beyond reading an event's fields, so it is tested in node.
 *
 * A combo is written like "Ctrl+Shift+K". Letters and digits are matched by physical key (so shortcuts work on any
 * layout), Ctrl and Cmd are the same modifier. A binding list belongs to a command id; the user's overrides replace a
 * command's whole list (an empty list means unbound).
 */

export type Bindings = Record<string, string[]>;

const MODS = ["Ctrl", "Alt", "Shift"] as const;

const NAMED: Record<string, string> = {
  Space: "Space", Enter: "Enter", NumpadEnter: "Enter", Escape: "Esc", Delete: "Delete", Backspace: "Backspace", Tab: "Tab",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Backquote: "`",
};

/** The key part of an event, or null for a bare modifier or something we do not name. */
export function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

type EventLike = { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** The canonical combo for a keyboard event, or null. */
export function comboFromEvent(e: EventLike): string | null {
  const k = keyName(e.code);
  if (!k) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(k);
  return parts.join("+");
}

const KEYS = new Set([...Object.values(NAMED), ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""), ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);

/** Normalise a typed combo ("ctrl + k", "cmd+K", "shift+?") to the canonical form, or null when it is not valid. */
export function normalizeCombo(text: string): string | null {
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  if (text.trim().endsWith("++")) parts.push("+");
  if (!parts.length) return null;
  const mods = new Set<string>();
  let key: string | null = null;
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === "ctrl" || p === "control" || p === "cmd" || p === "meta" || p === "command" || p === "mod") mods.add("Ctrl");
    else if (p === "alt" || p === "option") mods.add("Alt");
    else if (p === "shift") mods.add("Shift");
    else if (key === null) {
      const alias: Record<string, string> = { escape: "Esc", esc: "Esc", del: "Delete", return: "Enter", spacebar: "Space", " ": "Space", arrowleft: "Left", arrowright: "Right", arrowup: "Up", arrowdown: "Down" };
      const k = alias[p] ?? (raw.length === 1 ? raw.toUpperCase() : raw[0].toUpperCase() + raw.slice(1).toLowerCase());
      key = KEYS.has(k) ? k : /^f\d+$/i.test(raw) && KEYS.has(raw.toUpperCase()) ? raw.toUpperCase() : null;
      if (key === null) return null;
    } else return null;
  }
  if (key === null) return null;
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

/** How a combo reads on screen. */
export function formatCombo(combo: string, mac = false): string {
  return combo.split("+").map((p) => (mac ? { Ctrl: "Cmd", Alt: "Option", Shift: "Shift" }[p] ?? p : p)).join(mac ? " " : "+");
}

/** Resolve the lists that are in force: the defaults with the user's overrides on top. */
export function resolveBindings(defaults: Bindings, overrides: Bindings): Bindings {
  const out: Bindings = {};
  for (const id of Object.keys(defaults)) out[id] = overrides[id] ?? defaults[id];
  return out;
}

/** combo -> command ids that hold it, in command order. */
export function indexBindings(b: Bindings): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [id, list] of Object.entries(b)) for (const c of list) m.set(c, [...(m.get(c) ?? []), id]);
  return m;
}

/** Combos held by more than one command. The first one (command order) wins when the key is pressed. */
export function conflicts(b: Bindings): { combo: string; ids: string[] }[] {
  return [...indexBindings(b)].filter(([, ids]) => ids.length > 1).map(([combo, ids]) => ({ combo, ids }));
}

/**
 * Give `combo` to `id` (added to its list). Any other command holding it loses it, so the keymap never has a clash
 * the user did not see. Returns the new overrides and who lost the key.
 */
export function bind(defaults: Bindings, overrides: Bindings, id: string, combo: string): { overrides: Bindings; stolenFrom: string[] } {
  const now = resolveBindings(defaults, overrides);
  const next: Bindings = { ...overrides };
  const stolenFrom: string[] = [];
  for (const other of Object.keys(now)) {
    if (other !== id && now[other].includes(combo)) {
      next[other] = now[other].filter((c) => c !== combo);
      stolenFrom.push(other);
    }
  }
  const mine = now[id] ?? [];
  next[id] = mine.includes(combo) ? mine : [...mine, combo];
  return { overrides: tidy(defaults, next), stolenFrom };
}

/** Remove one combo from a command. */
export function unbind(defaults: Bindings, overrides: Bindings, id: string, combo: string): Bindings {
  const now = resolveBindings(defaults, overrides);
  return tidy(defaults, { ...overrides, [id]: (now[id] ?? []).filter((c) => c !== combo) });
}

/** Put a command (or, with no id, every command) back to its defaults. */
export function resetBindings(overrides: Bindings, id?: string): Bindings {
  if (!id) return {};
  const { [id]: _gone, ...rest } = overrides;
  void _gone;
  return rest;
}

/** Drop overrides that equal the default, so "reset" and "no change" look the same on disk. */
function tidy(defaults: Bindings, o: Bindings): Bindings {
  const out: Bindings = {};
  for (const [id, list] of Object.entries(o)) {
    const d = defaults[id];
    if (!d || d.length !== list.length || d.some((c, i) => c !== list[i])) out[id] = list;
  }
  return out;
}

/* ---------- profiles: Resolve-like and Premiere-like starting points ---------- */

export type Profile = { id: string; name: string; overrides: Bindings };

/** The defaults mix both: V select, B blade, S snapping. These move the keys that differ. */
export const PROFILES: Profile[] = [
  { id: "cutir", name: "Cutir (default)", overrides: {} },
  {
    id: "resolve",
    name: "Resolve-like",
    overrides: { "tool.select": ["A", "V"], "tool.blade": ["B"], "edit.bladeAtPlayhead": ["Ctrl+B"], "tool.trim": ["T"], "snap.toggle": ["N", "S"], "marker.add": ["M"] },
  },
  {
    id: "premiere",
    name: "Premiere-like",
    overrides: { "tool.select": ["V"], "tool.blade": ["C"], "edit.bladeAtPlayhead": ["Ctrl+K"], "tool.trim": ["B", "T"], "snap.toggle": ["S"], "marker.add": ["M"] },
  },
];

/** A profile as overrides, keeping only commands that exist and giving any key it takes away from the others. */
export function applyProfile(defaults: Bindings, profile: Profile): Bindings {
  let o: Bindings = {};
  for (const [id, list] of Object.entries(profile.overrides)) {
    if (!defaults[id]) continue;
    o = { ...o, [id]: [] };
    for (const c of list) o = bind(defaults, o, id, c).overrides;
  }
  return o;
}

/* ---------- import and export ---------- */

export const keymapToJson = (overrides: Bindings) => JSON.stringify({ cutirKeymap: 1, bindings: overrides }, null, 2);

/** Read a keymap file. Unknown commands and invalid combos are skipped and counted. */
export function keymapFromJson(text: string, known: Set<string>): { overrides: Bindings; skipped: number } | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const src = (j as { bindings?: unknown })?.bindings ?? j;
  if (!src || typeof src !== "object" || Array.isArray(src)) return null;
  const overrides: Bindings = {};
  let skipped = 0;
  for (const [id, list] of Object.entries(src as Record<string, unknown>)) {
    if (!known.has(id) || !Array.isArray(list)) {
      skipped++;
      continue;
    }
    const ok = list.map((c) => (typeof c === "string" ? normalizeCombo(c) : null));
    skipped += ok.filter((c) => c === null).length;
    overrides[id] = [...new Set(ok.filter((c): c is string => !!c))];
  }
  return { overrides, skipped };
}
