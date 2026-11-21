import { runCommand, getCommand } from "../lib/commands/registry";
import { usePrefs } from "../store/prefs";
import { formatCombo } from "../lib/commands/keymap";
import { useTimelineUi } from "../timeline/ui";
import "../lib/commands/builtin";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const BUTTONS: [string, string][] = [
  ["source.append", "Append"],
  ["source.insert", "Insert"],
  ["source.overwrite", "Overwrite"],
  ["edit.bladeAtPlayhead", "Cut"],
  ["edit.rippleDelete", "Ripple delete"],
  ["marker.add", "Marker"],
  ["mark.in", "In"],
  ["mark.out", "Out"],
  ["file.export", "Quick export"],
];

/** The Cut page's strip of fast-assembly actions above the timeline: the same commands as the keyboard and the palette. */
export default function QuickBar() {
  const keymap = usePrefs((s) => s.keymap);
  void keymap;
  useTimelineUi((s) => s.selected); // re-evaluate which actions are available when the selection changes
  const bindings = usePrefs.getState().bindings();
  return (
    <div role="toolbar" aria-label="Quick edit" className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
      {BUTTONS.map(([id, label]) => {
        const c = getCommand(id);
        const off = !c || (c.enabled ? !c.enabled() : false);
        const key = bindings[id]?.[0];
        return (
          <button key={id} disabled={off} onClick={() => void runCommand(id)} title={key ? formatCombo(key, mac) : undefined} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-gray-200 hover:bg-white/[0.09] disabled:opacity-40">
            {label}
          </button>
        );
      })}
      <span className="ml-auto text-[11px] text-gray-500">Choose a clip in Media, set marks (I, O), then Append or Insert.</span>
    </div>
  );
}
