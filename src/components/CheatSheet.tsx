import { useEffect, useMemo, useRef } from "react";
import { useOverlay } from "../store/overlay";
import { usePrefs } from "../store/prefs";
import { staticCommands, type Category } from "../lib/commands/registry";
import { formatCombo } from "../lib/commands/keymap";
import "../lib/commands/builtin";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Keys that are fixed because they depend on what is selected: they are listed but not rebindable. */
export const FIXED_KEYS: { group: string; items: [string, string][] }[] = [
  {
    group: "Fixed keys (depend on what is selected)",
    items: [
      ["Delete", "Delete the selected clip, lyric block or keyframe (Shift: ripple)"],
      ["Left, Right", "Nudge the selected clip or lyric by a frame (Shift: ten); with nothing selected, step the playhead"],
      [", and .", "Nudge the selected clips by a frame"],
      ["Ctrl+C, V, D", "Copy, paste and duplicate the selected lyric block"],
      ["K", "Add a keyframe to the selected line at the playhead"],
      ["Space, Enter, Esc", "In tap-sync: start of the next line, end of this one, leave"],
    ],
  },
];

const ORDER: Category[] = ["Playback", "Tools", "Timeline", "Edit", "Pages", "View", "File", "Settings"];

/** The whole key map on one screen. Ctrl+/ or F1 opens it; Esc closes it. */
export default function CheatSheet() {
  const open = useOverlay((s) => s.cheat);
  const keymap = usePrefs((s) => s.keymap);
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);
  const close = () => useOverlay.getState().setCheat(false);

  useEffect(() => {
    if (open) {
      back.current = document.activeElement;
      ref.current?.focus();
    } else if (back.current instanceof HTMLElement) {
      back.current.focus?.();
      back.current = null;
    }
  }, [open]);

  const groups = useMemo(() => {
    const b = usePrefs.getState().bindings();
    return ORDER.map((cat) => ({ cat, items: staticCommands().filter((c) => c.category === cat && (b[c.id] ?? []).length > 0).map((c) => ({ c, keys: b[c.id] })) })).filter((g) => g.items.length);
  }, [keymap, open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onMouseDown={close}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), close())}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[88vh] w-[880px] max-w-[94vw] overflow-auto rounded-2xl border border-white/10 bg-panel p-5 shadow-2xl shadow-black/60 outline-none"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Keyboard shortcuts</h2>
          <button className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-edge" onClick={close}>Close</button>
        </div>
        <div className="columns-1 gap-6 text-xs md:columns-2">
          {groups.map((g) => (
            <section key={g.cat} className="mb-4 break-inside-avoid">
              <h3 className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">{g.cat}</h3>
              <ul className="space-y-1">
                {g.items.map(({ c, keys }) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 text-gray-300">
                    <span className="truncate">{c.title}</span>
                    <span className="flex shrink-0 gap-1">
                      {keys.map((k) => <kbd key={k} className="rounded border border-edge bg-black/30 px-1.5 py-0.5 text-[10px]">{formatCombo(k, mac)}</kbd>)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {FIXED_KEYS.map((g) => (
            <section key={g.group} className="mb-4 break-inside-avoid">
              <h3 className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">{g.group}</h3>
              <ul className="space-y-1">
                {g.items.map(([k, t]) => (
                  <li key={k} className="flex items-center justify-between gap-3 text-gray-300">
                    <span>{t}</span>
                    <kbd className="shrink-0 rounded border border-edge bg-black/30 px-1.5 py-0.5 text-[10px]">{k}</kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-gray-500">Rebind keys in Settings, Keyboard shortcuts. Ctrl+K searches every command.</p>
      </div>
    </div>
  );
}
