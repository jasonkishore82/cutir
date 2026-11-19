import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useChat, type Attachment } from "../store/chat";
import { useVoice } from "../store/voice";
import { useActiveConfig } from "../store/settings";
import { registerVoiceHandlers, sttSupported, stopSpeaking, toggleListening, ttsSupported } from "../lib/voice";
import ChatSettings from "./ChatSettings";

const DOT: Record<string, string> = {
  online: "bg-green-500",
  offline: "bg-red-500",
  checking: "bg-yellow-400 animate-pulse",
  unknown: "bg-gray-500",
};

const Icon = ({ children, size = 16 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

const tool = "flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-edge hover:text-gray-100 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400";

/**
 * The chat input, laid out like Claude Code's: a rounded box with the text area on top (microphone in its corner)
 * and a toolbar underneath (attach, read-aloud, model, settings gear, send/stop).
 */
export default function Composer({
  draft,
  setDraft,
  atts,
  setAtts,
  attachError,
  onAddFiles,
  onSubmit,
}: {
  draft: string;
  setDraft: (v: string) => void;
  atts: Attachment[];
  setAtts: Dispatch<SetStateAction<Attachment[]>>;
  attachError: string;
  onAddFiles: (files: FileList | null) => void;
  onSubmit: () => void;
}) {
  const status = useChat((s) => s.status);
  const busy = useChat((s) => !!s.running[s.activeId]);
  const { stop } = useChat.getState();
  const { provider, model } = useActiveConfig();
  const noProvider = provider.id === "none";
  const voice = useVoice();
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [settings, setSettings] = useState<DOMRect | null>(null);
  const sttOk = sttSupported();
  const ttsOk = ttsSupported();

  // grow with the text, up to about 8 lines
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  // a finished spoken sentence is sent like a typed message; live text shows in the box while talking
  useEffect(() => {
    registerVoiceHandlers({
      onInterim: setDraft,
      onFinal: (text) => {
        setDraft("");
        void useChat.getState().send(text);
      },
      isBusy: () => {
        const c = useChat.getState();
        return !!c.running[c.activeId];
      },
    });
    return () => registerVoiceHandlers(null);
  }, [setDraft]);

  const canSend = !noProvider && (!!draft.trim() || atts.length > 0);
  const status2 = voice.listening ? "listening" : voice.speaking ? "speaking" : voice.message ? "message" : "";

  return (
    <div className="p-3">
      <div
        className={`rounded-xl border bg-bg transition-shadow ${
          voice.listening ? "border-sky-400 shadow-[0_0_0_3px_rgba(91,157,255,0.18)]" : "border-accent/50 focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(91,157,255,0.12)]"
        }`}
      >
        {atts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {atts.map((a, i) => (
              <span key={i} className="inline-flex max-w-[160px] items-center gap-1.5 rounded-md border border-edge bg-panel py-0.5 pl-1.5 pr-1 text-[11px] text-gray-300">
                {a.kind === "image" && <img src={`data:image/*;base64,${a.data}`} alt="" className="h-5 w-5 rounded object-cover" />}
                <span className="truncate">{a.name}</span>
                <button aria-label={`Remove ${a.name}`} className="px-0.5 leading-none text-gray-500 hover:text-gray-100" onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachError && <p className="px-3.5 pt-2 text-[11px] text-red-400">{attachError}</p>}

        {/* text area with the microphone in its top-right corner */}
        <div className="relative">
          <textarea
            ref={areaRef}
            rows={1}
            className="block max-h-[168px] min-h-[44px] w-full resize-none bg-transparent px-3.5 pb-2 pt-3 pr-11 text-[13px] leading-relaxed text-gray-100 outline-none placeholder:text-gray-500"
            placeholder={noProvider ? "Choose an AI provider in settings first" : voice.listening ? "Listening…" : "Describe an edit…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
          <button
            type="button"
            onClick={toggleListening}
            disabled={!sttOk}
            aria-label={voice.listening ? "Stop listening" : "Speak your edit"}
            aria-pressed={voice.listening}
            title={sttOk ? (voice.listening ? "Stop listening" : "Speak your edit") : "Speech input is not available in this browser (use Chrome, Edge or Safari)"}
            className={`absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-md ${
              voice.listening ? "bg-sky-400/20 text-sky-300" : "text-gray-500 hover:bg-edge hover:text-gray-100"
            } disabled:opacity-30 disabled:hover:bg-transparent`}
          >
            {voice.listening && <span className="absolute inset-0 animate-ping rounded-md bg-sky-400/20" />}
            <Icon>
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0014 0M12 18v4M8 22h8" />
            </Icon>
          </button>
        </div>

        {status2 && (
          <div className="px-3.5 pb-1.5 text-[11px]" role="status">
            {status2 === "listening" && <span className="text-sky-300">● Listening… speak now</span>}
            {status2 === "speaking" && (
              <span className="text-gray-400">
                ♪ Speaking… <button className="underline hover:text-gray-100" onClick={stopSpeaking}>skip</button>
              </span>
            )}
            {status2 === "message" && <span className="text-red-400">{voice.message}</span>}
          </div>
        )}

        {/* toolbar */}
        <div className="flex items-center gap-1 border-t border-edge/70 px-2 py-1.5">
          <input ref={fileRef} type="file" multiple accept="image/*,.txt,.lrc,.srt,.json,.md" className="hidden" onChange={(e) => onAddFiles(e.target.files)} />
          <button type="button" className={tool} disabled={busy} onClick={() => fileRef.current?.click()} aria-label="Attach file" title="Attach an image or a .txt / .lrc / .srt file (images need a vision model)">
            <Icon size={17}>
              <path d="M12 5v14M5 12h14" />
            </Icon>
          </button>

          <button
            type="button"
            className={`${tool} ${voice.speakReplies ? "!text-sky-300" : ""}`}
            disabled={!ttsOk}
            aria-pressed={voice.speakReplies}
            aria-label="Read replies aloud"
            title={voice.speakReplies ? "Replies are read aloud (click to mute)" : "Read replies aloud"}
            onClick={() => {
              if (voice.speakReplies) stopSpeaking();
              voice.set({ speakReplies: !voice.speakReplies });
            }}
          >
            <Icon>
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              {voice.speakReplies ? <path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" /> : <path d="M22 9l-6 6M16 9l6 6" />}
            </Icon>
          </button>

          <button
            type="button"
            onClick={(e) => setSettings(settings ? null : e.currentTarget.getBoundingClientRect())}
            title="Model and connection settings"
            className="ml-1 flex min-w-0 items-center gap-1.5 rounded-full border border-edge bg-panel px-2.5 py-0.5 text-[11px] text-gray-300 hover:bg-edge"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status]}`} />
            <span className="truncate">{noProvider ? "no provider" : model || "no model"}</span>
          </button>

          <span className="flex-1" />

          <button
            type="button"
            className={`${tool} ${settings ? "!bg-edge !text-gray-100" : ""}`}
            onClick={(e) => setSettings(settings ? null : e.currentTarget.getBoundingClientRect())}
            aria-label="Chat settings"
            aria-expanded={!!settings}
            title="Settings: AI model, voice"
          >
            <Icon>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </Icon>
          </button>

          {busy ? (
            <button type="button" onClick={stop} aria-label="Stop" title="Stop" className="ml-1 flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-black hover:brightness-110">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect width="12" height="12" rx="2" fill="currentColor" /></svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSend}
              aria-label="Send"
              title="Send (Enter)"
              className="ml-1 flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-black hover:brightness-110 disabled:opacity-35 disabled:hover:brightness-100"
            >
              <Icon size={16}>
                <path d="M12 19V5M5 12l7-7 7 7" />
              </Icon>
            </button>
          )}
        </div>
      </div>

      {settings && <ChatSettings anchor={settings} onClose={() => setSettings(null)} />}
    </div>
  );
}
