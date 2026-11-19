import type { LyricLine, Project } from "../../store/project";

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function lineAt(p: Project, n: number): LyricLine {
  const l = p.lines[n - 1];
  if (!l)
    throw new Error(
      p.lines.length
        ? `line ${n} does not exist (project has ${p.lines.length} lines)`
        : `line ${n} does not exist: there are no lines yet. Use add_line to create one`
    );
  return l;
}

export const withLines = (p: Project, lines: LyricLine[]): Project => ({ ...p, lines });
