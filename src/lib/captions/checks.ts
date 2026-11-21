/**
 * Caption checks and fixes (phase 25): reading speed, shortest and longest time on screen, overlaps, line length and
 * line count. `checkCues` lists what is wrong; `fixCues` repairs it (re-wrapping, splitting, extending, un-overlapping).
 */
import type { Cue, CueWord } from "./cues";

export type CaptionRules = {
  /** Characters per second a viewer can read. 17 suits adults, 12 children's content. */
  maxCps: number;
  minDuration: number;
  maxDuration: number;
  maxLines: number;
  /** Characters on a line. */
  maxChars: number;
  /** Seconds kept between one cue and the next. */
  minGap: number;
};

export const DEFAULT_RULES: CaptionRules = { maxCps: 17, minDuration: 1, maxDuration: 7, maxLines: 2, maxChars: 42, minGap: 0.04 };

export const RULE_PRESETS: { id: string; label: string; rules: CaptionRules }[] = [
  { id: "broadcast", label: "Broadcast (17 cps, 2 lines of 42)", rules: DEFAULT_RULES },
  { id: "netflix", label: "Streaming (20 cps, 2 lines of 42)", rules: { ...DEFAULT_RULES, maxCps: 20, minDuration: 0.833, maxDuration: 7 } },
  { id: "social", label: "Social, vertical (1 line of 24, quick)", rules: { maxCps: 22, minDuration: 0.6, maxDuration: 4, maxLines: 1, maxChars: 24, minGap: 0.04 } },
  { id: "children", label: "Children (12 cps)", rules: { ...DEFAULT_RULES, maxCps: 12, minDuration: 1.5 } },
];

export type IssueKind = "cps" | "short" | "long" | "overlap" | "lines" | "width";
export type Issue = { index: number; kind: IssueKind; message: string };

const R = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
export const visibleChars = (text: string) => text.replace(/\n/g, "").length;
export const readingSpeed = (c: Cue) => visibleChars(c.text) / Math.max(0.001, c.end - c.start);

/* ---------- wrapping ---------- */

/** The text broken into the fewest lines of at most `maxChars`, with the lines of similar length. A longer word keeps its own line. */
export function wrapBalanced(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const len = (a: number, b: number) => words.slice(a, b).join(" ").length;
  // fewest lines a greedy fill needs
  let n = 1;
  for (let i = 0, w = 0; i < words.length; i++) {
    const add = (w ? 1 : 0) + words[i].length;
    if (w && w + add > maxChars) (n++, (w = words[i].length));
    else w += add;
  }
  if (n === 1) return [words.join(" ")];
  const target = len(0, words.length) / n;
  // dp[k][i]: least squared slack putting the first i words on k lines
  const INF = 1e18;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(words.length + 1).fill(INF));
  const from = Array.from({ length: n + 1 }, () => new Array<number>(words.length + 1).fill(0));
  dp[0][0] = 0;
  for (let k = 1; k <= n; k++)
    for (let i = k; i <= words.length; i++)
      for (let j = k - 1; j < i; j++) {
        const l = len(j, i);
        if (l > maxChars && i - j > 1) continue;
        const cost = dp[k - 1][j] + (l - target) ** 2;
        if (cost < dp[k][i]) (dp[k][i] = cost), (from[k][i] = j);
      }
  if (dp[n][words.length] >= INF) return greedy(words, maxChars);
  const out: string[] = [];
  for (let k = n, i = words.length; k > 0; k--) {
    const j = from[k][i];
    out.unshift(words.slice(j, i).join(" "));
    i = j;
  }
  return out;
}
function greedy(words: string[], maxChars: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > maxChars) (out.push(line), (line = w));
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}
export const rewrap = (text: string, rules: CaptionRules) => wrapBalanced(text, rules.maxChars).join("\n");

/* ---------- checks ---------- */

export function checkCues(cues: Cue[], rules: CaptionRules = DEFAULT_RULES): Issue[] {
  const out: Issue[] = [];
  cues.forEach((c, i) => {
    const d = c.end - c.start;
    const cps = readingSpeed(c);
    if (cps > rules.maxCps + 0.05) out.push({ index: i, kind: "cps", message: `Reads at ${R(cps, 1)} characters a second (limit ${rules.maxCps}).` });
    if (d < rules.minDuration - 1e-6) out.push({ index: i, kind: "short", message: `On screen ${R(d, 2)} s (shortest ${rules.minDuration} s).` });
    if (d > rules.maxDuration + 1e-6) out.push({ index: i, kind: "long", message: `On screen ${R(d, 2)} s (longest ${rules.maxDuration} s).` });
    const lines = c.text.split("\n");
    if (lines.length > rules.maxLines) out.push({ index: i, kind: "lines", message: `${lines.length} lines (limit ${rules.maxLines}).` });
    const widest = Math.max(...lines.map((l) => l.length));
    if (widest > rules.maxChars) out.push({ index: i, kind: "width", message: `A line has ${widest} characters (limit ${rules.maxChars}).` });
    const next = cues[i + 1];
    if (next && c.end > next.start + 1e-6) out.push({ index: i, kind: "overlap", message: `Overlaps the next cue by ${R(c.end - next.start, 2)} s.` });
  });
  return out;
}

