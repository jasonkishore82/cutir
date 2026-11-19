import { create } from "zustand";
import { useProject, uid, type Project } from "./project";
import { OllamaError, stripThink, type ChatMessage, type RawOllamaCall } from "../lib/ollama";
import { configProblem, listChatModels, streamChat } from "../lib/llm";
import { activeConfig, useSettings } from "./settings";
import { cancelAlignment, isAutoSyncIntent, syncOverridesFromText } from "../lib/autosync";
import { CHAT_ONLY_PROMPT, applyCalls, buildSystemPrompt, getOllamaTools, isSmallTalk, parseActionsFromText, selectToolGroups, type CallResult, type RawCall } from "../lib/tools";

export type Applied = { results: CallResult[]; before: Project; after: Project; undone?: boolean };

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
  /** Tokens generated so far (one per streamed chunk, corrected by Ollama's eval_count at the end). */
  tokens?: number;
};

type Status = "unknown" | "checking" | "online" | "offline";

type ChatState = {
  models: string[]; // chat-capable models only (of the active provider)
  noToolModels: string[]; // of those, the ones the provider says cannot call tools
  hiddenModels: number; // embedding-only models left out of the list
  status: Status;
  statusDetail: string;
  messages: ChatEntry[]; // messages of the active chat
  chats: { id: string; title: string }[]; // tab strip
  activeId: string;
  byId: Record<string, ChatEntry[]>; // messages of the inactive chats
  busy: boolean;

  setModel: (m: string) => void;
  refreshModels: () => Promise<void>;
  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  stop: () => void;
  clear: () => void;
  newChat: () => void;
  switchChat: (id: string) => void;
  closeChat: (id: string) => void;
  resetChats: () => void;
  undoApplied: (id: string) => void;
};

const HISTORY_TURNS = 8;
const noTools = new Set<string>(); // "provider:model" pairs that rejected the `tools` field this session
const toolKey = (provider: string, model: string) => `${provider}:${model}`;
let abort: AbortController | null = null;

const NEW_TITLE = "New chat";
const firstChat = { id: uid(), title: NEW_TITLE };

