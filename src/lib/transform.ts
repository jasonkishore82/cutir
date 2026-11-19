import { effectiveStyle, useProject, type Transform } from "../store/project";

const REST: Transform = { scale: 1, rotation: 0 };

/** The transform a line currently renders with (project, layer and line overrides combined). */
export function transformOf(id: string): Transform {
  const p = useProject.getState().project;
  const line = p.lines.find((l) => l.id === id);
  return (line ? effectiveStyle(p, line).transform : undefined) ?? REST;
}

/** Change part of one line's transform. The line keeps its own override, other lines are untouched. */
export function writeLineTransform(id: string, patch: Partial<Transform>, coalesceKey?: string) {
  useProject.getState().update(
    (p) => ({
      ...p,
      lines: p.lines.map((l) => {
        if (l.id !== id) return l;
        // only the changed fields become overrides; the rest keep inheriting
        return { ...l, styleOverride: { ...l.styleOverride, transform: { ...l.styleOverride?.transform, ...patch } } };
      }),
    }),
    coalesceKey
  );
}

/** Put a line back to the placement, scale and rotation it inherits. */
export function resetLineTransform(id: string) {
  useProject.getState().update((p) => ({
    ...p,
    lines: p.lines.map((l) => {
      if (l.id !== id || !l.styleOverride?.transform) return l;
      const { transform: _gone, ...rest } = l.styleOverride;
      void _gone;
      return { ...l, styleOverride: Object.keys(rest).length ? rest : undefined };
    }),
  }));
}
