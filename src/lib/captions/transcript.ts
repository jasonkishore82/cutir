/**
 * The transcript as editable words (phase 25). Cues carry word timings; this turns them into a flat word list, finds
 * filler words and pauses, plans which stretches of time to cut, and moves the cues to match once the time is gone.
 * Pure functions: the card applies the same ranges to the timeline.
 */
import type { Cue, CueWord } from "./cues";
import { wordsOf } from "./checks";

export type TWord = CueWord & { cue: number; index: number; speaker?: string };
export type Range = { start: number; end: number };

const R = (n: number) => Math.round(n * 1000) / 1000;

/** Every word of every cue in time order, with where it lives. */
export function flatWords(cues: Cue[]): TWord[] {
  const out: TWord[] = [];
  cues.forEach((c, cue) => wordsOf(c).forEach((w, index) => out.push({ ...w, cue, index, ...(c.speaker ? { speaker: c.speaker } : {}) })));
  return out;
}

export const normWord = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

/* ---------- fillers and pauses ---------- */

export const DEFAULT_FILLERS = ["um", "uh", "er", "erm", "ah", "uhm", "umm", "uhh", "hmm", "mm", "mhm", "you know", "i mean"];
/** Words that are fillers only sometimes: left out of the default list. */
export const OPTIONAL_FILLERS = ["like", "so", "basically", "actually", "literally", "kind of", "sort of", "right"];

/** Indices (into `words`) of filler words, matching one- and two-word fillers. */
export function findFillers(words: TWord[], list: string[] = DEFAULT_FILLERS): number[] {
  const set = list.map((f) => f.toLowerCase().trim().split(/\s+/)).filter((f) => f[0]);
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const f of set) {
      if (f.every((p, k) => words[i + k] && normWord(words[i + k].text) === p)) {
        for (let k = 0; k < f.length; k++) out.push(i + k);
        i += f.length - 1;
        break;
      }
    }
  }
  return out;
}

/** Silences between words longer than `min` seconds, as ranges to cut that leave `keep` seconds of the pause. */
export function findPauses(words: TWord[], o: { min?: number; keep?: number } = {}): Range[] {
  const min = o.min ?? 0.7;
  const keep = Math.min(o.keep ?? 0.25, min);
  const out: Range[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap >= min) out.push({ start: R(words[i].end + keep / 2), end: R(words[i + 1].start - keep / 2) });
  }
  return out;
}

/** Sorted ranges with overlapping and (almost) touching ones joined. */
export function mergeRanges(ranges: Range[], join = 0.15): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + join) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** The stretches of time to remove for these words (by index into `words`) and any pauses. */
export function planCuts(words: TWord[], picked: Iterable<number>, pauses: Range[] = []): Range[] {
  const r: Range[] = [...pauses];
  for (const i of picked) if (words[i]) r.push({ start: words[i].start, end: words[i].end });
  // a deleted word takes the silence on its far side if that is short, so no little hole is left
  return mergeRanges(r, 0.12);
}

export const totalOf = (ranges: Range[]) => R(ranges.reduce((s, r) => s + (r.end - r.start), 0));

/* ---------- applying cuts to cues ---------- */

/** Where time `t` lands once `ranges` (sorted, not overlapping) are removed. */
export function shiftTime(t: number, ranges: Range[]): number {
  let removed = 0;
  for (const r of ranges) {
    if (t <= r.start) break;
    removed += Math.min(t, r.end) - r.start;
  }
  return R(t - removed);
}

/** The cues after `ranges` of time are taken out: words inside are dropped, the rest move earlier, empty cues go. */
export function applyCutsToCues(cues: Cue[], ranges: Range[]): Cue[] {
  const rs = mergeRanges(ranges, 0);
  const inside = (w: CueWord) => {
    const mid = (w.start + w.end) / 2;
    return rs.some((r) => mid >= r.start && mid < r.end);
  };
  const out: Cue[] = [];
  for (const c of cues) {
    if (!c.words?.length) {
      // no word times (a translation, an imported file): the cue moves with the time, and goes if it is cut away
      const start = shiftTime(c.start, rs);
      const end = shiftTime(c.end, rs);
      if (end - start >= Math.min(0.1, (c.end - c.start) * 0.5)) out.push({ ...c, start, end });
      continue;
    }
    const kept = wordsOf(c).filter((w) => !inside(w));
    if (!kept.length) continue;
    const words = kept.map((w) => ({ text: w.text, start: shiftTime(w.start, rs), end: shiftTime(w.end, rs) }));
    // a cue keeps its own line breaks only while no word has been taken out of it
    const untouched = kept.length === wordsOf(c).length;
    out.push({ ...c, start: words[0].start, end: Math.max(words[0].start + 0.05, words[words.length - 1].end), text: untouched ? c.text : words.map((w) => w.text).join(" "), words });
  }
  return out;
}

/* ---------- vocabulary ---------- */

function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Respell words that are a near miss of a vocabulary word (names, brands, jargon the recogniser gets wrong). Returns the cues and how many words changed. */
export function applyVocabulary(cues: Cue[], vocab: string[]): { cues: Cue[]; changed: number } {
  const terms = vocab.map((v) => v.trim()).filter((v) => v && !/\s/.test(v));
  let changed = 0;
  const fix = (w: string, count = true) => {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(w);
    if (!m || !m[2]) return w;
    const core = m[2];
    const lower = core.toLowerCase();
    let best: string | null = null;
    let bestD = Infinity;
    for (const t of terms) {
      const cap = t.length >= 9 ? 2 : t.length >= 5 ? 1 : 0;
      const d = distance(lower, t.toLowerCase(), cap);
      if (d <= cap && d < bestD) (best = t), (bestD = d);
    }
    if (best === null || best === core) return w;
    if (count) changed++;
    return m[1] + best + m[3];
  };
  const out = cues.map((c) => {
    const words = c.words?.map((w) => ({ ...w, text: fix(w.text, false) }));
    const text = c.text.split("\n").map((row) => row.split(/(\s+)/).map((p) => (/\s/.test(p) ? p : fix(p))).join("")).join("\n");
    return { ...c, text, ...(words ? { words } : {}) };
  });
  return { cues: out, changed };
}

/* ---------- rebuilding cues from words ---------- */

/** Cues from a flat run of words: a new cue at a pause, after a sentence end once it is long enough, or a speaker change. */
export function cuesFromWords(words: (CueWord & { speaker?: string })[], o: { pause?: number; maxChars?: number } = {}): Cue[] {
  const pause = o.pause ?? 0.8;
  const maxChars = o.maxChars ?? 84;
  const out: Cue[] = [];
  let cur: (CueWord & { speaker?: string })[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" "), words: cur.map(({ text, start, end }) => ({ text, start, end })), ...(cur[0].speaker ? { speaker: cur[0].speaker } : {}) });
    cur = [];
  };
  for (const w of words) {
    const last = cur[cur.length - 1];
    const size = cur.reduce((s, x) => s + x.text.length + 1, 0);
    if (last && (w.start - last.end >= pause || w.speaker !== last.speaker || size + w.text.length > maxChars || (/[.?!…]$/.test(last.text) && size > maxChars * 0.4))) flush();
    cur.push(w);
  }
  flush();
  return out;
}
