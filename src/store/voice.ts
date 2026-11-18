import { create } from "zustand";

/** Voice settings (saved) and live state (not saved). */

export type VoiceSettings = {
  speakReplies: boolean; // read the assistant's replies aloud
  handsFree: boolean; // after a reply, listen again automatically (conversation mode)
  lang: string; // speech recognition and default voice language, e.g. "en-US"
  voiceURI: string; // chosen TTS voice ("" = automatic)
  rate: number; // speaking speed, 0.7 to 1.6
  onDevice: boolean; // ask the browser to recognise speech on this device (Chrome, experimental)
};

type VoiceState = VoiceSettings & {
  listening: boolean;
  speaking: boolean;
  interim: string; // live transcript while listening
  message: string; // last problem or hint to show the user
  voices: SpeechSynthesisVoice[];
  set: (patch: Partial<VoiceState>) => void;
};

const KEY = "cutir:voice";

const defaults = (): VoiceSettings => ({
  speakReplies: false,
  handsFree: false,
  lang: typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US",
  voiceURI: "",
  rate: 1,
  onDevice: false,
});

function load(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaults(), ...JSON.parse(raw) } : defaults();
  } catch {
    return defaults();
  }
}

export const useVoice = create<VoiceState>((set, get) => ({
  ...load(),
  listening: false,
  speaking: false,
  interim: "",
  message: "",
  voices: [],
  set: (patch) => {
    set(patch);
    // persist only the settings
    const { speakReplies, handsFree, lang, voiceURI, rate, onDevice } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ speakReplies, handsFree, lang, voiceURI, rate, onDevice }));
    } catch {
      /* storage unavailable */
    }
  },
}));
