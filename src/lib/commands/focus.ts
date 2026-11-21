import { indexBindings } from "./keymap";
import type { Command } from "./registry";

/** What the focused element is, reduced to what the key rules need. */
export type Focus = { tag: string; type?: string; editable: boolean; role?: string };

const TEXT_INPUTS = new Set(["", "text", "search", "url", "tel", "email", "password", "number", "date", "time", "datetime-local", "month", "week"]);

export const focusOf = (el: Element | null): Focus => {
  const h = el as HTMLElement | null;
  if (!h) return { tag: "", editable: false };
  return { tag: h.tagName, type: (h as HTMLInputElement).type, editable: h.isContentEditable, role: h.getAttribute?.("role") ?? undefined };
};

/** In a field where typing is expected (so plain keys and editing shortcuts belong to the field). */
export const isTyping = (f: Focus) => f.editable || f.tag === "TEXTAREA" || f.tag === "SELECT" || (f.tag === "INPUT" && TEXT_INPUTS.has((f.type ?? "text").toLowerCase()));

/** Space and Enter press whatever control has focus; leave them to it unless the command asks for them. */
export const isPressable = (f: Focus) =>
  f.tag === "BUTTON" || f.tag === "A" || f.tag === "SUMMARY" || (f.tag === "INPUT" && ["checkbox", "radio", "button", "submit"].includes((f.type ?? "").toLowerCase())) || ["button", "tab", "menuitem", "checkbox", "switch", "option"].includes(f.role ?? "");

/** Whether a key press must be left alone for the element that has focus. Pure, so it is tested without a browser. */
export function blocked(f: Focus, cmd: Pick<Command, "global" | "fromButtons" | "inSync">, combo: string, opts: { sync: boolean; overlay: boolean }): boolean {
  if (cmd.global) return false;
  if (opts.overlay) return true; // a dialog is open: it owns the keyboard
  if (opts.sync && !cmd.inSync) return true; // tap-sync owns Space, Enter and Esc
  if (isTyping(f)) return true;
  if ((combo === "Space" || combo === "Enter") && isPressable(f) && !cmd.fromButtons) return true;
  return false;
}

/** Which command a combo runs: the first holder, in command order, that is enabled. */
export function commandFor(combo: string, bindings: Record<string, string[]>, enabled: (id: string) => boolean): string | undefined {
  return indexBindings(bindings).get(combo)?.find(enabled);
}
