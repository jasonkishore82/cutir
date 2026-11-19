import { lineWords, setWordOverride, type LyricLine, type Project } from "../store/project";

/**
 * Automatic emphasis (phase 16.5): picks the key words of each line and gives them emphasis levels 1..3 in
 * `line.wordOverrides[i].emphasis`. Rules only (no model): long sung duration, word length, not a stop word,
 * hook words that recur across the song, and a small bonus for the last content word of a line.
 *
 * Vocal loudness at the word is not known yet (the energy curve is song-wide, not vocal). `EmphasisOptions.loudness`
 * is the hook for it: pass a 0..1 level per word index and it is scored like duration.
 */

/** Common English words that never carry a line (compared lower-case with punctuation removed, so "don't" = "dont"). */
const STOP = new Set(
  (
    "a an the and or but nor so yet if then than as at by for from in into of off on onto out over to up upon with within without " +
    "about above after again against all am are aren arent be because been before being below between both can cant cannot could couldnt " +
    "did didnt do does doesnt doing dont down during each few further had hadnt has hasnt have havent having he hed hes her here heres hers " +
    "herself him himself his how hows i id ill im ive is isnt it its itll itself just lets me more most my myself no not now of once only " +
    "other ought our ours ourselves own same shall she shed shell shes should shouldnt some such that thats their theirs them themselves " +
    "there theres these they theyd theyll theyre theyve this those through too under until very was wasnt we wed well were weve werent " +
    "what whats when whens where wheres which while who whos whom why whys will wont would wouldnt you youd youll youre youve your yours " +
    "yourself yourselves oh ooh ah uh yeah yea ya ye na la da hey mm mmm whoa gonna wanna gotta got get gets cause cuz til till ever every " +
    "thing things one also like really still even way much many any anything nothing something let"
  ).split(" ")
);

/** Lower-case word with punctuation removed (letters and digits only). */
export const cleanWord = (w: string) => w.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

export const isStopWord = (w: string) => {
  const c = cleanWord(w);
  return !c || STOP.has(c);
};

export type EmphasisOptions = {
  /** Vocal loudness 0..1 per word index (hook for later; missing = not used). */
  loudness?: number[];
};

/** How many lines of the project contain each content word (cached per lines array). */
const hookCache = new WeakMap<LyricLine[], Map<string, number>>();
function hookCounts(lines: LyricLine[]): Map<string, number> {
  let m = hookCache.get(lines);
  if (!m) {
    m = new Map();
    for (const l of lines) {
      const seen = new Set(lineWords(l.text).map(cleanWord).filter((c) => c && !STOP.has(c)));
      for (const c of seen) m.set(c, (m.get(c) ?? 0) + 1);
    }
    hookCache.set(lines, m);
  }
  return m;
}

/** Score of each word (0 for stop words and punctuation-only words). Exported for tests and the properties panel. */
export function scoreWords(line: LyricLine, project: Project, opts: EmphasisOptions = {}): number[] {
  const words = lineWords(line.text);
  const n = words.length;
  if (!n) return [];
  const timed = line.words && line.words.length === n;
  const dur = words.map((_, i) => (timed ? Math.max(0, line.words![i].end - line.words![i].start) : (line.end - line.start) / n));
  const mean = dur.reduce((a, b) => a + b, 0) / n || 1;
  const hooks = hookCounts(project.lines);
  const clean = words.map(cleanWord);
  const content = clean.map((c) => !!c && !STOP.has(c));
  const lastContent = content.lastIndexOf(true);
  return words.map((_, i) => {
    if (!content[i]) return 0;
    let s = 1;
    s += 1.5 * Math.max(-0.5, Math.min(2, dur[i] / mean - 1)); // held notes stand out
    s += Math.min(clean[i].length, 10) / 10; // longer words carry more
    const count = hooks.get(clean[i]) ?? 0;
    if (count >= 2) s += 0.4 * Math.min(count - 1, 4); // hook words recur across the song
    if (i === lastContent) s += 0.3; // the line lands on its last content word
    const loud = opts.loudness?.[i];
    if (loud !== undefined) s += 1.5 * Math.max(-0.5, Math.min(1, loud * 2 - 1));
    return Math.max(0.01, s);
  });
}

/** Suggested emphasis level per word index (only words that get a level are present). Pure and deterministic. */
export function suggestEmphasis(line: LyricLine, project: Project, opts: EmphasisOptions = {}): Record<number, 1 | 2 | 3> {
  const scores = scoreWords(line, project, opts);
  const n = scores.length;
  if (n < 2) return {}; // a one-word line is already the focus; emphasising it would mean every word
  const max = n <= 2 ? 1 : Math.max(1, Math.floor(n / 3));
  const ranked = scores
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  if (!ranked.length) return {};
  const top = ranked[0];
  const second = ranked[1]?.s ?? 0;
  const out: Record<number, 1 | 2 | 3> = {};
  out[top.i] = top.s >= 2.2 && top.s >= second * 1.35 ? 3 : 2;
  for (const r of ranked.slice(1, max)) {
    if (r.s < top.s * 0.6) break;
    out[r.i] = r.s >= top.s * 0.85 ? 2 : 1;
  }
  return out;
}

/**
 * Project with suggested emphasis written into the given lines (all lines when `lineIds` is missing). Pure.
 * Earlier emphasis levels on those lines are cleared first (there is no separate "manual" level); every other word
 * override field (style, transform, keyframes) is kept.
 */
export function applyAutoEmphasis(project: Project, lineIds?: string[]): Project {
  const want = lineIds ? new Set(lineIds) : null;
  const lines = project.lines.map((l) => {
    if (want && !want.has(l.id)) return l;
    let next = l;
    for (const k of Object.keys(l.wordOverrides ?? {})) if (l.wordOverrides![Number(k)].emphasis) next = setWordOverride(next, Number(k), { emphasis: undefined });
    for (const [i, level] of Object.entries(suggestEmphasis(l, project))) next = setWordOverride(next, Number(i), { emphasis: level });
    return next;
  });
  return { ...project, lines };
}
