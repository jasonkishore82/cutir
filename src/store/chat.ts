import { create } from "zustand";
import { useProject, uid, type Project } from "./project";
import { OllamaError, stripThink, type ChatMessage, type RawOllamaCall } from "../lib/ollama";
import { configProblem, listChatModels, streamChat } from "../lib/llm";
import { activeConfig, useSettings } from "./settings";
import { cancelAlignment, isAutoSyncIntent, syncOverridesFromText } from "../lib/autosync";
import { fontIntent, titleCaseFont } from "../lib/fonts";
import { beginReply, endReply, speakReplyStream, spokenSummary, stopSpeaking, turnEnded } from "../lib/voice";
import { CHAT_ONLY_PROMPT, applyCalls, buildSystemPrompt, getOllamaTools, isSmallTalk, limitDeletes, parseActionsFromText, quickAnswer, selectToolGroups, type CallResult, type RawCall } from "../lib/tools";

/** `before` and `after` only exist for the current session: they are not saved, so old cards cannot be undone. */
export type Applied = { results: CallResult[]; before?: Project; after?: Project; undone?: boolean };

export type Attachment = { name: string; kind: "image" | "text"; data: string }; // image: base64, text: file contents

export type ChatEntry = {
  id: string;
  role: "user" | "assistant" | "error" | "note";
  content: string;
  applied?: Applied;
  streaming?: boolean;
  attachments?: Attachment[];
  sync?: boolean; // reply is an auto-sync run: show the sync progress bar while streaming
  sent?: string; // what the model actually received (typed text + attached file text)
  at: number; // timestamp shown on the timeline
  thoughtSecs?: number; // how long the model took, shown as "Thought for Ns"
  /** Tokens generated so far (one per streamed chunk, corrected by the provider's count at the end). */
  tokens?: number;
};

/** One conversation. Conversations belong to a project and stay in its history until deleted. */
export type Conv = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  /** A reply finished while this conversation was not the one on screen. */
  unread?: boolean;
  messages: ChatEntry[];
};

type Status = "unknown" | "checking" | "online" | "offline";

type ChatState = {
  models: string[]; // chat-capable models only (of the active provider)
  noToolModels: string[]; // of those, the ones the provider says cannot call tools
  hiddenModels: number; // embedding-only models left out of the list
  status: Status;
  statusDetail: string;

  projectId: string | null;
  convs: Record<string, Conv>; // every conversation of the project, open or not
  openIds: string[]; // the tab strip, in order
  activeId: string;
  running: Record<string, boolean>; // conversations with a reply in progress

  setModel: (m: string) => void;
  refreshModels: () => Promise<void>;

  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  stop: () => void;
  clear: () => void;
  undoApplied: (id: string) => void;

  newChat: () => void;
  openChat: (id: string) => void;
  switchChat: (id: string) => void;
  closeTab: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  archiveChat: (id: string, on: boolean) => void;
  deleteChat: (id: string) => void;

  loadProject: (id: string | null) => void;
  saveProject: () => void;
  /** Delete the saved conversations of every project and start the open one fresh. */
  clearHistory: () => void;
};

export const NEW_TITLE = "New chat";
const HISTORY_TURNS = 8;
const MAX_CONVS = 60;
const MAX_MESSAGES = 300;
const noTools = new Set<string>(); // "provider:model" pairs that rejected the `tools` field this session
const toolKey = (provider: string, model: string) => `${provider}:${model}`;
const aborts = new Map<string, AbortController>();

/** A request clear enough to run without asking the model which tool to use. */
type DirectIntent = { call: RawCall; done: string; already: string; failHint?: string; sync?: boolean };

function directIntent(text: string): DirectIntent | null {
  if (isAutoSyncIntent(text)) {
    return {
      call: { tool: "auto_sync", args: syncOverridesFromText(text) },
      done: "Auto-sync finished. Press play to check the timing, or undo it from the card below.",
      already: "The lyrics are already synced that way.",
      sync: true,
    };
  }
  const font = fontIntent(text);
  if (font) {
    return {
      call: { tool: "set_font", args: { family: font } },
      done: `Now using ${titleCaseFont(font)}. It was downloaded from Google Fonts.`,
      already: `Already using ${titleCaseFont(font)}.`,
      failHint: "\nCheck the spelling against fonts.google.com, and that you are online.",
    };
  }
  return null;
}

const newConv = (): Conv => {
  const now = Date.now();
  return { id: uid(), title: NEW_TITLE, createdAt: now, updatedAt: now, messages: [] };
};

