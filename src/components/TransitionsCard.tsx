import { Card, Segmented, Slider } from "./ui";
import { TRANSITIONS, TRANSITION_NAMES } from "../lib/animations";
import { useProject, type TransitionType } from "../store/project";

/**
 * The project's default hand-over between consecutive lines. A single gap can be set differently from the timeline
 * (right-click a line). Lines further apart than the transition length simply cut.
 */
export default function TransitionsCard() {
  const tr = useProject((s) => s.project.transition);
  const custom = useProject((s) => s.project.lines.filter((l) => l.transition).length);
  const set = (patch: Partial<typeof tr>, key?: string) =>
    useProject.getState().update((p) => ({ ...p, transition: { ...p.transition, ...patch } }), key);
  const clearCustom = () =>
    useProject.getState().update((p) => ({
      ...p,
      lines: p.lines.map((l) => {
        if (!l.transition) return l;
        const { transition: _t, ...rest } = l;
        void _t;
        return rest;
      }),
    }));

  return (
    <Card title="Transitions" hint="How one line hands over to the next on the same layer. Right-click a line on the timeline to set one gap.">
      <Segmented<TransitionType>
        label="Default transition"
        value={tr.type}
        options={TRANSITION_NAMES.map((n) => ({ value: n, label: n === "none" ? "Cut" : TRANSITIONS[n].label }))}
        onChange={(type) => set({ type })}
      />
      {tr.type !== "none" && <Slider label="Length" value={tr.ms} min={100} max={2000} step={50} unit=" ms" onChange={(ms) => set({ ms }, "transition-ms")} />}
      {custom > 0 && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500">
          <span>{custom === 1 ? "1 gap has" : `${custom} gaps have`} its own transition.</span>
          <button className="text-accent hover:underline" onClick={clearCustom}>
            Use the default everywhere
          </button>
        </div>
      )}
      <p className="text-[11px] text-gray-500">Lines further apart than the length just cut.</p>
    </Card>
  );
}
