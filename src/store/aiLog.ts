import { create } from "zustand";

/**
 * The request log (phase 28): every time something leaves the browser for an AI provider it is listed here, with where
 * it went and how much was sent. The text itself is never kept. Keys are never logged.
 */

export type LogEntry = {
  id: number;
  at: number;
  /** chat = assistant turn; translate and transcribe are the caption tools; helper = the local Python helper. */
  kind: "chat" | "transcribe" | "translate" | "helper";
  provider: string;
  /** Host the request went to (no path, no key). */
  host: string;
  model: string;
  /** Characters of text sent, or bytes for audio. */
  size: number;
  unit: "chars" | "bytes";
  local: boolean;
};

const KEY = "cutir:aiLog";
const MAX = 150;
let next = 1;

function load(): LogEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.at === "number" && typeof e.host === "string").slice(-MAX) : [];
  } catch {
    return [];
  }
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || "unknown";
  }
};

const isLocalHost = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|$)/.test(h);

type LogState = {
  entries: LogEntry[];
  note: (e: Omit<LogEntry, "id" | "at" | "host" | "local"> & { baseUrl: string }) => void;
  clear: () => void;
};

export const useAiLog = create<LogState>((set, get) => ({
  entries: load(),
  note: ({ baseUrl, ...e }) => {
    const host = hostOf(baseUrl);
    const entry: LogEntry = { ...e, id: next++, at: Date.now(), host, local: isLocalHost(host) };
    const entries = [...get().entries, entry].slice(-MAX);
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      /* storage unavailable */
    }
    set({ entries });
  },
  clear: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    set({ entries: [] });
  },
}));

/** Totals for the header of the log: how many requests, how many left this computer. */
export const summarize = (entries: LogEntry[]) => ({ total: entries.length, remote: entries.filter((e) => !e.local).length });

/** Whether destructive AI edits (deleting, cutting out, exporting) wait for a yes. On by default. */
const SAFE_KEY = "cutir:aiAskFirst";
export const useAiSafety = create<{ askFirst: boolean; setAskFirst: (on: boolean) => void }>((set) => ({
  askFirst: (() => {
    try {
      return localStorage.getItem(SAFE_KEY) !== "0";
    } catch {
      return true;
    }
  })(),
  setAskFirst: (on) => {
    try {
      localStorage.setItem(SAFE_KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    set({ askFirst: on });
  },
}));
