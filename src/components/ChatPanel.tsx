import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChat, type Attachment, type ChatEntry, type Conv } from "../store/chat";
import { useActiveConfig, useSettings } from "../store/settings";
import { useProject } from "../store/project";
import { Icon } from "./ui";
import Thinking from "./Thinking";
import SyncProgress from "./SyncProgress";
import Composer from "./Composer";

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
  const canUndo = !a.undone && okCount > 0 && !!a.after && current === a.after;

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
            title={canUndo ? "Undo these changes" : a.undone ? "Already undone" : "Use Ctrl+Z to step back"}
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

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
};

/** Text that turns into an input on demand; Enter saves, Escape cancels. */
function InlineName({ value, editing, onDone, className = "" }: { value: string; editing: boolean; onDone: (v: string | null) => void; className?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (editing) setDraft(value);
  }, [editing, value]);
  if (!editing) return <span className={`truncate ${className}`}>{value}</span>;
  return (
    <input
      autoFocus
      aria-label="Chat name"
      className="min-w-0 flex-1 rounded border border-accent/60 bg-bg px-1.5 py-0.5 text-xs text-gray-100"
      value={draft}
      maxLength={60}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(draft);
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

/** Open conversations as tabs. Double-click renames, middle-click or the x closes the tab (the chat stays in history). */
function TabStrip({ convs, openIds, activeId, running }: { convs: Record<string, Conv>; openIds: string[]; activeId: string; running: Record<string, boolean> }) {
  const { openChat, closeTab, renameChat } = useChat.getState();
  const [renaming, setRenaming] = useState<string | null>(null);
  const activeTab = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, openIds.length]);

  return (
    <div role="tablist" aria-label="Chats" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {openIds.map((id) => {
        const c = convs[id];
        if (!c) return null;
        const active = id === activeId;
        return (
          <div
            key={id}
            ref={active ? activeTab : undefined}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => openChat(id)}
            onDoubleClick={() => setRenaming(id)}
            onAuxClick={(e) => e.button === 1 && closeTab(id)}
            onKeyDown={(e) => {
              if (e.key === "F2") setRenaming(id);
              if (e.key === "Enter") openChat(id);
            }}
            title={`${c.title} (double-click to rename)`}
            className={`group flex h-8 min-w-[72px] max-w-[190px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-xs ${
              active ? "bg-white/[0.08] text-gray-100" : "text-gray-500 hover:bg-white/[0.04] hover:text-gray-300"
            }`}
          >
            {running[id] ? (
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" title="Working" />
            ) : c.unread ? (
              <span className="h-2 w-2 shrink-0 rounded-full bg-green-400" title="New reply" />
            ) : null}
            <InlineName
              value={c.title}
              editing={renaming === id}
              onDone={(v) => {
                if (v !== null) renameChat(id, v);
                setRenaming(null);
              }}
            />
            <button
              aria-label={`Close ${c.title}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id);
              }}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded text-gray-500 hover:bg-white/10 hover:text-gray-100 ${active ? "" : "opacity-0 group-hover:opacity-100"}`}
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Every conversation of this project, searchable. Opening one focuses its tab or opens a new tab; it never replaces another. */
function HistoryMenu({ convs, openIds, running, onClose }: { convs: Record<string, Conv>; openIds: string[]; running: Record<string, boolean>; onClose: () => void }) {
  const { openChat, renameChat, archiveChat, deleteChat } = useChat.getState();
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const list = Object.values(convs)
    .filter((c) => (c.messages.length > 0 || openIds.includes(c.id)) && !!c.archived === archived && (!q || c.title.toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const act = "grid h-6 w-6 place-items-center rounded text-gray-500 hover:bg-white/10 hover:text-gray-100";

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Chat history"
      className="absolute inset-x-2 top-[46px] z-30 flex max-h-[70%] flex-col rounded-xl border border-white/10 bg-panel/95 shadow-2xl shadow-black/60 backdrop-blur-xl"
    >
      <div className="flex items-center gap-2 border-b border-edge p-2">
        <input autoFocus className="field !py-1" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
        <button
          className={`shrink-0 rounded-lg px-2.5 py-1 text-xs ${archived ? "bg-white/10 text-gray-100" : "text-gray-400 hover:bg-white/[0.06]"}`}
          onClick={() => setArchived((v) => !v)}
          aria-pressed={archived}
        >
          Archived
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {list.length === 0 && <p className="px-3 py-6 text-center text-xs text-gray-500">{archived ? "No archived chats." : q ? "No chats match." : "No chats yet."}</p>}
        {list.map((c) => (
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (renaming === c.id) return;
              openChat(c.id);
              onClose();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renaming !== c.id) {
                openChat(c.id);
                onClose();
              }
            }}
            className="group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-white/[0.06] focus:bg-white/[0.06]"
          >
            <span className="grid h-3 w-3 shrink-0 place-items-center">
              {running[c.id] ? <span className="h-2 w-2 animate-pulse rounded-full bg-accent" title="Working" /> : c.unread ? <span className="h-2 w-2 rounded-full bg-green-400" title="New reply" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center text-[13px] text-gray-100">
                <InlineName
                  value={c.title}
                  editing={renaming === c.id}
                  onDone={(v) => {
                    if (v !== null) renameChat(c.id, v);
                    setRenaming(null);
                  }}
                />
              </div>
              <div className="text-[11px] text-gray-500">
                {ago(c.updatedAt)}, {c.messages.length} message{c.messages.length === 1 ? "" : "s"}
                {openIds.includes(c.id) ? ", open" : ""}
              </div>
            </div>
            {confirm === c.id ? (
              <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button className="rounded bg-red-600 px-2 py-0.5 text-[11px] text-white hover:bg-red-500" onClick={() => (deleteChat(c.id), setConfirm(null))}>Delete</button>
                <button className="rounded px-2 py-0.5 text-[11px] text-gray-400 hover:bg-white/10" onClick={() => setConfirm(null)}>Cancel</button>
              </span>
            ) : (
              <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
                <button className={act} title="Rename" aria-label={`Rename ${c.title}`} onClick={() => setRenaming(c.id)}><Icon name="edit" className="h-3.5 w-3.5" /></button>
                <button className={act} title={c.archived ? "Restore" : "Archive"} aria-label={`${c.archived ? "Restore" : "Archive"} ${c.title}`} onClick={() => archiveChat(c.id, !c.archived)}><Icon name="archive" className="h-3.5 w-3.5" /></button>
                <button className={act} title="Delete" aria-label={`Delete ${c.title}`} onClick={() => setConfirm(c.id)}><Icon name="trash" className="h-3.5 w-3.5" /></button>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const EMPTY: ChatEntry[] = [];

export default function ChatPanel() {
  const { status, statusDetail, convs, openIds, activeId, running } = useChat();
  const { refreshModels, send, newChat } = useChat.getState();
  const messages = convs[activeId]?.messages ?? EMPTY;
  const busy = !!running[activeId];
  const { provider, baseUrl, apiKey } = useActiveConfig();
  const noProvider = provider.id === "none";
  const [draft, setDraft] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // re-read the model list whenever the provider, its URL or its key changes
  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, baseUrl, apiKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, activeId]);

  // each chat keeps its own unsent draft
  const drafts = useRef<Record<string, string>>({});
  const prevId = useRef(activeId);
  useEffect(() => {
    if (prevId.current !== activeId) {
      drafts.current[prevId.current] = draft;
      setDraft(drafts.current[activeId] ?? "");
      setAtts([]);
      setAttachError("");
      prevId.current = activeId;
    }
  }, [activeId, draft]);

  const submit = () => {
    if ((!draft.trim() && !atts.length) || busy || noProvider) return;
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
        setAttachError(`${f.name}: attach an image or a .txt, .lrc or .srt file.`);
      }
    }
    if (next.length) setAtts((x) => [...x, ...next]);
  };

  const iconBtn = "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100";

  return (
    <div className="relative flex h-full flex-col">
      {/* tabs, history, new chat */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-edge px-2">
        <TabStrip convs={convs} openIds={openIds} activeId={activeId} running={running} />
        <button className={`${iconBtn} ${historyOpen ? "bg-white/[0.08] text-gray-100" : ""}`} onClick={() => setHistoryOpen((v) => !v)} title="Chat history" aria-label="Chat history" aria-expanded={historyOpen}>
          <Icon name="history" className="h-4 w-4" />
        </button>
        <button className={iconBtn} onClick={newChat} title="New chat" aria-label="New chat">
          <Icon name="plus" className="h-4 w-4" />
        </button>
      </div>
      {historyOpen && <HistoryMenu convs={convs} openIds={openIds} running={running} onClose={() => setHistoryOpen(false)} />}

      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[13px]">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 pb-6 text-center">
            <div className="flex items-center gap-2.5">
              <img src="/favicon.svg" alt="Cutir" className="h-9 w-9" />
            </div>
            {noProvider ? (
              <div className="flex w-full max-w-[260px] flex-col items-center gap-3">
                <p className="text-sm text-gray-400">Choose an AI provider to use the assistant.</p>
                <button className="btn-primary rounded-lg px-4 py-2 text-xs" onClick={() => useSettings.getState().openDialog("ai")}>
                  Choose provider
                </button>
              </div>
            ) : (
              <div className="flex w-full max-w-[260px] flex-col gap-1.5">
                {["make the font bigger", "shift lines 4 to 8 by 0.5s", "use a blue-to-white gradient", "delete line 2"].map((t) => (
                  <button
                    key={t}
                    onClick={() => setDraft(t)}
                    className="rounded-lg border border-edge px-3 py-1.5 text-left text-xs text-gray-400 hover:bg-edge hover:text-gray-100"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="relative space-y-4">
          {/* the vertical rail the dots sit on */}
          {messages.length > 0 && <span className="absolute bottom-3 left-[6px] top-3 w-px bg-edge" />}
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
                  <p className="whitespace-pre-wrap break-words leading-relaxed text-red-400">{m.content}</p>
                </Row>
              );
            if (m.role === "user")
              return (
                <div key={m.id}>
                  <div className="mb-1 text-right text-[11px] leading-4 text-gray-500">{clock(m.at)}</div>
                  <div className="relative rounded-lg border border-edge bg-bg px-3 py-2">
                    {m.content && <p className="whitespace-pre-wrap break-words leading-relaxed text-gray-100">{m.content}</p>}
                    {m.attachments && (
                      <div className={`flex flex-wrap gap-1.5 ${m.content ? "mt-2" : ""}`}>
                        {m.attachments.map((a, i) => (
                          <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-gray-300">
                            {a.kind === "image" && a.data && <img src={`data:image/*;base64,${a.data}`} alt="" className="h-5 w-5 rounded-[2px] object-cover" />}
                            <span className="truncate">{a.name}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            return (
              <div key={m.id} className="space-y-4">
                {m.streaming && m.sync && (
                  <Row dot="bg-accent animate-pulse">
                    <SyncProgress />
                  </Row>
                )}
                {/* a reply that is really a tool call written as text ({..}, ```json, <tool_call>) is shown as "thinking", not as raw JSON */}
                {m.streaming && !m.sync && (!m.content || /^\s*(```|\{|\[|<tool_call>)/.test(m.content)) && (
                  <Row dot="bg-sky-400 animate-pulse">
                    <Thinking tokens={m.tokens} />
                  </Row>
                )}
                {!m.streaming && !!m.thoughtSecs && m.thoughtSecs > 0 && (
                  <Row>
                    <p className="text-gray-500">Thought for {m.thoughtSecs}s</p>
                  </Row>
                )}
                {m.content && !(m.streaming && /^\s*(```|\{|\[|<tool_call>)/.test(m.content)) && (
                  <Row time={m.streaming ? undefined : m.at}>
                    <p className="whitespace-pre-wrap break-words leading-relaxed text-gray-300">
                      {m.content}
                      {m.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-gray-400 align-middle" />}
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

      <div className="shrink-0">
        {status === "offline" && !noProvider && (
          <p className="mx-3 mb-0 mt-2 text-[11px] leading-snug text-red-400">
            {statusDetail}{" "}
            <button className="underline hover:text-red-300" onClick={() => useSettings.getState().openDialog("ai")}>Open settings</button>
          </p>
        )}
        <Composer
          draft={draft}
          setDraft={setDraft}
          atts={atts}
          setAtts={setAtts}
          attachError={attachError}
          onAddFiles={addFiles}
          onSubmit={submit}
        />
      </div>
    </div>
  );
}
