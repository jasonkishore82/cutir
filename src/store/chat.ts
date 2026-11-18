import { create } from "zustand";
import { useProject, uid, type Project } from "./project";
import {
  DEFAULT_OLLAMA_URL,
  OllamaError,
  listModelInfo,
  normalizeUrl,
  streamChat,
  stripThink,
  type ChatMessage,
  type RawOllamaCall,
} from "../lib/ollama";
import { cancelAlignment, isAutoSyncIntent, syncOverridesFromText } from "../lib/autosync";
import { fontIntent, titleCaseFont } from "../lib/fonts";
import { beginReply, endReply, speakReplyStream, spokenSummary, stopSpeaking, turnEnded } from "../lib/voice";
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
  baseUrl: string;
  model: string;
  models: string[]; // chat-capable models only
  noToolModels: string[]; // of those, the ones Ollama says cannot call tools
  hiddenModels: number; // embedding-only models left out of the list
  status: Status;
  statusDetail: string;
  messages: ChatEntry[]; // messages of the active chat
  chats: { id: string; title: string }[]; // tab strip
  activeId: string;
  byId: Record<string, ChatEntry[]>; // messages of the inactive chats
  busy: boolean;

  setBaseUrl: (u: string) => void;
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

const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

const HISTORY_TURNS = 8;
const noTools = new Set<string>(); // models that rejected the `tools` field this session

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
      // Keep past assistant turns plain. A label like "(applied: set_background)" gets imitated by small models,
      // which then answer with the label as text instead of calling the tool. The current state is in the system prompt anyway.
      const content = m.role === "user" ? m.sent ?? m.content : m.content || (m.applied ? "Done." : "OK.");
      const msg: ChatMessage = { role: m.role as "user" | "assistant", content: content || "OK." };
      // images are only re-sent with the latest user message (they are large)
      const imgs = i === lastUser ? m.attachments?.filter((a) => a.kind === "image").map((a) => a.data) : undefined;
      if (imgs?.length) msg.images = imgs;
      return msg;
    });
  };

  /** One streaming request. Returns the raw text and any structured tool calls. */
  const runOnce = async (text: string, replyId: string, mode: "tools" | "json" | "chat", signal: AbortSignal) => {
    const { baseUrl, model } = get();
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
    for await (const chunk of streamChat({ baseUrl, model, messages, tools: mode === "tools" ? getOllamaTools(groups) : undefined, signal })) {
      if (chunk.content || chunk.thinking || chunk.toolCalls) tokens = chunk.evalCount ?? tokens + 1;
      else if (chunk.evalCount) tokens = chunk.evalCount;
      patchMsg(replyId, { tokens });
      if (chunk.content) {
        content += chunk.content;
        const clean = stripThink(content);
        patchMsg(replyId, { content: clean });
        speakReplyStream(clean); // sentences are spoken as they complete, while the model is still writing
      }
      if (chunk.toolCalls) rawCalls.push(...chunk.toolCalls);
    }
    return { content, rawCalls };
  };

  return {
    baseUrl: normalizeUrl(read("cutir:ollamaUrl", DEFAULT_OLLAMA_URL)),
    model: read("cutir:ollamaModel", ""),
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

    setBaseUrl: (u) => {
      write("cutir:ollamaUrl", u);
      set({ baseUrl: u });
    },
    setModel: (m) => {
      write("cutir:ollamaModel", m);
      set({ model: m });
    },

    refreshModels: async () => {
      set({ status: "checking", statusDetail: "" });
      try {
        const infos = await listModelInfo(get().baseUrl);
        // embedding-only models cannot chat; without capability info fall back to their names
        const chatCapable = infos.filter((i) => (i.capabilities ? i.capabilities.includes("completion") : !/embed|bge-|nomic/i.test(i.name)));
        const models = chatCapable.map((i) => i.name);
        const noToolModels = chatCapable.filter((i) => i.capabilities && !i.capabilities.includes("tools")).map((i) => i.name);
        noToolModels.forEach((m) => noTools.add(m)); // skip the failed first request: go straight to JSON replies
        const hasTools = (m: string) => !noToolModels.includes(m);
        const cur = get().model;
        const model = models.includes(cur) ? cur : models.find((m) => /qwen3/i.test(m) && hasTools(m)) ?? models.find(hasTools) ?? models[0] ?? "";
        if (model !== cur) write("cutir:ollamaModel", model);
        set({
          models,
          noToolModels,
          hiddenModels: infos.length - models.length,
          model,
          status: "online",
          statusDetail: models.length ? `${models.length} models` : "No chat models installed. Run: ollama pull qwen3:8b",
        });
      } catch (e) {
        set({ status: "offline", models: [], statusDetail: e instanceof OllamaError ? e.message : (e as Error).message });
      }
    },

    send: async (raw, attachments = []) => {
      const text = raw.trim();
      if ((!text && !attachments.length) || get().busy) return;

      // Clear requests ("auto sync", "use Roboto font") run directly: no model round trip, so a small model
      // cannot get them wrong, and they work even before a model is picked.
      const direct = !attachments.length ? directIntent(text) : null;
      if (direct) {
        push({ role: "user", content: text, sent: text });
        set((s) => ({
          chats: s.chats.map((c) => (c.id === s.activeId && c.title === NEW_TITLE ? { ...c, title: text.length > 26 ? text.slice(0, 26) + "…" : text } : c)),
        }));
        const replyId = push({ role: "assistant", content: "", streaming: true, sync: direct.sync });
        const t0 = Date.now();
        beginReply();
        set({ busy: true });
        try {
          const applied = await applyCalls([direct.call]);
          const r = applied.results[0];
          if (r.ok && !r.noop) {
            patchMsg(replyId, { content: direct.done, applied, streaming: false, thoughtSecs: Math.round((Date.now() - t0) / 1000) });
            endReply(spokenSummary(applied.results));
          } else if (r.ok) {
            patchMsg(replyId, { content: direct.already, streaming: false });
            endReply(direct.already);
          } else {
            set((s) => ({ messages: s.messages.filter((m) => m.id !== replyId) }));
            const why = r.summary.replace(/^\w+: /, "");
            push({ role: "error", content: `${why}${direct.failHint ?? ""}` });
            endReply(`That didn't work. ${why}`);
          }
        } finally {
          set({ busy: false });
          turnEnded();
        }
        return;
      }

      if (!get().model) {
        push({ role: "error", content: get().status === "online" ? "Pick a model first (run `ollama pull qwen3:8b` if none are installed)." : "Not connected to Ollama. Start Ollama with OLLAMA_ORIGINS=* (or your dev URL) so the browser can reach it." });
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
        chats: s.chats.map((c) => (c.id === s.activeId && c.title === NEW_TITLE ? { ...c, title: title.length > 26 ? title.slice(0, 26) + "…" : title } : c)),
      }));
      const replyId = push({ role: "assistant", content: "", streaming: true });
      abort = new AbortController();
      const t0 = Date.now();
      const took = () => Math.round((Date.now() - t0) / 1000);
      beginReply(); // silence anything still being read out from the previous reply
      set({ busy: true });

      try {
        const model = get().model;
        const chatOnly = isSmallTalk(text) && !attachments.length; // greetings: plain reply, never edits
        let out: { content: string; rawCalls: RawOllamaCall[] };
        try {
          out = await runOnce(text, replyId, chatOnly ? "chat" : noTools.has(model) ? "json" : "tools", abort.signal);
        } catch (e) {
          if (e instanceof OllamaError && e.kind === "no-tools") {
            noTools.add(model);
            patchMsg(replyId, { content: "" });
            push({ role: "note", content: `${model} has no tool support, using JSON replies instead.` });
            out = await runOnce(text, replyId, "json", abort.signal);
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

        if (calls.length) {
          const applied = await applyCalls(calls);
          const changed = applied.results.some((r) => r.ok && !r.noop);
          const failed = applied.results.some((r) => !r.ok);
          if (changed || failed) {
            patchMsg(replyId, { content: shown, applied, streaming: false, thoughtSecs: took() });
            endReply(spokenSummary(applied.results));
          } else {
            // every call was a no-op: just talk, don't show an "Applied changes" card
            const msg = shown || "That's already how it is, so nothing changed.";
            patchMsg(replyId, { content: msg, streaming: false, thoughtSecs: took() });
            endReply(msg);
          }
        } else {
          const msg =
            shown ||
            (leaked
              ? "I couldn't turn that into an edit. Try being more specific, for example: \"make the background a violet, pink and green gradient\"."
              : "(no reply)");
          patchMsg(replyId, { content: msg, streaming: false, thoughtSecs: took() });
          endReply(msg);
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
        turnEnded(); // hands-free mode: listen again once the reply has been spoken
      }
    },

    stop: () => {
      abort?.abort();
      cancelAlignment();
      stopSpeaking();
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