/* ---------- persistence: one key per project ---------- */

const chatsKey = (projectId: string) => `cutir:chats:${projectId}`;

type Saved = { openIds: string[]; activeId: string; convs: Conv[] };

/** Drop what is large or only meaningful this session (project snapshots, image data, half-streamed replies). */
function slim(m: ChatEntry): ChatEntry {
  const { applied, attachments, ...rest } = m;
  return {
    ...rest,
    streaming: false,
    attachments: attachments?.map((a) => (a.kind === "image" ? { ...a, data: "" } : a)),
    applied: applied ? { results: applied.results, undone: applied.undone } : undefined,
  };
}

function readSaved(projectId: string): Saved | null {
  try {
    const raw = localStorage.getItem(chatsKey(projectId));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export const useChat = create<ChatState>((set, get) => {
  const first = newConv();

  const patchConv = (cid: string, fn: (c: Conv) => Conv) =>
    set((s) => (s.convs[cid] ? { convs: { ...s.convs, [cid]: fn(s.convs[cid]) } } : s));
  const patchMsg = (cid: string, id: string, patch: Partial<ChatEntry>) =>
    patchConv(cid, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const push = (cid: string, m: Omit<ChatEntry, "id" | "at">) => {
    const entry: ChatEntry = { ...m, id: uid(), at: Date.now() };
    patchConv(cid, (c) => ({ ...c, messages: [...c.messages, entry], updatedAt: entry.at }));
    return entry.id;
  };
  const dropMsg = (cid: string, id: string) => patchConv(cid, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== id) }));
  const setRunning = (cid: string, on: boolean) => set((s) => ({ running: { ...s.running, [cid]: on } }));
  const titleFrom = (cid: string, text: string) =>
    patchConv(cid, (c) => (c.title === NEW_TITLE ? { ...c, title: text.trim().slice(0, 40) || NEW_TITLE } : c));
  /** A reply finished: flag it if the person is looking at another conversation. */
  const finish = (cid: string) => {
    if (get().activeId !== cid) patchConv(cid, (c) => ({ ...c, unread: true }));
  };

  const historyFor = (cid: string): ChatMessage[] => {
    const turns = (get().convs[cid]?.messages ?? [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.streaming)
      .slice(-HISTORY_TURNS);
    let lastUser = -1;
    turns.forEach((m, i) => m.role === "user" && (lastUser = i));
    return turns.map((m, i) => {
      // Keep past assistant turns plain. A label like "(applied: set_background)" gets imitated by small models,
      // which then answer with the label as text instead of calling the tool. The current state is in the system prompt anyway.
      const content = m.role === "user" ? m.sent ?? m.content : m.content || (m.applied ? "Done." : "OK.");
      const msg: ChatMessage = { role: m.role as "user" | "assistant", content: content || "OK." };
      // images are only re-sent with the latest user message (they are large)
      const imgs = i === lastUser ? m.attachments?.filter((a) => a.kind === "image" && a.data).map((a) => a.data) : undefined;
      if (imgs?.length) msg.images = imgs;
      return msg;
    });
  };

  /** One streaming request. Returns the raw text and any structured tool calls. */
  const runOnce = async (cid: string, text: string, replyId: string, mode: "tools" | "json" | "chat", signal: AbortSignal) => {
    const cfg = activeConfig();
    const groups = selectToolGroups(text, useProject.getState().project); // only offer the tools that could matter
    const messages: ChatMessage[] = [
      { role: "system", content: mode === "chat" ? CHAT_ONLY_PROMPT : buildSystemPrompt(useProject.getState().project, mode === "json", groups) },
      ...historyFor(cid), // already includes the new user message at the end
    ];

    let content = "";
    const rawCalls: RawOllamaCall[] = [];
    let tokens = 0;
    for await (const chunk of streamChat(cfg, { messages, tools: mode === "tools" ? getOllamaTools(groups) : undefined, signal })) {
      if (chunk.content || chunk.thinking || chunk.toolCalls) tokens = chunk.evalCount ?? tokens + 1;
      else if (chunk.evalCount) tokens = chunk.evalCount;
      patchMsg(cid, replyId, { tokens });
      if (chunk.content) {
        content += chunk.content;
        const clean = stripThink(content);
        patchMsg(cid, replyId, { content: clean });
        speakReplyStream(clean); // sentences are spoken as they complete, while the model is still writing
      }
      if (chunk.toolCalls) rawCalls.push(...chunk.toolCalls);
    }
    return { content, rawCalls };
  };

  return {
    models: [],
    noToolModels: [],
    hiddenModels: 0,
    status: "unknown",
    statusDetail: "",

    projectId: null,
    convs: { [first.id]: first },
    openIds: [first.id],
    activeId: first.id,
    running: {},

    setModel: (m) => useSettings.getState().setModel(m),

    refreshModels: async () => {
      const cfg = activeConfig();
      if (cfg.provider.id === "none") {
        set({ status: "unknown", statusDetail: "", models: [], noToolModels: [], hiddenModels: 0 });
        return;
      }
      const problem = configProblem(cfg);
      if (problem) {
        set({ status: "offline", statusDetail: problem, models: [], noToolModels: [], hiddenModels: 0 });
        return;
      }
      set({ status: "checking", statusDetail: "" });
      try {
        const { models, noToolModels, hidden } = await listChatModels(cfg);
        // the active provider may have changed while the request was running
        if (activeConfig().provider.id !== cfg.provider.id) return;
        noToolModels.forEach((m) => noTools.add(toolKey(cfg.provider.id, m))); // skip the failed first request: go straight to JSON replies
        const hasTools = (m: string) => !noToolModels.includes(m);
        const cur = cfg.model;
        let model = cur;
        if (cfg.provider.kind === "ollama") {
          model = models.includes(cur) ? cur : models.find((m) => /qwen3/i.test(m) && hasTools(m)) ?? models.find(hasTools) ?? models[0] ?? "";
        } else if (!cur) {
          // cloud lists can be hundreds long: start from the provider's suggested model
          const pick = cfg.provider.defaultModel;
          model = pick && models.includes(pick) ? pick : models[0] ?? "";
        }
        if (model !== cur) useSettings.getState().setModel(model);
        set({
          models,
          noToolModels,
          hiddenModels: hidden,
          status: "online",
          statusDetail: models.length ? `${models.length} models` : cfg.provider.kind === "ollama" ? "No chat models installed. Run: ollama pull qwen3:8b" : "The provider listed no chat models. Type a model name in Settings.",
        });
      } catch (e) {
        set({ status: "offline", models: [], noToolModels: [], statusDetail: e instanceof OllamaError ? e.message : (e as Error).message });
      }
    },

    send: async (raw, attachments = []) => {
      const cid = get().activeId;
      const text = raw.trim();
      if ((!text && !attachments.length) || get().running[cid]) return;

      // Clear requests ("auto sync", "use Roboto font") run directly: no model round trip, so a small model
      // cannot get them wrong, and they work even before a model is picked.
      // simple counting questions are answered from the project itself: always right, no model needed
      const quick = !attachments.length ? quickAnswer(text, useProject.getState().project) : null;
      if (quick) {
        push(cid, { role: "user", content: text, sent: text });
        titleFrom(cid, text);
        push(cid, { role: "assistant", content: quick });
        beginReply();
        endReply(quick);
        turnEnded();
        finish(cid);
        return;
      }

      const direct = !attachments.length ? directIntent(text) : null;
      if (direct) {
        push(cid, { role: "user", content: text, sent: text });
        titleFrom(cid, text);
        const replyId = push(cid, { role: "assistant", content: "", streaming: true, sync: direct.sync });
        const t0 = Date.now();
        beginReply();
        setRunning(cid, true);
        try {
          const applied = await applyCalls([direct.call]);
          const r = applied.results[0];
          if (r.ok && !r.noop) {
            patchMsg(cid, replyId, { content: direct.done, applied, streaming: false, thoughtSecs: Math.round((Date.now() - t0) / 1000) });
            endReply(spokenSummary(applied.results));
          } else if (r.ok) {
            patchMsg(cid, replyId, { content: direct.already, streaming: false });
            endReply(direct.already);
          } else {
            dropMsg(cid, replyId);
            const why = r.summary.replace(/^\w+: /, "");
            push(cid, { role: "error", content: `${why}${direct.failHint ?? ""}` });
            endReply(`That didn't work. ${why}`);
          }
        } finally {
          setRunning(cid, false);
          finish(cid);
          turnEnded();
        }
        return;
      }

      const cfg = activeConfig();
      const problem = configProblem(cfg);
      if (problem) {
        push(cid, { role: "error", content: problem });
        return;
      }
      if (!cfg.model) {
        push(cid, {
          role: "error",
          content: get().status === "online" ? "Pick a model first." + (cfg.provider.kind === "ollama" ? " Run `ollama pull qwen3:8b` if none are installed." : "") : get().statusDetail || `Not connected to ${cfg.provider.name}.`,
        });
        return;
      }

      const files = attachments.filter((a) => a.kind === "text").map((a) => `

[Attached file: ${a.name}]
\`\`\`
${a.data}
\`\`\``).join("");
      const sent = (text || "See the attached file.") + files;
      push(cid, { role: "user", content: text, attachments: attachments.length ? attachments : undefined, sent });
      titleFrom(cid, text || attachments[0].name);
      const replyId = push(cid, { role: "assistant", content: "", streaming: true });
      const ac = new AbortController();
      aborts.set(cid, ac);
      const t0 = Date.now();
      const took = () => Math.round((Date.now() - t0) / 1000);
      beginReply(); // silence anything still being read out from the previous reply
      setRunning(cid, true);

      try {
        const model = cfg.model;
        const tk = toolKey(cfg.provider.id, model);
        const chatOnly = isSmallTalk(text) && !attachments.length; // greetings: plain reply, never edits
        let out: { content: string; rawCalls: RawOllamaCall[] };
        try {
          out = await runOnce(cid, text, replyId, chatOnly ? "chat" : noTools.has(tk) ? "json" : "tools", ac.signal);
        } catch (e) {
          if (e instanceof OllamaError && e.kind === "no-tools") {
            noTools.add(tk);
            patchMsg(cid, replyId, { content: "" });
            push(cid, { role: "note", content: `${model} has no tool support, using JSON replies instead.` });
            out = await runOnce(cid, text, replyId, "json", ac.signal);
          } else throw e;
        }

        let calls: RawCall[] = chatOnly ? [] : out.rawCalls
          .filter((c) => c.function?.name)
          .map((c) => ({ tool: c.function!.name!, args: c.function!.arguments ?? {} }));

        let shown = stripThink(out.content);
        // older chats may contain "(applied: ...)" labels that a model copies back as its reply; never show them
        const leaked = /\(applied:[^)]*\)/i.test(shown);
        shown = shown.replace(/\(applied:[^)]*\)/gi, "").trim();
        if (!calls.length && !chatOnly) {
          // fallback: ```json {actions:[...]} ``` in the text (also catches tool-capable models that answer in text)
          const parsed = parseActionsFromText(shown);
          calls = parsed.calls;
          if (calls.length) shown = parsed.stripped;
        }

        // a model must not delete lines the user did not name
        const guard = limitDeletes(text, calls);
        calls = guard.calls;
        if (calls.length || guard.skipped.length) {
          const applied = await applyCalls(calls);
          applied.results.push(...guard.skipped);
          const changed = applied.results.some((r) => r.ok && !r.noop);
          const failed = applied.results.some((r) => !r.ok);
          if (changed || failed) {
            patchMsg(cid, replyId, { content: shown, applied, streaming: false, thoughtSecs: took() });
            endReply(spokenSummary(applied.results));
          } else {
            // every call was a no-op: just talk, don't show an "Applied changes" card
            const msg = shown || "That's already how it is, so nothing changed.";
            patchMsg(cid, replyId, { content: msg, streaming: false, thoughtSecs: took() });
            endReply(msg);
          }
        } else {
          const msg =
            shown ||
            (leaked
              ? "I couldn't turn that into an edit. Try being more specific, for example: \"make the background a violet, pink and green gradient\"."
              : "(no reply)");
          patchMsg(cid, replyId, { content: msg, streaming: false, thoughtSecs: took() });
          endReply(msg);
        }
      } catch (e) {
        const aborted = (e as Error).name === "AbortError";
        const msg = aborted ? "Stopped." : e instanceof OllamaError ? e.message : `Request failed: ${(e as Error).message}`;
        if (e instanceof OllamaError && e.kind === "connection") set({ status: "offline", statusDetail: e.message });
        const reply = get().convs[cid]?.messages.find((m) => m.id === replyId);
        if (reply && !reply.content && !reply.applied) dropMsg(cid, replyId);
        patchMsg(cid, replyId, { streaming: false });
        push(cid, { role: aborted ? "note" : "error", content: msg });
      } finally {
        aborts.delete(cid);
        setRunning(cid, false);
        finish(cid);
        turnEnded(); // hands-free mode: listen again once the reply has been spoken
      }
    },

    stop: () => {
      aborts.get(get().activeId)?.abort();
      cancelAlignment();
      stopSpeaking();
    },
    clear: () => patchConv(get().activeId, (c) => ({ ...c, messages: [], title: NEW_TITLE })),

    undoApplied: (id) => {
      const cid = get().activeId;
      const m = get().convs[cid]?.messages.find((x) => x.id === id);
      if (!m?.applied?.after || m.applied.undone) return;
      // Only safe to undo when nothing was edited since this reply was applied.
      if (useProject.getState().project !== m.applied.after) return;
      useProject.getState().undo();
      patchMsg(cid, id, { applied: { ...m.applied, undone: true } });
    },

    /* ---------- tabs and history ---------- */

    newChat: () => {
      const s = get();
      // reuse the current tab while it is still empty
      if (!s.convs[s.activeId]?.messages.length && s.openIds.includes(s.activeId)) return;
      const c = newConv();
      set({ convs: { ...s.convs, [c.id]: c }, openIds: [...s.openIds, c.id], activeId: c.id });
    },
    /** Focus the conversation's tab, opening a new tab for it if it is only in history. Never replaces another tab. */
    openChat: (id) => {
      const s = get();
      if (!s.convs[id]) return;
      set({
        openIds: s.openIds.includes(id) ? s.openIds : [...s.openIds, id],
        activeId: id,
        convs: { ...s.convs, [id]: { ...s.convs[id], unread: false } },
      });
    },
    switchChat: (id) => get().openChat(id),
    /** Closing a tab keeps the conversation in history. */
    closeTab: (id) => {
      const s = get();
      if (!s.openIds.includes(id)) return;
      const rest = s.openIds.filter((x) => x !== id);
      if (!rest.length) {
        const c = newConv();
        set({ convs: { ...s.convs, [c.id]: c }, openIds: [c.id], activeId: c.id });
        return;
      }
      const i = s.openIds.indexOf(id);
      set({ openIds: rest, activeId: id === s.activeId ? rest[Math.min(i, rest.length - 1)] : s.activeId });
    },
    renameChat: (id, title) => {
      const t = title.trim();
      if (t) patchConv(id, (c) => ({ ...c, title: t.slice(0, 60) }));
    },
    archiveChat: (id, on) => {
      patchConv(id, (c) => ({ ...c, archived: on }));
      if (on) get().closeTab(id);
    },
    deleteChat: (id) => {
      aborts.get(id)?.abort();
      get().closeTab(id);
      set((s) => {
        const { [id]: _gone, ...convs } = s.convs;
        void _gone;
        return { convs };
      });
    },

    /* ---------- per-project history ---------- */

    saveProject: () => {
      const s = get();
      if (!s.projectId) return;
      const convs = Object.values(s.convs)
        .filter((c) => c.messages.length > 0 || s.openIds.includes(c.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CONVS)
        .map((c) => ({ ...c, unread: undefined, messages: c.messages.filter((m) => !m.streaming || m.content).slice(-MAX_MESSAGES).map(slim) }));
      const ids = new Set(convs.map((c) => c.id));
      const saved: Saved = { openIds: s.openIds.filter((id) => ids.has(id)), activeId: s.activeId, convs };
      try {
        localStorage.setItem(chatsKey(s.projectId), JSON.stringify(saved));
      } catch {
        /* storage full or blocked: history stays in memory only */
      }
    },

    clearHistory: () => {
      aborts.forEach((a) => a.abort());
      aborts.clear();
      try {
        Object.keys(localStorage).filter((k) => k.startsWith("cutir:chats:")).forEach((k) => localStorage.removeItem(k));
      } catch {
        /* storage unavailable */
      }
      const c = newConv();
      set({ convs: { [c.id]: c }, openIds: [c.id], activeId: c.id, running: {} });
    },

    loadProject: (id) => {
      get().saveProject();
      aborts.forEach((a) => a.abort());
      aborts.clear();
      const saved = id ? readSaved(id) : null;
      const list = saved?.convs?.length ? saved.convs : [newConv()];
      const convs = Object.fromEntries(list.map((c) => [c.id, c]));
      let openIds = (saved?.openIds ?? []).filter((x) => convs[x]);
      if (!openIds.length) openIds = [list[0].id];
      const activeId = saved && convs[saved.activeId] && openIds.includes(saved.activeId) ? saved.activeId : openIds[0];
      set({ projectId: id, convs, openIds, activeId, running: {} });
    },
  };
});

// save shortly after the conversation list changes
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useChat.subscribe((s, prev) => {
  if (!s.projectId) return;
  if (s.convs === prev.convs && s.openIds === prev.openIds && s.activeId === prev.activeId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => useChat.getState().saveProject(), 600);
});