/* ---------- fixes ---------- */

/** The words of a cue with times: its own, or its characters' share of the time. */
export function wordsOf(c: Cue): CueWord[] {
  if (c.words?.length && c.words.map((w) => w.text).join(" ").replace(/\s+/g, " ") === c.text.replace(/\s+/g, " ").trim()) return c.words;
  const ws = c.text.split(/\s+/).filter(Boolean);
  const total = ws.reduce((s, w) => s + w.length + 1, 0) || 1;
  let at = c.start;
  return ws.map((text) => {
    const d = ((text.length + 1) / total) * (c.end - c.start);
    const w = { text, start: R(at), end: R(at + d) };
    at += d;
    return w;
  });
}

/** One cue as several that each fit the rules, split at sentence and phrase ends where there is a choice. */
export function splitCue(c: Cue, rules: CaptionRules): Cue[] {
  const cap = rules.maxChars * rules.maxLines;
  const words = wordsOf(c);
  const chunks: CueWord[][] = [];
  let cur: CueWord[] = [];
  const size = (ws: CueWord[]) => ws.map((w) => w.text).join(" ").length;
  const fits = (ws: CueWord[]) => wrapBalanced(ws.map((w) => w.text).join(" "), rules.maxChars).length <= rules.maxLines && size(ws) <= cap && ws[ws.length - 1].end - ws[0].start <= rules.maxDuration;
  /** Where to break a chunk that has to end: after the last sentence end (or comma) if that leaves a fair share on this side. */
  const breakAt = (ws: CueWord[]): number => {
    for (const [re, share] of [[/[.?!…]$/, 0.3], [/[,;:]$/, 0.5]] as const)
      for (let i = ws.length - 2; i >= 0; i--) if (re.test(ws[i].text) && size(ws.slice(0, i + 1)) >= cap * share) return i + 1;
    return ws.length;
  };
  for (const w of words) {
    if (cur.length && !fits([...cur, w])) {
      const at = breakAt(cur);
      chunks.push(cur.slice(0, at));
      cur = cur.slice(at);
    }
    cur.push(w);
    // after a sentence end, start afresh once the line is fairly full
    if (/[.?!…]$/.test(w.text) && size(cur) >= cap * 0.5) (chunks.push(cur), (cur = []));
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((ws) => ({
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    text: wrapBalanced(ws.map((w) => w.text).join(" "), rules.maxChars).join("\n"),
    words: ws,
    ...(c.speaker ? { speaker: c.speaker } : {}),
  }));
}

/**
 * Repair every problem it can: overlaps are trimmed, long or tall cues are split, lines are re-wrapped evenly, cues that
 * are too short or read too fast are given the time they need from the gap after them. Returns the new cues and what changed.
 */
export function fixCues(input: Cue[], rules: CaptionRules = DEFAULT_RULES, o: { /** When the last cue is fixed on its own: where the cue after it starts. */ nextStart?: number } = {}): { cues: Cue[]; changes: string[] } {
  const changes: string[] = [];
  let cues = input.map((c) => ({ ...c })).sort((a, b) => a.start - b.start);

  // 1. split what is too long or too tall
  const split: Cue[] = [];
  for (const c of cues) {
    const tooBig = visibleChars(c.text) > rules.maxChars * rules.maxLines || c.end - c.start > rules.maxDuration || wrapBalanced(c.text.replace(/\n/g, " "), rules.maxChars).length > rules.maxLines;
    if (tooBig) {
      const parts = splitCue(c, rules);
      if (parts.length > 1) (changes.push(`Split a cue into ${parts.length}.`), split.push(...parts));
      else split.push(c);
    } else split.push(c);
  }
  cues = split;

  // 2. line breaks
  cues = cues.map((c) => {
    const text = rewrap(c.text.replace(/\n/g, " "), rules);
    if (text !== c.text) changes.push("Re-wrapped lines.");
    return { ...c, text };
  });

  // 3. overlaps
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? o.nextStart;
    if (next === undefined) continue;
    const limit = next - rules.minGap;
    if (cues[i].end > limit + 1e-6) {
      cues[i].end = R(Math.max(cues[i].start + 0.05, limit));
      changes.push("Trimmed an overlap.");
    }
  }

  // 4. short and fast cues take the gap that follows
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const room = (cues[i + 1]?.start ?? o.nextStart ?? Infinity) - rules.minGap;
    const need = Math.max(rules.minDuration, visibleChars(c.text) / rules.maxCps);
    if (c.end - c.start < need - 1e-6 && room > c.end) {
      c.end = R(Math.min(c.start + need, room));
      changes.push("Gave a cue more time on screen.");
    }
  }
  return { cues, changes: changes.filter((x, i, a) => a.indexOf(x) === i || x.startsWith("Split")) };
}
