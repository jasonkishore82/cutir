/**
 * Subtitle translation with the configured AI provider (phase 25). The cues keep their times; only the text changes.
 * Cues go in batches, with the cues before them as context, and the model answers with a JSON array of the same length.
 */
import { configProblem, streamChat, type LlmConfig } from "../llm";
import type { Cue } from "./cues";
import { rewrap, type CaptionRules } from "./checks";
import type { ChatMessage } from "../ollama";

export const LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" }, { code: "es", name: "Spanish" }, { code: "fr", name: "French" }, { code: "de", name: "German" },
  { code: "it", name: "Italian" }, { code: "pt", name: "Portuguese" }, { code: "nl", name: "Dutch" }, { code: "sv", name: "Swedish" },
  { code: "pl", name: "Polish" }, { code: "tr", name: "Turkish" }, { code: "ru", name: "Russian" }, { code: "uk", name: "Ukrainian" },
  { code: "ar", name: "Arabic" }, { code: "hi", name: "Hindi" }, { code: "bn", name: "Bengali" }, { code: "ta", name: "Tamil" },
  { code: "id", name: "Indonesian" }, { code: "vi", name: "Vietnamese" }, { code: "th", name: "Thai" },
  { code: "ja", name: "Japanese" }, { code: "ko", name: "Korean" }, { code: "zh", name: "Chinese" },
];
export const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

export const BATCH = 30;
const CONTEXT = 3;

export function translationMessages(batch: string[], context: string[], to: string, from?: string): ChatMessage[] {
  const target = languageName(to);
  const source = from ? ` from ${languageName(from)}` : "";
  return [
    {
      role: "system",
      content:
        `You translate subtitles${source} into ${target}. You are given a JSON array of subtitle lines. ` +
        `Reply with ONLY a JSON array of exactly the same length, where item i is the translation of line i. ` +
        `Keep each translation short enough to read on screen, keep names and brand names, keep line breaks (\\n) where the original has them, ` +
        `do not merge or split lines, and add no notes or numbering.`,
    },
    {
      role: "user",
      content: `${context.length ? `Earlier lines, for context only (do not translate them): ${JSON.stringify(context)}\n\n` : ""}Translate these ${batch.length} lines:\n${JSON.stringify(batch)}`,
    },
  ];
}

/** The model's answer as `n` strings, or null when it is not usable. Accepts a JSON array (possibly in a code fence) or numbered lines. */
export function parseTranslation(answer: string, n: number): string[] | null {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const arr: unknown = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(arr) && arr.length === n && arr.every((x) => typeof x === "string")) return (arr as string[]).map((s) => s.trim());
    } catch {
      /* fall through to numbered lines */
    }
  }
  const rows = text.split(/\r?\n/).map((r) => /^\s*(\d+)[.):]\s*(.*)$/.exec(r)).filter((m): m is RegExpExecArray => !!m);
  if (rows.length === n && rows.every((m, i) => Number(m[1]) === i + 1)) return rows.map((m) => m[2].trim());
  return null;
}

/** A new set of cues with the same times and the translated text, wrapped to the rules. */
export function withTranslation(cues: Cue[], translated: string[], rules?: CaptionRules): Cue[] {
  return cues.map((c, i) => {
    const text = translated[i] ?? c.text;
    return { start: c.start, end: c.end, text: rules ? rewrap(text.replace(/\n/g, " "), rules) : text, ...(c.speaker ? { speaker: c.speaker } : {}) };
  });
}

async function ask(cfg: LlmConfig, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  let out = "";
  for await (const chunk of streamChat(cfg, { messages, signal, purpose: "translate" })) if (chunk.content) out += chunk.content;
  return out;
}

