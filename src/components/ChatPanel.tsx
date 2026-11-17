import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChat, type Attachment, type ChatEntry } from "../store/chat";
import { useProject } from "../store/project";
import Thinking from "./Thinking";

const DOT: Record<string, string> = {
  online: "bg-green-500",
  offline: "bg-red-500",
  checking: "bg-yellow-400 animate-pulse",
  unknown: "bg-gray-500",
};

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** One timeline entry: dot on the left rail, optional right-aligned timestamp, no bubble. */
function Row({ dot = "bg-gray-500", time, children }: { dot?: string; time?: number; children: ReactNode }) {
  return (
    <div className="relative pl-5">
      <span className={`absolute left-[3px] top-[7px] h-[7px] w-[7px] rounded-full ${dot}`} />
      {time !== undefined && <div className="text-right text-[11px] text-gray-500 leading-4 mb-0.5">{clock(time)}</div>}
      {children}
    </div>
  );
}

function AppliedCard({ m }: { m: ChatEntry }) {
  const undoApplied = useChat((s) => s.undoApplied);
  const current = useProject((s) => s.project);
  const a = m.applied!;
  const okCount = a.results.filter((r) => r.ok && !r.noop).length;
  const canUndo = !a.undone && okCount > 0 && current === a.after;

  return (
    <Row>
      <div className="flex items-center justify-between">
        <span className="font-semibold text-[13px] text-gray-200">
          {a.undone ? "Changes undone" : okCount ? "Applied changes" : "No changes applied"}
        </span>
        {okCount > 0 && (
          <button
            className="px-2 py-0.5 text-[11px] rounded border border-edge text-gray-400 hover:bg-edge disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={!canUndo}
            onClick={() => undoApplied(m.id)}
            title={canUndo ? "Undo these changes" : a.undone ? "Already undone" : "Newer edits exist; use Ctrl+Z to step back"}
          >
            Undo
          </button>
        )}
      </div>
      <div className="mt-1.5 rounded border border-edge bg-bg px-3 py-2 font-mono text-[11px] leading-5 space-y-0.5">
        {a.results.map((r, i) => (
          <div key={i} className={`flex gap-2 ${r.ok ? "text-gray-300" : "text-red-400"}`}>
            <span className="text-gray-600 select-none">{!r.ok ? "ERR" : r.noop ? "-- " : "OK "}</span>
            <span className="min-w-0 break-words">{r.summary}</span>
          </div>
        ))}
      </div>
    </Row>
  );
}

