import type { Report } from "./capabilities";

/**
 * Error reporting that is opt in and local first (phase 30). Nothing is ever sent anywhere. With the switch on, errors
 * are kept in a small log in this browser, written straight away (so a crash does not lose them), and the user can
 * save a diagnostic bundle (one JSON file) to attach to a bug report. The bundle holds versions, capabilities, counts
 * and the error log with file names, paths and links removed. It never holds project content or media.
 */

export type LoggedError = { at: number; kind: "error" | "rejection" | "render" | "note"; message: string; stack?: string };
export const MAX_ERRORS = 50;

/** Remove what could identify a person or a file from an error text. */
export function scrub(text: string): string {
  return String(text)
    .replace(/(?:blob|data|file):[^\s)"']+/gi, "<url>")
    .replace(/https?:\/\/[^\s)"']+/gi, (u) => {
      try {
        return `${new URL(u).origin}/<path>`;
      } catch {
        return "<url>";
      }
    })
    .replace(/[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*/g, "<path>")
    .replace(/(^|[\s(])\/(?:[\w.@-]+\/)+[\w.@-]*/g, "$1<path>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b[\w-]+\.(?:mp4|mov|mkv|webm|wav|mp3|flac|ogg|m4a|aac|png|jpe?g|gif|srt|vtt|otio|edl|cutir)\b/gi, "<file>")
    .slice(0, 600);
}

export function addError(log: LoggedError[], e: { kind: LoggedError["kind"]; message: unknown; stack?: unknown }, at = Date.now()): LoggedError[] {
  const message = scrub(e.message instanceof Error ? e.message.message : String(e.message));
  const stack = e.stack ? scrub(String(e.stack)).split("\n").slice(0, 6).join("\n") : undefined;
  const last = log[log.length - 1];
  if (last && last.message === message && at - last.at < 1000) return log; // one bug often fires many times
  return [...log, { at, kind: e.kind, message, ...(stack ? { stack } : {}) }].slice(-MAX_ERRORS);
}

export type BundleInput = {
  app: { version: string; build?: string };
  userAgent: string;
  language?: string;
  capabilities: Report;
  env: Record<string, unknown>;
  errors: LoggedError[];
  /** Counts only: how big the project is, never what is in it. */
  project?: { timelines: number; tracks: number; clips: number; media: number; durationSeconds: number; fps: number; width: number; height: number };
  perf?: { autoQuality: boolean; scale: number };
  plugins?: { id: string; version: string }[];
  now?: number;
};

export function buildBundle(i: BundleInput) {
  return {
    cutirDiagnostics: 1,
    createdAt: new Date(i.now ?? Date.now()).toISOString(),
    note: "Made on this computer. Contains no project content, media or file names. Attach it to a bug report if you want to.",
    app: i.app,
    browser: { userAgent: i.userAgent, language: i.language },
    capabilities: i.capabilities.items.map((c) => ({ id: c.id, ok: c.ok, need: c.need })),
    env: i.env,
    project: i.project,
    perf: i.perf,
    plugins: i.plugins ?? [],
    errors: i.errors.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
  };
}
