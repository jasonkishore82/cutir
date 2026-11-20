/**
 * Text-to-speech for the voice assistant.
 *
 * Latency design: text is cut into sentences and each sentence is spoken as soon as it is complete, so speech
 * can start while the language model is still writing (time-to-first-audio = first sentence, not the whole reply).
 *
 * The engine behind it is a TTSProvider. Today that is the browser's built-in speechSynthesis (no setup, instant
 * start). A local neural model (Kokoro, Orpheus, ...) can be added as another provider without touching callers;
 * see docs/VOICE-TTS-MODELS.md.
 */

export type SpeakOptions = { lang: string; voiceURI: string; rate: number };

export interface TTSProvider {
  /** Speak one chunk and resolve when it has finished (or was cancelled). */
  speak(text: string, opts: SpeakOptions): Promise<void>;
  /** Stop speaking immediately. */
  cancel(): void;
}

/* ---------- text preparation ---------- */

/** Make model output fit for speaking: no code, JSON, markdown symbols or raw URLs. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // code blocks
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, " ")
    .replace(/\(applied:[^)]*\)/gi, " ")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[`*_#>~|]/g, "") // markdown marks
    .replace(/\s+/g, " ")
    .trim();
}

/** True while a reply still looks like a tool call written as text (never read those out). */
export const looksLikeToolCall = (text: string) => /^\s*(```|\{|\[|<tool_call>)/.test(text);

/**
 * Pull complete sentences off the front of `buffer`. Returns the sentences and what is left over.
 * A sentence ends at . ! ? … followed by whitespace, or at a line break. A mark at the very end of the buffer is
 * not trusted yet (the next characters might make it "3.5" or "e.g."), so that text stays in `rest` until more
 * arrives or the speaker is flushed.
 */
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const re = /[.!?…]+["')\]]*(?=\s)|\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer))) {
    const end = m.index + m[0].length;
    const s = buffer.slice(start, end).trim();
    if (s.length < 3 || /\b(e\.g|i\.e|etc|vs|mr|mrs|dr|st)\.$/i.test(s)) continue; // too short / an abbreviation: keep going
    sentences.push(s);
    start = end;
  }
  return { sentences, rest: buffer.slice(start) };
}

/* ---------- the browser provider ---------- */

export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

export function listVoices(): SpeechSynthesisVoice[] {
  return ttsSupported() ? window.speechSynthesis.getVoices() : [];
}

/** Voices load asynchronously in Chrome; resolve once the list is available (or after a short timeout). */
export function voicesReady(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!ttsSupported()) return resolve([]);
    const have = window.speechSynthesis.getVoices();
    if (have.length) return resolve(have);
    const done = () => resolve(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

function pickVoice(opts: SpeakOptions): SpeechSynthesisVoice | undefined {
  const voices = listVoices();
  if (opts.voiceURI) {
    const exact = voices.find((v) => v.voiceURI === opts.voiceURI);
    if (exact) return exact;
  }
  const base = opts.lang.slice(0, 2).toLowerCase();
  const sameLang = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  // prefer a local voice (starts instantly, works offline) over a network voice
  return sameLang.find((v) => v.localService) ?? sameLang[0];
}

export const browserProvider: TTSProvider = {
  speak(text, opts) {
    return new Promise<void>((resolve) => {
      if (!ttsSupported()) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickVoice(opts);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = opts.lang;
      }
      u.rate = opts.rate;
      u.onend = () => resolve();
      u.onerror = () => resolve(); // "canceled" and "interrupted" land here too; never leave the queue hanging
      window.speechSynthesis.speak(u);
    });
  },
  cancel() {
    if (ttsSupported()) window.speechSynthesis.cancel();
  },
};

/* ---------- the speaking queue ---------- */

export type SpeakerEvents = { onSpeaking: (speaking: boolean) => void };

/** Speaks text as it streams in: feed() deltas, flush() at the end, cancel() to interrupt (barge-in). */
export class Speaker {
  private buffer = "";
  private queue: string[] = [];
  private running = false;
  private generation = 0; // bumped by cancel(); lets a running loop notice it was cancelled

  constructor(
    private provider: TTSProvider,
    private getOpts: () => SpeakOptions,
    private events: SpeakerEvents
  ) {}

  setProvider(p: TTSProvider) {
    this.provider = p;
  }

  feed(delta: string) {
    this.buffer += delta;
    const { sentences, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    for (const s of sentences) this.enqueue(s);
  }

  /** Speak whatever is left in the buffer (the reply has finished). */
  flush() {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) this.enqueue(tail);
  }

  /** Speak a complete text right away (feed + flush). */
  say(text: string) {
    this.feed(text + " ");
    this.flush();
  }

  cancel() {
    this.generation++;
    this.buffer = "";
    this.queue = [];
    this.provider.cancel();
    if (this.running) {
      this.running = false;
      this.events.onSpeaking(false);
    }
  }

  get busy() {
    return this.running || this.queue.length > 0 || this.buffer.trim().length > 0;
  }

  private enqueue(raw: string) {
    const text = cleanForSpeech(raw);
    if (!text) return;
    this.queue.push(text);
    if (!this.running) void this.run();
  }

  private async run() {
    const gen = this.generation;
    this.running = true;
    this.events.onSpeaking(true);
    while (this.queue.length && gen === this.generation) {
      const next = this.queue.shift()!;
      await this.provider.speak(next, this.getOpts());
    }
    if (gen === this.generation) {
      this.running = false;
      this.events.onSpeaking(false);
    }
  }
}