export default function ChatPanel() {
  const { baseUrl, model, models, status, statusDetail, messages, busy, chats, activeId } = useChat();
  const { setBaseUrl, setModel, refreshModels, send, stop, clear, newChat, switchChat, closeChat } = useChat.getState();
  const [draft, setDraft] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const commitUrl = () => {
    const u = urlDraft.trim();
    if (u && u !== baseUrl) setBaseUrl(u);
  };

  const submit = () => {
    if ((!draft.trim() && !atts.length) || busy) return;
    send(draft, atts);
    setDraft("");
    setAtts([]);
    setAttachError("");
  };

  const MAX_FILES = 4;
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setAttachError("");
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      if (atts.length + next.length >= MAX_FILES) {
        setAttachError(`Up to ${MAX_FILES} attachments per message.`);
        break;
      }
      if (f.type.startsWith("image/")) {
        if (f.size > 8 * 1024 * 1024) {
          setAttachError(`${f.name} is over 8 MB.`);
          continue;
        }
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(r.error);
          r.readAsDataURL(f);
        });
        next.push({ name: f.name, kind: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      } else if (/\.(txt|lrc|srt|json|md)$/i.test(f.name) || f.type.startsWith("text/")) {
        const t = await f.text();
        next.push({ name: f.name, kind: "text", data: t.length > 12000 ? t.slice(0, 12000) + "\n...(truncated)" : t });
      } else {
        setAttachError(`${f.name}: attach an image or a .txt / .lrc / .srt file.`);
      }
    }
    if (next.length) setAtts((x) => [...x, ...next]);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="h-full flex flex-col">
      {/* chat tabs */}
      <div className="flex items-stretch h-9 shrink-0 border-b border-edge bg-bg/60">
        <div className="flex-1 min-w-0 flex overflow-x-auto">
          {chats.map((c) => {
            const active = c.id === activeId;
            return (
              <div
                key={c.id}
                role="tab"
                aria-selected={active}
                onClick={() => switchChat(c.id)}
                title={busy && !active ? "Wait for the current reply to finish" : c.title}
                className={`group flex items-center gap-2 pl-3 pr-1.5 max-w-[200px] shrink-0 text-xs cursor-pointer border-r border-edge ${
                  active ? "bg-panel text-gray-100 border-t-2 border-t-accent" : "text-gray-500 hover:text-gray-300 border-t-2 border-t-transparent"
                } ${busy && !active ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span className="text-accent text-sm leading-none">✱</span>
                <span className="truncate">{c.title}</span>
                <button
                  aria-label={`Close ${c.title}`}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeChat(c.id);
                  }}
                  className="w-5 h-5 rounded text-gray-500 hover:bg-edge hover:text-gray-100 disabled:opacity-40 leading-none"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          onClick={newChat}
          disabled={busy}
          title="New chat"
          aria-label="New chat"
          className="w-9 shrink-0 text-lg text-gray-400 hover:text-gray-100 hover:bg-edge disabled:opacity-40 border-l border-edge"
        >
          +
        </button>
      </div>

      <div className="p-3 border-b border-edge space-y-2">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${DOT[status]}`} title={statusDetail || status} />
          <input
            className="field"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={commitUrl}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), commitUrl())}
            placeholder="http://localhost:11434"
            aria-label="Ollama URL"
          />
        </div>
        <div className="flex gap-2">
          <select className="field flex-1" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
            {!models.length && <option value="">{status === "online" ? "no models installed" : "no models"}</option>}
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            className="px-2 text-xs rounded border border-edge hover:bg-edge"
            onClick={() => refreshModels()}
            title="Refresh models"
          >
            ↻
          </button>
          <button className="px-2 text-xs rounded border border-edge hover:bg-edge" onClick={clear} title="Clear chat">
            Clear
          </button>
        </div>
        {status === "offline" && <p className="text-[11px] text-red-400">{statusDetail}</p>}
        {status === "online" && !models.length && <p className="text-[11px] text-yellow-400">{statusDetail}</p>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 text-[13px]">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4 pb-6">
            <div className="flex items-center gap-2.5">
              <img src="/favicon.svg" alt="" className="h-9 w-9" />
              <span className="text-[30px] leading-none text-gray-100 tracking-tight" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
                Cutir
              </span>
            </div>
            <p className="text-xs text-gray-500">Edit your lyric video in plain English</p>
            <div className="flex flex-col gap-1.5 w-full max-w-[260px]">
              {["make the font bigger", "shift lines 4 to 8 by 0.5s", "use a pink-to-orange gradient", "delete line 2"].map((t) => (
                <button
                  key={t}
                  onClick={() => setDraft(t)}
                  className="text-xs text-gray-400 border border-edge rounded px-3 py-1.5 hover:bg-edge hover:text-gray-100 text-left"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="relative space-y-4">
          {/* the vertical rail the dots sit on */}
          {messages.length > 0 && <span className="absolute left-[6px] top-3 bottom-3 w-px bg-edge" />}
          {messages.map((m) => {
            if (m.role === "note")
              return (
                <Row key={m.id}>
                  <p className="text-xs text-gray-500">{m.content}</p>
                </Row>
              );
            if (m.role === "error")
              return (
                <Row key={m.id} dot="bg-red-500" time={m.at}>
                  <p className="text-red-400 whitespace-pre-wrap break-words leading-relaxed">{m.content}</p>
                </Row>
              );
            if (m.role === "user")
              return (
                <Row key={m.id} dot="bg-accent" time={m.at}>
                  {m.content && <p className="text-gray-100 whitespace-pre-wrap break-words leading-relaxed">{m.content}</p>}
                  {m.attachments && (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {m.attachments.map((a, i) => (
                        <span key={i} className="inline-flex items-center gap-1.5 rounded border border-edge bg-bg px-1.5 py-0.5 text-[11px] text-gray-300 max-w-full">
                          {a.kind === "image" && <img src={`data:image/*;base64,${a.data}`} alt="" className="h-5 w-5 rounded object-cover" />}
                          <span className="truncate">{a.name}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </Row>
              );
            return (
              <div key={m.id} className="space-y-4">
                {m.streaming && !m.content && (
                  <Row dot="bg-gray-500 animate-pulse">
                    <Thinking tokens={m.tokens} />
                  </Row>
                )}
                {!m.streaming && !!m.thoughtSecs && m.thoughtSecs > 0 && (
                  <Row>
                    <p className="text-gray-500">Thought for {m.thoughtSecs}s</p>
                  </Row>
                )}
                {m.content && (
                  <Row time={m.streaming ? undefined : m.at}>
                    <p className="text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
                      {m.content}
                      {m.streaming && <span className="inline-block w-1.5 h-3.5 bg-gray-400 ml-0.5 align-middle animate-pulse" />}
                    </p>
                  </Row>
                )}
                {m.applied && <AppliedCard m={m} />}
              </div>
            );
          })}
        </div>
        <div ref={endRef} />
      </div>

      <div className="p-3 border-t border-edge">
        {atts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {atts.map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded border border-edge bg-bg pl-1.5 pr-1 py-0.5 text-[11px] text-gray-300 max-w-[160px]">
                {a.kind === "image" && <img src={`data:image/*;base64,${a.data}`} alt="" className="h-5 w-5 rounded object-cover" />}
                <span className="truncate">{a.name}</span>
                <button
                  aria-label={`Remove ${a.name}`}
                  className="text-gray-500 hover:text-gray-100 leading-none px-0.5"
                  onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachError && <p className="text-[11px] text-red-400 mb-1">{attachError}</p>}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <textarea
              className="field resize-none h-20 !pb-8"
              placeholder="Describe an edit…  (Enter to send, Shift+Enter for newline)"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.txt,.lrc,.srt,.json,.md"
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              title="Attach an image or a .txt / .lrc / .srt file (images need a vision model)"
              aria-label="Attach file"
              className="absolute left-1.5 bottom-1.5 h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-gray-100 hover:bg-edge disabled:opacity-40"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
          </div>
          {busy ? (
            <button className="px-3 text-xs rounded border border-red-700 text-red-300 hover:bg-red-950" onClick={stop}>Stop</button>
          ) : (
            <button
              className="px-3 text-xs rounded bg-accent text-black font-medium disabled:opacity-40"
              onClick={submit}
              disabled={!draft.trim() && !atts.length}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
