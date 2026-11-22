import { comboFromEvent } from "./keymap";
import { allCommands, getCommand, type Command } from "./registry";
import { blocked, commandFor, focusOf } from "./focus";
import { usePrefs } from "../../store/prefs";
import { useProject } from "../../store/project";
import { useLibrary } from "../../store/library";
import { useMacros } from "../../store/macros";
import "./builtin";

/**
 * One keyboard listener for every rebindable command. It runs in the capture phase so a rebound key wins over the
 * older handlers; a command that returns false lets the key go on to them.
 */
export function installKeymap(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || e.repeat && (e.code === "Space" || e.code === "Enter")) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    const bindings = usePrefs.getState().bindings();
    const f = focusOf(document.activeElement);
    // any open dialog (export, settings, the palette, the cheat sheet) owns the keyboard
    const overlay = !!document.querySelector('[role="dialog"]');
    const sync = useProject.getState().syncMode;
    const inEditor = useLibrary.getState().screen === "editor";
    const id = commandFor(combo, bindings, (cid) => {
      const c = getCommand(cid);
      return !!c && (!c.enabled || c.enabled()) && !blocked(f, c, combo, { sync, overlay });
    });
    if (!id) return;
    const c = getCommand(id)!;
    // outside the editor only the global commands (palette, cheat sheet) apply
    if (!inEditor && !c.global) return;
    if (c.fromButtons && f.tag === "BUTTON") (document.activeElement as HTMLElement).blur();
    const r = c.run();
    if (r === false) return;
    useMacros.getState().recordCommand(id);
    e.preventDefault();
    e.stopPropagation();
    if (!c.global) usePrefs.getState().noteRun(id);
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

/** Run a command chosen in the palette and remember it. */
export async function runFromPalette(c: Command) {
  usePrefs.getState().noteRun(c.id);
  const r = await c.run();
  if (r !== false) useMacros.getState().recordCommand(c.id);
}

export { allCommands };
