import { useEffect, useMemo, useRef, useState } from "react";
import { useOverlay } from "../store/overlay";
import { usePrefs } from "../store/prefs";
import { allCommands, search } from "../lib/commands/registry";
import { runFromPalette } from "../lib/commands/dispatch";
import { formatCombo } from "../lib/commands/keymap";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Ctrl+K: a searchable list of every command, setting, page, AI action and recent project. */
export default function CommandPalette() {
  const open = useOverlay((s) => s.palette);
  const close = () => useOverlay.getState().setPalette(false);
  const recent = usePrefs((s) => s.recent);
  const keymap = usePrefs((s) => s.keymap);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const back = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      back.current = document.activeElement;
      setQ("");
      setI(0);
      requestAnimationFrame(() => input.current?.focus());
    } else if (back.current instanceof HTMLElement) {
      back.current.focus?.();
      back.current = null;
    }
  }, [open]);

  const bindings = useMemo(() => usePrefs.getState().bindings(), [keymap, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => (open ? search(q, allCommands(), recent).slice(0, 60) : []), [q, open, recent]);
  useEffect(() => setI(0), [q]);
  useEffect(() => {
    list.current?.children[i]?.scrollIntoView({ block: "nearest" });
  }, [i]);

  if (!open) return null;
  const run = (n: number) => {
    const c = results[n];
    if (!c) return;
    close();
    void runFromPalette(c);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setI((v) => Math.min(results.length - 1, v + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setI((v) => Math.max(0, v - 1)));
    else if (e.key === "Enter") (e.preventDefault(), run(i));
    else if (e.key === "Escape") (e.preventDefault(), close());
    else if (e.key === "Tab") e.preventDefault(); // keep focus in the box: the list is driven with the arrows
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[14vh] backdrop-blur-sm" onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="w-[560px] max-w-[92vw] overflow-hidden rounded-2xl border border-white/10 bg-panel shadow-2xl shadow-black/60" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[i] ? `cmd-${results[i].id}` : undefined}
          aria-label="Search commands"
          placeholder="Type a command, page, setting, AI action or project"
          className="w-full border-b border-edge bg-transparent px-4 py-3 text-sm text-gray-100 outline-none placeholder:text-gray-500"
        />
        <ul id="palette-list" ref={list} role="listbox" className="max-h-[50vh] overflow-auto p-1">
          {results.length === 0 && <li className="px-3 py-6 text-center text-xs text-gray-500">Nothing matches "{q}".</li>}
          {results.map((c, n) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={n === i}
              onMouseMove={() => setI(n)}
              onClick={() => run(n)}
              className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 text-xs ${n === i ? "bg-accent/20 text-white" : "text-gray-300"}`}
            >
              <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-gray-500">{c.category}</span>
              <span className="flex-1 truncate">{c.title}</span>
              {(bindings[c.id] ?? []).slice(0, 2).map((k) => (
                <kbd key={k} className="rounded border border-edge bg-black/30 px-1.5 py-0.5 text-[10px] text-gray-300">{formatCombo(k, mac)}</kbd>
              ))}
            </li>
          ))}
        </ul>
        <div className="flex justify-between border-t border-edge px-3 py-1.5 text-[10px] text-gray-500">
          <span>Up and Down to choose, Enter to run, Esc to close</span>
          <span>{results.length} shown</span>
        </div>
      </div>
    </div>
  );
}
