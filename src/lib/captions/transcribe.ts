/**
 * Speech to text (phase 25): the local helper (Whisper through the aligner backend) and cloud services that speak the
 * OpenAI transcription API. Both give words with times; `transcriptToCues` turns them into captions that follow the rules.
 */
import type { LlmConfig } from "../llm";
import type { Cue, CueWord } from "./cues";
import { DEFAULT_RULES, fixCues, type CaptionRules } from "./checks";
import { applyVocabulary } from "./transcript";

export type TSegment = { start: number; end: number; text: string; words: CueWord[]; speaker?: string };
export type Transcript = { language?: string; segments: TSegment[] };

const R = (n: number) => Math.round(n * 1000) / 1000;

/* ---------- 16 kHz mono WAV, the size speech services want ---------- */

/** Mono 16-bit PCM WAV bytes. */
export function wavBytes(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => out.set([c.charCodeAt(0)], o + i));
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}

export const monoOf = (left: Float32Array, right: Float32Array): Float32Array => Float32Array.from(left, (l, i) => (l + right[i]) / 2);

/* ---------- reading results ---------- */

type VerboseJson = {
  language?: string;
  text?: string;
  segments?: { start: number; end: number; text: string; words?: { word?: string; text?: string; start: number; end: number }[] }[];
  words?: { word?: string; text?: string; start: number; end: number }[];
};

/** The OpenAI `verbose_json` transcription answer (also Groq's): segments, with words matched to the segment they fall in. */
export function parseVerboseJson(j: VerboseJson): Transcript {
  const flat = (j.words ?? []).map((w) => ({ text: (w.word ?? w.text ?? "").trim(), start: R(w.start), end: R(w.end) })).filter((w) => w.text);
  const segments: TSegment[] = (j.segments ?? []).map((s) => {
    const inner = s.words?.map((w) => ({ text: (w.word ?? w.text ?? "").trim(), start: R(w.start), end: R(w.end) })).filter((w) => w.text);
    const words = inner?.length ? inner : flat.filter((w) => (w.start + w.end) / 2 >= s.start - 1e-6 && (w.start + w.end) / 2 < s.end + 1e-6);
    return { start: R(s.start), end: R(s.end), text: s.text.trim(), words };
  });
  // words only, no segments: one segment of everything
  if (!segments.length && flat.length) segments.push({ start: flat[0].start, end: flat[flat.length - 1].end, text: flat.map((w) => w.text).join(" "), words: flat });
  else if (!segments.length && j.text) segments.push({ start: 0, end: 0, text: j.text.trim(), words: [] });
  return { language: j.language, segments: segments.filter((s) => s.text) };
}

/**
 * Captions from a transcript: one cue per segment, then split, wrapped and spaced by the rules. A segment without word
 * times (a service that only gives segments) is spread by characters.
 */
export function transcriptToCues(t: Transcript, rules: CaptionRules = DEFAULT_RULES, o: { vocabulary?: string[] } = {}): Cue[] {
  let cues: Cue[] = t.segments
    .filter((s) => s.text && s.end > s.start)
    .map((s) => {
      const words = s.words.length && s.words.map((w) => w.text).join("") .replace(/\s/g, "") === s.text.replace(/\s/g, "") ? s.words : undefined;
      return { start: s.start, end: s.end, text: s.text.replace(/\s+/g, " "), ...(words ? { words } : {}), ...(s.speaker ? { speaker: s.speaker } : {}) };
    });
  if (o.vocabulary?.length) cues = applyVocabulary(cues, o.vocabulary).cues;
  return fixCues(cues, rules).cues;
}

/* ---------- local helper ---------- */

export type TranscribeStage = "uploading" | "separating" | "loading" | "transcribing";
export type LocalOptions = { language: string; model: string; vocabulary: string[]; separate?: boolean };

type ServerEvent =
  | { type: "stage"; stage: TranscribeStage }
  | { type: "progress"; stage: TranscribeStage; pct: number }
  | { type: "result"; language?: string; segments: { start: number; end: number; text: string; words: CueWord[] }[] }
  | { type: "error"; message: string };

const base = (u: string) => u.trim().replace(/\/+$/, "");

export async function transcribeLocal(url: string, wav: Blob, o: LocalOptions, signal?: AbortSignal, onProgress?: (stage: TranscribeStage, pct?: number) => void): Promise<Transcript> {
  onProgress?.("uploading");
  const form = new FormData();
  form.append("audio", new File([wav], "speech.wav"));
  form.append("language", o.language || "");
  form.append("model", o.model);
  form.append("vocabulary", o.vocabulary.join(", "));
  form.append("separate", String(!!o.separate));
  let res: Response;
  try {
    res = await fetch(`${base(url)}/api/transcribe_stream`, { method: "POST", body: form, signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error("Could not reach the Cutir backend. Start it with: pip install -r backend/requirements.txt, then python backend/run.py");
  }
  if (!res.ok || !res.body) {
    let msg = `The helper answered ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j?.detail === "string") msg = j.detail;
    } catch {
      /* keep the default */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: Transcript | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line) as ServerEvent;
    if (ev.type === "stage") onProgress?.(ev.stage);
    else if (ev.type === "progress") onProgress?.(ev.stage, ev.pct);
    else if (ev.type === "error") throw new Error(ev.message);
    else if (ev.type === "result") result = { language: ev.language, segments: ev.segments };
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  if (!result) throw new Error("The helper stopped without sending a transcript.");
  return result;
}

/* ---------- cloud ---------- */

export const CLOUD_LIMIT = 25 * 1024 * 1024;

/** Which of the configured providers can transcribe, and with which model. */
export function cloudModelFor(cfg: LlmConfig): string | null {
  if (cfg.provider.id === "openai" || cfg.provider.id === "custom") return "whisper-1";
  if (cfg.provider.id === "groq") return "whisper-large-v3-turbo";
  return null;
}

export const cloudProblem = (cfg: LlmConfig): string => {
  if (cfg.provider.id === "none") return "Choose an AI provider in Settings.";
  if (!cloudModelFor(cfg)) return `${cfg.provider.name} does not offer speech to text here. Use OpenAI or Groq (Settings, AI models), or the local helper.`;
  if (cfg.provider.needsKey && !cfg.apiKey.trim()) return `Add your ${cfg.provider.name} API key in Settings.`;
  if (!cfg.baseUrl.trim()) return "Enter the provider's base URL in Settings.";
  return "";
};

export async function transcribeCloud(cfg: LlmConfig, wav: Blob, o: { language?: string; vocabulary: string[] }, signal?: AbortSignal): Promise<Transcript> {
  const problem = cloudProblem(cfg);
  if (problem) throw new Error(problem);
  if (wav.size > CLOUD_LIMIT) throw new Error(`The speech is ${(wav.size / 1048576).toFixed(0)} MB; ${cfg.provider.name} accepts up to 25 MB (about 13 minutes). Transcribe a shorter stretch or use the local helper.`);
  const form = new FormData();
  form.append("file", new File([wav], "speech.wav"));
  form.append("model", cloudModelFor(cfg)!);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (o.language) form.append("language", o.language);
  if (o.vocabulary.length) form.append("prompt", o.vocabulary.join(", "));
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, { method: "POST", headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, body: form, signal });
  if (!res.ok) {
    let msg = `${cfg.provider.name} answered ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j?.error?.message === "string") msg = j.error.message;
    } catch {
      /* keep the default */
    }
    throw new Error(msg);
  }
  return parseVerboseJson((await res.json()) as VerboseJson);
}
