/**
 * Speech-to-text with the browser's Web Speech API (SpeechRecognition).
 *
 * Privacy note: in Chrome the default recognizer sends the microphone audio to Google's speech service; Edge and
 * Safari use their own services. Chrome has an experimental on-device mode (`processLocally`), which this wrapper
 * turns on when asked and when the browser supports it. See docs/VOICE-TTS-MODELS.md.
 */

/* Minimal typings: SpeechRecognition is not in TypeScript's DOM lib. */
interface SRAlternative {
  transcript: string;
  confidence: number;
}
interface SRResult {
  isFinal: boolean;
  length: number;
  [index: number]: SRAlternative;
}
interface SREvent {
  resultIndex: number;
  results: ArrayLike<SRResult>;
}
interface SRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}
type SRConstructor = new () => SRInstance;

const getCtor = (): SRConstructor | undefined => {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: SRConstructor; webkitSpeechRecognition?: SRConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export const sttSupported = () => !!getCtor();

export type STTCallbacks = {
  /** Live text while the user is still talking. */
  onInterim: (text: string) => void;
  /** The finished utterance. Called at most once per start(). */
  onFinal: (text: string) => void;
  onListening: (listening: boolean) => void;
  /** A human-readable problem (blocked microphone, no internet, ...). */
  onError: (message: string) => void;
};

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow it in the browser's site settings, then try again.",
  "service-not-allowed": "The browser's speech service is not allowed here. Check the site's microphone permission.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition could not reach the browser's speech service. It needs an internet connection (or turn on on-device recognition).",
  "language-not-supported": "On-device speech recognition is not installed for this language in this browser. Turn off \"on-device only\" or pick another language.",
  "no-speech": "I didn't hear anything. Try again.",
};

/** One recognizer. Each start() listens for a single utterance (turn-based), which suits a voice-command assistant. */
export class Recognizer {
  private rec: SRInstance | null = null;
  private delivered = false;
  private lastText = "";

  constructor(private cb: STTCallbacks) {}

  get active() {
    return this.rec !== null;
  }

  start(opts: { lang: string; onDevice: boolean }) {
    const Ctor = getCtor();
    if (!Ctor) {
      this.cb.onError("Speech recognition is not available in this browser. Use Chrome, Edge or Safari.");
      return;
    }
    if (this.rec) return; // already listening

    const rec = new Ctor();
    rec.lang = opts.lang;
    rec.continuous = false; // stop after one utterance
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    if (opts.onDevice && "processLocally" in rec) rec.processLocally = true;

    this.delivered = false;
    this.lastText = "";

    rec.onstart = () => this.cb.onListening(true);

    rec.onresult = (e) => {
      let text = "";
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      text = text.trim();
      this.lastText = text;
      if (final && !this.delivered) {
        this.delivered = true;
        this.cb.onFinal(text);
      } else if (!final) {
        this.cb.onInterim(text);
      }
    };

    rec.onerror = (e) => {
      if (e.error === "aborted") return; // we stopped it ourselves
      this.cb.onError(ERRORS[e.error] ?? `Speech recognition error: ${e.error}`);
    };

    rec.onend = () => {
      this.rec = null;
      this.cb.onListening(false);
      // some browsers end with interim text only: treat it as the final result instead of dropping it
      if (!this.delivered && this.lastText) {
        this.delivered = true;
        this.cb.onFinal(this.lastText);
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (e) {
      this.rec = null;
      this.cb.onError(`Could not start the microphone: ${(e as Error).message}`);
    }
  }

  /** Stop listening and use what was heard so far. */
  stop() {
    this.rec?.stop();
  }

  /** Stop listening and throw away what was heard. */
  abort() {
    this.delivered = true; // suppress the final callback
    this.rec?.abort();
    this.rec = null;
    this.cb.onListening(false);
  }
}
