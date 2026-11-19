import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { useProject } from "../store/project";
import { readField, resetFields, targetKey, writeField, type FieldRead, type Scope, type Target } from "../lib/styleEdit";
import { Icon } from "./ui";

/**
 * Property controls that edit the right level: the selected lines when there is a selection, otherwise the
 * project defaults, or the active layer when chosen. Every control shows where its value comes from and can
 * be reset to what it inherits.
 */

const useScopeChoice = create<{ scope: Scope | null; set: (s: Scope | null) => void }>((set) => ({ scope: null, set: (scope) => set({ scope }) }));

export function useTarget() {
  const project = useProject((s) => s.project);
  const selectedIds = useProject((s) => s.selectedIds);
  const activeLayerId = useProject((s) => s.activeLayerId);
  const chosen = useScopeChoice((s) => s.scope);
  const ids = selectedIds.filter((id) => project.lines.some((l) => l.id === id));
  const has = ids.length > 0;
  let scope: Scope = chosen ?? (has ? "line" : "project");
  if (scope === "line" && !has) scope = "project";
  const layer = project.layers.find((l) => l.id === activeLayerId) ?? project.layers[0];
  const target: Target = scope === "line" ? { scope, ids } : scope === "layer" ? { scope, layerId: layer.id } : { scope: "project" };
  return { target, scope, ids, has, project, layer };
}

/** Choose what the controls below edit. */
export function ScopeBar() {
  const { scope, ids, has, project, layer } = useTarget();
  const setChoice = useScopeChoice((s) => s.set);
  const key = ids.join(",");
  useEffect(() => setChoice(null), [key, setChoice]); // a new selection goes back to editing the selection

  const opts: { id: Scope; label: string; off?: boolean }[] = [
    { id: "line", label: ids.length > 1 ? `${ids.length} lines` : "Line", off: !has },
    { id: "layer", label: "Layer" },
    { id: "project", label: "Project" },
  ];
  const first = project.lines.find((l) => l.id === ids[0]);
  const what = scope === "line" ? (ids.length > 1 ? `${ids.length} lines selected` : first?.text ?? "") : scope === "layer" ? `All lines on ${layer.name}` : "Defaults for every line";

  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="What to edit" className="flex gap-0.5 rounded-lg bg-black/40 p-0.5">
        {opts.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={scope === o.id}
            disabled={o.off}
            onClick={() => setChoice(o.id)}
            className={`flex-1 truncate rounded-md px-2 py-1.5 text-xs ${scope === o.id ? "bg-raised text-white shadow-sm shadow-black/40" : "text-gray-400 hover:text-gray-200"} disabled:opacity-35 disabled:hover:text-gray-400`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="truncate px-0.5 text-[11px] text-gray-500" title={what}>{what}</p>
    </div>
  );
}

const SOURCE_LABEL = { line: "Line", layer: "Layer", project: "Project" } as const;

function Meta({ read, scope, onReset, text }: { read: FieldRead; scope: Scope; onReset: () => void; text: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {scope !== "project" && (
        <span
          title={`This value comes from the ${SOURCE_LABEL[read.source].toLowerCase()}`}
          className={`rounded px-1.5 py-px text-[10px] ${read.source === scope ? "bg-accent/15 text-accent" : "bg-white/[0.06] text-gray-500"}`}
        >
          {SOURCE_LABEL[read.source]}
        </span>
      )}
      <span className="tabular-nums text-gray-500">{text}</span>
      {read.overridden && scope !== "project" && (
        <button onClick={onReset} title="Reset to inherited" aria-label="Reset to inherited" className="grid h-5 w-5 place-items-center rounded text-gray-500 hover:bg-white/10 hover:text-white">
          <Icon name="undo" className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

type Common = { path: string; label: string };

export function PropSlider({ path, label, min, max, step = 1, unit = "", factor = 1, auto }: Common & { min: number; max: number; step?: number; unit?: string; factor?: number; auto?: number }) {
  const { target, scope, project } = useTarget();
  const r = readField(project, target, path);
  const raw = typeof r.value === "number" ? r.value : undefined;
  const shown = raw === undefined ? auto ?? min : Math.round(raw * factor * 100) / 100;
  const text = r.mixed ? "mixed" : raw === undefined ? "preset" : `${shown}${unit}`;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[12px]">
        <span className="text-gray-300">{label}</span>
        <Meta read={r} scope={scope} text={text} onReset={() => resetFields(target, [path])} />
      </div>
      <input
        type="range"
        className="block w-full"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={r.mixed ? (min + max) / 2 : shown}
        onChange={(e) => writeField(target, path, Number(e.target.value) / factor, `f:${targetKey(target)}:${path}`)}
      />
    </div>
  );
}

export function PropColor({ path, label }: Common) {
  const { target, scope, project } = useTarget();
  const r = readField(project, target, path);
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <label className="flex items-center gap-2.5 text-gray-300">
        <input type="color" aria-label={label} value={typeof r.value === "string" && !r.mixed ? r.value : "#808080"} onChange={(e) => writeField(target, path, e.target.value, `f:${targetKey(target)}:${path}`)} />
        {label}
      </label>
      <Meta read={r} scope={scope} text={r.mixed ? "mixed" : ""} onReset={() => resetFields(target, [path])} />
    </div>
  );
}

export function PropCheck({ path, label }: Common) {
  const { target, scope, project } = useTarget();
  const r = readField(project, target, path);
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <label className="flex items-center gap-2 text-gray-300">
        <input
          type="checkbox"
          checked={r.value === true && !r.mixed}
          ref={(el) => {
            if (el) el.indeterminate = r.mixed;
          }}
          onChange={(e) => writeField(target, path, e.target.checked)}
        />
        {label}
      </label>
      <Meta read={r} scope={scope} text={r.mixed ? "mixed" : ""} onReset={() => resetFields(target, [path])} />
    </div>
  );
}

export function PropSelect({ path, label, options }: Common & { options: string[] }) {
  const { target, scope, project } = useTarget();
  const r = readField(project, target, path);
  const cur = typeof r.value === "string" ? r.value : "";
  const list = [...new Set([...(cur ? [cur] : []), ...options])];
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="text-gray-300">{label}</span>
        <Meta read={r} scope={scope} text="" onReset={() => resetFields(target, [path])} />
      </div>
      <select className="field" aria-label={label} value={r.mixed ? "__mixed" : cur} onChange={(e) => writeField(target, path, e.target.value)}>
        {r.mixed && <option value="__mixed" disabled>Mixed</option>}
        {list.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

/** Tiles for a short list of named choices. `onPick` lets a choice change more than one field. */
export function PropChoice({ path, label, options, columns = 2, onPick }: Common & { options: string[]; columns?: number; onPick?: (value: string, t: Target) => void }) {
  const { target, scope, project } = useTarget();
  const r = readField(project, target, path);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="text-gray-300">{label}</span>
        <Meta read={r} scope={scope} text={r.mixed ? "mixed" : ""} onReset={() => resetFields(target, [path])} />
      </div>
      <div role="radiogroup" aria-label={label} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {options.map((o) => {
          const on = !r.mixed && r.value === o;
          return (
            <button
              key={o}
              role="radio"
              aria-checked={on}
              onClick={() => (onPick ? onPick(o, target) : writeField(target, path, o))}
              className={`rounded-lg border px-2.5 py-2 text-left text-[13px] capitalize ${on ? "border-accent/50 bg-accent/10 text-white" : "border-edge bg-black/20 text-gray-300 hover:bg-raised"}`}
            >
              {o.replace("-", " ")}
            </button>
          );
        })}
      </div>
    </div>
  );
}