/** Translate every cue. A batch that comes back unusable is retried in halves, down to single lines. */
export async function translateCues(cfg: LlmConfig, cues: Cue[], to: string, o: { from?: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; ask?: typeof ask } = {}): Promise<string[]> {
  const problem = configProblem(cfg);
  if (problem) throw new Error(problem);
  const run = o.ask ?? ask;
  const lines = cues.map((c) => c.text);
  const out: string[] = new Array(lines.length).fill("");
  let done = 0;
  const translate = async (from: number, to2: number): Promise<void> => {
    const batch = lines.slice(from, to2);
    const context = lines.slice(Math.max(0, from - CONTEXT), from);
    const got = parseTranslation(await run(cfg, translationMessages(batch, context, to, o.from), o.signal), batch.length);
    if (got) {
      got.forEach((t, i) => (out[from + i] = t));
      done += batch.length;
      o.onProgress?.(done, lines.length);
    } else if (batch.length > 1) {
      const mid = from + Math.ceil(batch.length / 2);
      await translate(from, mid);
      await translate(mid, to2);
    } else {
      throw new Error(`The model did not return a usable translation for line ${from + 1}. Try a larger model.`);
    }
  };
  for (let i = 0; i < lines.length; i += BATCH) await translate(i, Math.min(lines.length, i + BATCH));
  return out;
}

/* ---------- keeping a translation in step with its source ---------- */

/**
 * For each translated cue, the source cue it belongs to. With as many cues on both sides they pair by position, so a
 * source that was only retimed keeps its translation; otherwise a translated cue goes to the source cue it overlaps
 * most (or whose middle is nearest), so splits and merges still find their text.
 */
export function pairTranslation(source: Cue[], translated: Cue[]): number[] {
  if (!source.length) return translated.map(() => -1);
  if (source.length === translated.length) return translated.map((_, i) => i);
  return translated.map((t) => {
    let best = 0;
    let bestOverlap = -Infinity;
    let bestGap = Infinity;
    source.forEach((s, i) => {
      const o = Math.min(s.end, t.end) - Math.max(s.start, t.start);
      const gap = Math.abs((s.start + s.end) / 2 - (t.start + t.end) / 2);
      if (o > bestOverlap + 1e-9 || (Math.abs(o - bestOverlap) <= 1e-9 && gap < bestGap)) (best = i), (bestOverlap = o), (bestGap = gap);
    });
    return best;
  });
}

export type Resynced = {
  /** One cue per source cue, with the source's timing; empty text where there is no translation yet. */
  cues: Cue[];
  /** Source cue indexes that have no translation (new or split lines). */
  missing: number[];
  /** How many translated cues had a different time from their source. */
  retimed: number;
};

/**
 * Bring a translated track back in step with its source after the source was retimed, split or merged: each source
 * cue takes its translation (a merged one takes the texts of the cues that fell into it, in order) and the source's
 * times. Source cues with nothing to take are listed as missing, to be translated.
 */
export function resyncTranslation(source: Cue[], translated: Cue[]): Resynced {
  const owner = pairTranslation(source, translated);
  const parts: string[][] = source.map(() => []);
  const order = translated.map((_, i) => i).sort((a, b) => translated[a].start - translated[b].start);
  for (const j of order) if (owner[j] >= 0 && translated[j].text.trim()) parts[owner[j]].push(translated[j].text.trim());
  let retimed = 0;
  const missing: number[] = [];
  const cues = source.map((s, i) => {
    const text = parts[i].join(" ");
    if (!text) missing.push(i);
    const mine = translated.filter((_, j) => owner[j] === i);
    if (mine.length && mine.some((t) => Math.abs(t.start - s.start) > 1e-3 || Math.abs(t.end - s.end) > 1e-3)) retimed++;
    return { start: s.start, end: s.end, text, ...(s.speaker ? { speaker: s.speaker } : {}) };
  });
  return { cues, missing, retimed };
}

/** Translate only the source cues that have no translation and put the answers in place. */
export async function translateMissing(cfg: LlmConfig, source: Cue[], r: Resynced, to: string, o: Parameters<typeof translateCues>[3] = {}): Promise<Cue[]> {
  if (!r.missing.length) return r.cues;
  const out = await translateCues(cfg, r.missing.map((i) => source[i]), to, o);
  const cues = r.cues.map((c) => ({ ...c }));
  r.missing.forEach((i, k) => (cues[i].text = out[k]));
  return cues;
}
