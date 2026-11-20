import { lineWords, type LyricLine, type Project } from "../../store/project";

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Line numbers in one reply refer to the lines as they were when the reply started. Without this, "delete line 2"
 * followed by "delete line 3" in the same reply would hit the wrong line, because the first delete renumbers the rest.
 * applyCalls sets the snapshot for the duration of a reply.
 */
let snapshot: string[] | null = null;
export function withLineNumbers<T>(ids: string[], fn: () => T): T {
  const prev = snapshot;
  snapshot = ids;
  try {
    return fn();
  } finally {
    snapshot = prev;
  }
}

export function lineAt(p: Project, n: number): LyricLine {
  const count = snapshot ? snapshot.length : p.lines.length;
  if (!Number.isInteger(n) || n < 1 || n > count)
    throw new Error(
      count
        ? `line ${n} does not exist (project has ${count} lines)`
        : `line ${n} does not exist: there are no lines yet. Use add_line to create one`
    );
  if (!snapshot) return p.lines[n - 1];
  const l = p.lines.find((x) => x.id === snapshot![n - 1]);
  if (!l) throw new Error(`line ${n} was already removed earlier in this reply`);
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
