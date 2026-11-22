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
