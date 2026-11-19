import { lineWords, type LyricLine, type Project } from "../../store/project";

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

/** Lower-case word without punctuation, for matching a word the model typed. */
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * 0-based index of a word in a line from a 1-based word number or the word's text (first match, ignoring case and
 * punctuation). Numbers in range win; a number that is out of range is tried as text ("99 problems").
 */
export function wordAt(line: LyricLine, ref: number | string): number {
  const words = lineWords(line.text);
  const n = typeof ref === "number" ? ref : /^\s*\d+\s*$/.test(ref) ? Number(ref) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= words.length) return n - 1;
  const k = bare(String(ref));
  let i = words.findIndex((w) => bare(w) === k);
  if (i < 0 && k.length > 2) i = words.findIndex((w) => bare(w).length > 2 && (bare(w).startsWith(k) || k.startsWith(bare(w))));
  if (i < 0) throw new Error(`no word "${ref}" in "${line.text}" (words 1-${words.length}: ${words.join(" ")})`);
  return i;
}
