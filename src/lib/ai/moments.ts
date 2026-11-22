import type { Cue } from "../captions/cues";

/**
 * Find moments in a transcript (phase 28): the captions that mention what the user is after. Plain word matching, so it
 * works offline and the result can be checked; a model only has to pick the words.
 */

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "is", "it", "that", "this", "when", "where", "about", "where", "they", "talk", "talks", "talking", "say", "says", "said", "mention", "mentions", "mentioned", "moments", "moment", "part", "parts", "find", "mark", "for", "with", "i", "we", "you", "he", "she"]);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
/** A crude stem so "pricing" matches "price" and "launches" matches "launch". */
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "").replace(/(.)\1$/, "$1");

export type Moment = { start: number; end: number; text: string; score: number };

export function findMoments(cues: Cue[], query: string, max = 12): Moment[] {
  const quoted = /"([^"]+)"|'([^']+)'/.exec(query);
  const phrase = quoted ? norm(quoted[1] ?? quoted[2]).join(" ") : "";
  const terms = [...new Set(norm(query).filter((w) => !STOP.has(w)).map(stem).filter((w) => w.length > 1))];
  if (!phrase && !terms.length) return [];
  const out: Moment[] = [];
  for (const c of cues) {
    const words = norm(c.text);
    let score = 0;
    if (phrase && words.join(" ").includes(phrase)) score += 5;
    if (terms.length) {
      const stems = new Set(words.map(stem));
      const hit = terms.filter((t) => stems.has(t)).length;
      score += hit / terms.length;
      if (phrase && !hit && score < 5) continue;
      if (!phrase && hit === 0) continue;
    }
    if (score > 0) out.push({ start: c.start, end: c.end, text: c.text.replace(/\s+/g, " ").trim(), score });
  }
  // keep the best, then show them in time order
  return out.sort((a, b) => b.score - a.score || a.start - b.start).slice(0, max).sort((a, b) => a.start - b.start);
}
