import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useChat } from "../store/chat";
import { useActiveConfig, useSettings } from "../store/settings";
import { useVoice } from "../store/voice";
import { loadVoices, sttSupported, ttsSupported } from "../lib/voice";
import { browserProvider } from "../lib/voice/tts";

const DOT: Record<string, string> = {
  online: "bg-green-500",
  offline: "bg-red-500",
  checking: "bg-yellow-400 animate-pulse",
  unknown: "bg-gray-500",
};

const LANGS: [string, string][] = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["en-IN", "English (India)"],
  ["hi-IN", "Hindi"],
  ["es-ES", "Spanish"],
  ["fr-FR", "French"],
  ["de-DE", "German"],
  ["it-IT", "Italian"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["ru-RU", "Russian"],
  ["tr-TR", "Turkish"],
  ["ar-SA", "Arabic"],
  ["ja-JP", "Japanese"],
  ["ko-KR", "Korean"],
  ["zh-CN", "Chinese (Mandarin)"],
  ["id-ID", "Indonesian"],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-edge pb-3 last:border-0 last:pb-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2 ${disabled ? "opacity-40" : ""}`}>
      <input type="checkbox" className="mt-0.5 accent-accent" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-gray-200">{label}</span>
        {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
      </span>
    </label>
  );
}

/** The gear popup: AI model shortcut, voice, and chat actions. Floats above the composer. */
export default function ChatSettings({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const { status, statusDetail } = useChat();
  const { clear } = useChat.getState();
  const { provider, model } = useActiveConfig();
  const noProvider = provider.id === "none";
  const voice = useVoice();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadVoices();
  }, []);

  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  // voices for the chosen language first
  const base = voice.lang.slice(0, 2).toLowerCase();
  const voices = [...voice.voices].sort((a, b) => Number(b.lang.toLowerCase().startsWith(base)) - Number(a.lang.toLowerCase().startsWith(base)) || a.name.localeCompare(b.name));
  const langOptions = LANGS.some(([c]) => c === voice.lang) ? LANGS : [[voice.lang, voice.lang] as [string, string], ...LANGS];
  const sttOk = sttSupported();
  const ttsOk = ttsSupported();

  const width = 320;
  const style = {
    right: Math.max(8, window.innerWidth - anchor.right),
    bottom: window.innerHeight - anchor.top + 8,
    width,
    maxHeight: Math.max(240, anchor.top - 16),
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Chat settings"
      className="fixed z-[250] space-y-3 overflow-y-auto rounded-xl border border-edge bg-panel p-4 text-xs shadow-2xl"
      style={style}
    >
      <Section title="AI model">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[status]}`} title={statusDetail || status} />
          <span className="min-w-0 flex-1 truncate text-gray-300">
            {noProvider ? "No provider chosen" : `${provider.name} · ${model || "no model"}`}
          </span>
          <button
            className="shrink-0 rounded border border-edge px-2 py-1 hover:bg-edge"
            onClick={() => {
              useSettings.getState().openDialog("ai");
              onClose();
            }}
          >
            Change
          </button>
        </div>
        {status === "offline" && !noProvider && <p className="text-[11px] text-red-400">{statusDetail}</p>}
      </Section>

      <Section title="Voice">
        <Toggle label="Read replies aloud" hint={ttsOk ? "Uses your browser's voices." : "Speech output is not available in this browser."} checked={voice.speakReplies} disabled={!ttsOk} onChange={(v) => voice.set({ speakReplies: v })} />
        <Toggle
          label="Hands-free conversation"
          hint={sttOk ? "After each reply the microphone turns on again." : "Speech input is not available in this browser (use Chrome, Edge or Safari)."}
          checked={voice.handsFree}
          disabled={!sttOk}
          onChange={(v) => voice.set({ handsFree: v })}
        />

        <label className="block">
          <span className="label">Language</span>
          <select className="field" value={voice.lang} onChange={(e) => voice.set({ lang: e.target.value, voiceURI: "" })}>
            {langOptions.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </label>

        {ttsOk && (
          <>
            <label className="block">
              <span className="label">Voice</span>
              <select className="field" value={voice.voiceURI} onChange={(e) => voice.set({ voiceURI: e.target.value })}>
                <option value="">Automatic</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang}){v.localService ? "" : " · online"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Speed: {voice.rate.toFixed(1)}x</span>
              <input type="range" min={0.7} max={1.6} step={0.1} value={voice.rate} className="w-full accent-accent" onChange={(e) => voice.set({ rate: Number(e.target.value) })} />
            </label>
            <button
              className="rounded border border-edge px-2 py-1 hover:bg-edge"
              onClick={() => {
                browserProvider.cancel();
                void browserProvider.speak("Hello! This is how I will sound.", { lang: voice.lang, voiceURI: voice.voiceURI, rate: voice.rate });
              }}
            >
              Hear a sample
            </button>
          </>
        )}

        {sttOk && (
          <Toggle
            label="Keep speech on this device"
            hint="Experimental (Chrome). Needs the language installed; otherwise the browser's speech service is used."
            checked={voice.onDevice}
            onChange={(v) => voice.set({ onDevice: v })}
          />
        )}
        <p className="rounded border border-edge bg-bg px-2 py-1.5 text-[11px] leading-relaxed text-gray-500">
          Privacy: with the default settings Chrome sends what you say to its speech service to turn it into text. Nothing is sent when the microphone is off. Replies are read by your own browser.
        </p>
      </Section>

      <Section title="Chat">
        <button className="rounded border border-edge px-2 py-1 hover:bg-edge" onClick={() => (clear(), onClose())}>
          Clear this chat
        </button>
      </Section>
    </div>,
    document.body
  );
}
