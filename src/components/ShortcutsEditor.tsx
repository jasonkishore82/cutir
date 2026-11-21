import { useEffect, useMemo, useState } from "react";
import { usePrefs } from "../store/prefs";
import { getCommand, score, staticCommands } from "../lib/commands/registry";
import { comboFromEvent, formatCombo, PROFILES } from "../lib/commands/keymap";
import { downloadBlob } from "../lib/exporter";
import { Card } from "./ui";
import { FIXED_KEYS } from "./CheatSheet";
import "../lib/commands/builtin";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const btn = "rounded-lg border border-edge px-3 py-1.5 text-[13px] text-gray-300 hover:bg-raised hover:text-white disabled:opacity-40";

/** Settings, Keyboard shortcuts: every command with its keys; add, remove, reset, pick a profile, import and export. */
export default function ShortcutsEditor() {
  const keymap = usePrefs((s) => s.keymap);
  const [q, setQ] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const bindings = useMemo(() => usePrefs.getState().bindings(), [keymap]); // eslint-disable-line react-hooks/exhaustive-deps
  const prefs = usePrefs.getState();

  // while a key is being captured, the next combination is the new binding; Esc cancels
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setCapturing(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) {
        setNote("That key cannot be used.");
        return;
      }
      const stolen = usePrefs.getState().addKey(capturing, combo);
      setNote(stolen.length ? `${formatCombo(combo, mac)} now belongs to this command. It was removed from: ${stolen.map((id) => getCommand(id)?.title ?? id).join(", ")}.` : "");
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  const list = staticCommands().filter((c) => c.keys || (bindings[c.id] ?? []).length).filter((c) => !q || score(q, `${c.category} ${c.title}`) > 0);
  const changed = Object.keys(keymap).length;

  const pickFile = (onText: (t: string) => void) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => input.files?.[0] && onText(await input.files[0].text());
    input.click();
  };

  return (
    <div className="space-y-4">
      <Card title="Keymap" hint="Ctrl+K searches every command. Ctrl+/ shows this map on any screen.">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-gray-300">
            Start from
            <select className="field !w-auto" defaultValue="" onChange={(e) => e.target.value && (prefs.useProfile(e.target.value), setNote(`Applied ${PROFILES.find((p) => p.id === e.target.value)?.name}.`), (e.target.value = ""))} aria-label="Keymap profile">
              <option value="">Choose a profile...</option>
              {PROFILES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <button className={btn} onClick={() => downloadBlob(new Blob([prefs.exportKeymap()], { type: "application/json" }), "cutir-keymap.json")}>Export</button>
          <button className={btn} onClick={() => pickFile((t) => { const r = prefs.importKeymap(t); setNote(r.ok ? `Keymap imported${r.skipped ? `, ${r.skipped} entries skipped` : ""}.` : "That is not a keymap file."); })}>Import</button>
          <button className={btn} disabled={!changed} onClick={() => (prefs.resetKeys(), setNote("All keys are back to their defaults."))}>Reset all{changed ? ` (${changed} changed)` : ""}</button>
        </div>
        {note && <p role="status" className="mt-2 text-xs text-yellow-300">{note}</p>}
        <input className="field mt-3" placeholder="Filter commands" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter commands" />
      </Card>

      <Card title={`Commands (${list.length})`}>
        <ul className="divide-y divide-edge/60">
          {list.map((c) => {
            const keys = bindings[c.id] ?? [];
            const custom = c.id in keymap;
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[13px] text-gray-300">
                <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-gray-500">{c.category}</span>
                <span className="min-w-0 flex-1">{c.title}</span>
                <span className="flex flex-wrap items-center gap-1">
                  {keys.map((k) => (
                    <kbd key={k} className="flex items-center gap-1 rounded-md border border-edge bg-black/30 px-1.5 py-0.5 text-[11px]">
                      {formatCombo(k, mac)}
                      <button aria-label={`Remove ${formatCombo(k, mac)} from ${c.title}`} className="text-gray-500 hover:text-red-300" onClick={() => prefs.removeKey(c.id, k)}>x</button>
                    </kbd>
                  ))}
                  {keys.length === 0 && <span className="text-[11px] text-gray-600">no key</span>}
                  <button className="rounded-md border border-edge px-1.5 py-0.5 text-[11px] hover:bg-raised" onClick={() => (setNote(""), setCapturing(capturing === c.id ? null : c.id))} aria-label={`Add a key to ${c.title}`}>
                    {capturing === c.id ? "Press a key... (Esc cancels)" : "+ key"}
                  </button>
                  {custom && <button className="text-[11px] text-gray-500 underline hover:text-gray-200" onClick={() => prefs.resetKeys(c.id)}>reset</button>}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      {FIXED_KEYS.map((g) => (
        <Card key={g.group} title={g.group} hint="These depend on what is selected and cannot be rebound.">
          <ul className="space-y-1.5">
            {g.items.map(([k, t]) => (
              <li key={k} className="flex items-center justify-between gap-3 text-[13px] text-gray-300">
                <span>{t}</span>
                <kbd className="shrink-0 rounded-md border border-edge bg-black/30 px-1.5 py-0.5 text-[11px]">{k}</kbd>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