export const useChat = create<ChatState>((set, get) => {
  const patchMsg = (id: string, patch: Partial<ChatEntry>) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const push = (m: Omit<ChatEntry, "id" | "at">) => {
    const entry: ChatEntry = { ...m, id: uid(), at: Date.now() };
    set((s) => ({ messages: [...s.messages, entry] }));
    return entry.id;
  };

  const historyFor = (): ChatMessage[] => {
    const turns = get()
      .messages.filter((m) => (m.role === "user" || m.role === "assistant") && !m.streaming)
      .slice(-HISTORY_TURNS);
    let lastUser = -1;
    turns.forEach((m, i) => m.role === "user" && (lastUser = i));
    return turns.map((m, i) => {
      const note = m.applied ? ` (applied: ${m.applied.results.filter((r) => r.ok).map((r) => r.tool).join(", ") || "nothing"})` : "";
      const msg: ChatMessage = { role: m.role as "user" | "assistant", content: (m.sent ?? m.content ?? "") + note || "ok" };
      // images are only re-sent with the latest user message (they are large)
      const imgs = i === lastUser ? m.attachments?.filter((a) => a.kind === "image").map((a) => a.data) : undefined;
      if (imgs?.length) msg.images = imgs;
      return msg;
    });
  };

  /** One streaming request. Returns the raw text and any structured tool calls. */
  const runOnce = async (text: string, replyId: string, mode: "tools" | "json" | "chat", signal: AbortSignal) => {
    const cfg = activeConfig();
    const groups = selectToolGroups(text, useProject.getState().project); // only offer the tools that could matter
    const messages: ChatMessage[] = [
      { role: "system", content: mode === "chat" ? CHAT_ONLY_PROMPT : buildSystemPrompt(useProject.getState().project, mode === "json", groups) },
      ...historyFor(),
    ];
    // historyFor already includes the new user message at the end
    void text;

    let content = "";
    const rawCalls: RawOllamaCall[] = [];
    let tokens = 0;
    for await (const chunk of streamChat(cfg, { messages, tools: mode === "tools" ? getOllamaTools(groups) : undefined, signal })) {
      if (chunk.content || chunk.thinking || chunk.toolCalls) tokens = chunk.evalCount ?? tokens + 1;
      else if (chunk.evalCount) tokens = chunk.evalCount;
      patchMsg(replyId, { tokens });
      if (chunk.content) {
        content += chunk.content;
        patchMsg(replyId, { content: stripThink(content) });
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
    messages: [],
    chats: [firstChat],
    activeId: firstChat.id,
    byId: {},
    busy: false,

    setModel: (m) => useSettings.getState().setModel(m),

    refreshModels: async () => {
      const cfg = activeConfig();
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
      const text = raw.trim();
      if ((!text && !attachments.length) || get().busy) return;

      // "auto sync" starts the sync directly: no model round trip, so it works even before a model is picked
      if (isAutoSyncIntent(text) && !attachments.length) {
        push({ role: "user", content: text, sent: text });
        set((s) => ({
          chats: s.chats.map((c) => (c.id === s.activeId && c.title === NEW_TITLE ? { ...c, title: text.slice(0, 26) } : c)),
        }));
        const replyId = push({ role: "assistant", content: "", streaming: true, sync: true });
        const t0 = Date.now();
        set({ busy: true });
        try {
          const applied = await applyCalls([{ tool: "auto_sync", args: syncOverridesFromText(text) }]);
          const r = applied.results[0];
          if (r.ok) {
            patchMsg(replyId, {
              content: "Auto-sync finished. Press play to check the timing, or undo it from the card below.",
              applied,
              streaming: false,
              thoughtSecs: Math.round((Date.now() - t0) / 1000),
            });
          } else {
            set((s) => ({ messages: s.messages.filter((m) => m.id !== replyId) }));
            push({ role: "error", content: r.summary.replace(/^auto_sync: /, "") });
          }
        } finally {
          set({ busy: false });
        }
        return;
      }

      const cfg = activeConfig();
      const problem = configProblem(cfg);
      if (problem) {
        push({ role: "error", content: problem });
        return;
      }
      if (!cfg.model) {
        push({
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
      push({ role: "user", content: text, attachments: attachments.length ? attachments : undefined, sent });
      const title = text || attachments[0].name;
      set((s) => ({
        chats: s.chats.map((c) => (c.id === s.activeId && c.title === NEW_TITLE ? { ...c, title: title.slice(0, 26) } : c)),
      }));
      const replyId = push({ role: "assistant", content: "", streaming: true });
      abort = new AbortController();
      const t0 = Date.now();
      const took = () => Math.round((Date.now() - t0) / 1000);
      set({ busy: true });

      try {
        const model = cfg.model;
        const tk = toolKey(cfg.provider.id, model);
        const chatOnly = isSmallTalk(text) && !attachments.length; // greetings: plain reply, never edits
        let out: { content: string; rawCalls: RawOllamaCall[] };
        try {
          out = await runOnce(text, replyId, chatOnly ? "chat" : noTools.has(tk) ? "json" : "tools", abort.signal);
        } catch (e) {
          if (e instanceof OllamaError && e.kind === "no-tools") {
            noTools.add(tk);
            patchMsg(replyId, { content: "" });
            push({ role: "note", content: `${model} has no tool support, using JSON replies instead.` });
            out = await runOnce(text, replyId, "json", abort.signal);
          } else throw e;
        }

        let calls: RawCall[] = chatOnly ? [] : out.rawCalls
          .filter((c) => c.function?.name)
          .map((c) => ({ tool: c.function!.name!, args: c.function!.arguments ?? {} }));

        let shown = stripThink(out.content);
        if (!calls.length && !chatOnly) {
          // fallback: ```json {actions:[...]} ``` in the text (also catches tool-capable models that answer in text)
          const parsed = parseActionsFromText(shown);
          calls = parsed.calls;
          if (calls.length) shown = parsed.stripped;
        }

        if (calls.length) {
          const applied = await applyCalls(calls);
          const changed = applied.results.some((r) => r.ok && !r.noop);
          const failed = applied.results.some((r) => !r.ok);
          if (changed || failed) {
            patchMsg(replyId, { content: shown, applied, streaming: false, thoughtSecs: took() });
          } else {
            // every call was a no-op: just talk, don't show an "Applied changes" card
            patchMsg(replyId, { content: shown || "That's already how it is, so nothing changed.", streaming: false, thoughtSecs: took() });
          }
        } else {
          patchMsg(replyId, { content: shown || "(no reply)", streaming: false, thoughtSecs: took() });
        }
      } catch (e) {
        const aborted = (e as Error).name === "AbortError";
        const msg = aborted ? "Stopped." : e instanceof OllamaError ? e.message : `Request failed: ${(e as Error).message}`;
        if (e instanceof OllamaError && e.kind === "connection") set({ status: "offline", statusDetail: e.message });
        set((s) => ({ messages: s.messages.filter((m) => !(m.id === replyId && !m.content && !m.applied)) }));
        patchMsg(replyId, { streaming: false });
        push({ role: aborted ? "note" : "error", content: msg });
      } finally {
        abort = null;
        set({ busy: false });
      }
    },

    stop: () => {
      abort?.abort();
      cancelAlignment();
    },
    clear: () => set({ messages: [] }),

    // Chats are switched only while idle, so a streaming reply never lands in the wrong tab.
    newChat: () => {
      const s = get();
      if (s.busy) return;
      // reuse the current tab if it is still empty
      if (!s.messages.length) return;
      const c = { id: uid(), title: NEW_TITLE };
      set({ chats: [...s.chats, c], activeId: c.id, byId: { ...s.byId, [s.activeId]: s.messages }, messages: [] });
    },
    switchChat: (id) => {
      const s = get();
      if (s.busy || id === s.activeId) return;
      set({ activeId: id, byId: { ...s.byId, [s.activeId]: s.messages }, messages: s.byId[id] ?? [] });
    },
    resetChats: () => {
      abort?.abort();
      const c = { id: uid(), title: NEW_TITLE };
      set({ chats: [c], activeId: c.id, byId: {}, messages: [], busy: false });
    },
    closeChat: (id) => {
      const s = get();
      if (s.busy) return;
      const byId = { ...s.byId, [s.activeId]: s.messages };
      delete byId[id];
      const rest = s.chats.filter((c) => c.id !== id);
      if (!rest.length) {
        const c = { id: uid(), title: NEW_TITLE };
        set({ chats: [c], activeId: c.id, byId: {}, messages: [] });
        return;
      }
      if (id !== s.activeId) {
        set({ chats: rest, byId });
        return;
      }
      const i = s.chats.findIndex((c) => c.id === id);
      const next = rest[Math.min(i, rest.length - 1)];
      set({ chats: rest, activeId: next.id, byId, messages: byId[next.id] ?? [] });
    },

    undoApplied: (id) => {
      const m = get().messages.find((x) => x.id === id);
      if (!m?.applied || m.applied.undone) return;
      // Only safe to undo when nothing was edited since this reply was applied.
      if (useProject.getState().project !== m.applied.after) return;
      useProject.getState().undo();
      patchMsg(id, { applied: { ...m.applied, undone: true } });
    },
  };
});
