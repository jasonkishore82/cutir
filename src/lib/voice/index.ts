import { useVoice } from "../../store/voice";
import { Recognizer, sttSupported } from "./stt";
import { Speaker, browserProvider, looksLikeToolCall, ttsSupported, voicesReady } from "./tts";

/**
 * The voice assistant: ties speech-to-text, the chat, and text-to-speech together.
 *
 *   mic -> Web Speech STT -> chat.send(text) -> reply streams in -> sentences are spoken as they complete
 *
 * Turn-taking: while the assistant speaks, the microphone is off (no echo loop). Pressing the mic while it speaks
 * interrupts it (barge-in). In hands-free mode the mic turns back on after each reply.
 */

export { sttSupported } from "./stt";
export { ttsSupported } from "./tts";

type Handlers = { onInterim: (text: string) => void; onFinal: (text: string) => void; isBusy: () => boolean };
let handlers: Handlers | null = null;

/** The chat panel registers how a finished utterance is sent. */
export function registerVoiceHandlers(h: Handlers | null) {
  handlers = h;
}

const v = () => useVoice.getState();

/* ---------- speaking ---------- */

const speaker = new Speaker(
  browserProvider,
  () => ({ lang: v().lang, voiceURI: v().voiceURI, rate: v().rate }),
  {
    onSpeaking: (speaking) => {
      v().set({ speaking });
      if (!speaking) afterTurn();
    },
  }
);

let spokenLen = 0; // how much of the current reply has already been handed to the speaker

/** Call when the user sends a message: silence anything still being read out. */
export function beginReply() {
  speaker.cancel();
  spokenLen = 0;
}

/** Call with the reply text so far (it grows while the model streams). */
export function speakReplyStream(textSoFar: string) {
  if (!v().speakReplies || !ttsSupported()) return;
  if (looksLikeToolCall(textSoFar)) return; // a tool call written as text is not for the ears
  const fresh = textSoFar.slice(spokenLen);
  if (!fresh) return;
  spokenLen = textSoFar.length;
  speaker.feed(fresh);
}

/** The reply is complete. `fallback` is spoken only if nothing was said yet (for example tool-only replies). */
export function endReply(fallback?: string) {
  if (v().speakReplies && ttsSupported()) {
    speaker.flush();
    if (spokenLen === 0 && fallback) speaker.say(fallback);
  }
  afterTurn();
}

/** The chat is idle again after a turn. In hands-free mode this is what turns the microphone back on. */
export function turnEnded() {
  afterTurn();
}

/** Say something short right away (confirmations, errors). */
export function sayNow(text: string) {
  if (v().speakReplies && ttsSupported()) speaker.say(text);
  else afterTurn();
}

export function stopSpeaking() {
  speaker.cancel();
}

/** One short sentence for the spoken confirmation of a set of applied tool calls. */
export function spokenSummary(results: { ok: boolean; noop?: boolean; summary: string }[]): string {
  const done = results.filter((r) => r.ok && !r.noop).map((r) => r.summary.replace(/^[\w_]+: /, ""));
  const failed = results.find((r) => !r.ok);
  if (done.length === 1 && /^[A-Za-z ]{3,32}$/.test(done[0])) return `Done, ${done[0]}.`; // plain wording only (no hex codes, numbers or symbols)
  if (done.length > 1) return `Done, ${done.length} changes.`;
  if (done.length === 1) return "Done.";
  if (failed) return `That didn't work. ${failed.summary.replace(/^[\w_]+: /, "")}`;
  return "That is already set.";
}

/* ---------- listening ---------- */

const recognizer = new Recognizer({
  onInterim: (text) => {
    v().set({ interim: text });
    handlers?.onInterim(text);
  },
  onFinal: (text) => {
    v().set({ interim: "" });
    if (text) handlers?.onFinal(text);
  },
  onListening: (listening) => {
    v().set({ listening, ...(listening ? { message: "" } : { interim: "" }) });
  },
  onError: (message) => {
    // hands-free must not keep re-opening a microphone that just failed (blocked, no internet, ...)
    handsFreePaused = true;
    v().set({ message, listening: false });
  },
});

let handsFreePaused = false; // set after a microphone error; cleared when the user presses the mic themselves

/** `manual` = the user pressed the mic (as opposed to hands-free restarting it). */
export function startListening(manual = true) {
  if (!sttSupported()) {
    v().set({ message: "Speech recognition is not available in this browser. Use Chrome, Edge or Safari." });
    return;
  }
  if (manual) handsFreePaused = false;
  speaker.cancel(); // barge-in: talking over the assistant interrupts it
  v().set({ message: "", interim: "" });
  recognizer.start({ lang: v().lang, onDevice: v().onDevice });
}

export function stopListening() {
  recognizer.abort();
  v().set({ listening: false, interim: "" });
}

export function toggleListening() {
  if (v().listening || recognizer.active) stopListening();
  else startListening();
}

/** Hands-free: once the assistant is done talking and the chat is idle, listen again. */
function afterTurn() {
  if (!v().handsFree || !sttSupported() || handsFreePaused) return;
  if (speaker.busy || recognizer.active || handlers?.isBusy()) return;
  // small pause so the end of the speech is not picked up by the microphone
  setTimeout(() => {
    if (v().handsFree && !handsFreePaused && !speaker.busy && !recognizer.active && !handlers?.isBusy()) startListening(false);
  }, 350);
}

/* ---------- setup ---------- */

/** Load the browser's voices into the store (they arrive asynchronously). */
export async function loadVoices() {
  if (!ttsSupported()) return;
  v().set({ voices: await voicesReady() });
}
