import { diff, type Patch } from "../../model/ops";
import { rebase, type Conflict } from "./merge";

/**
 * Sync and review (phase 29). The app talks to a SyncBackend and knows nothing else about servers. With no backend set
 * (the default) none of this runs and nothing about the app changes. `httpBackend` speaks to the reference service in
 * sync-server/; `memoryBackend` is the same thing in memory, for tests and for trying a second client.
 */

export type OpEntry = {
  /** Position in the server's log; set by the server. */
  seq?: number;
  /** The log position these patches were made on top of. The server refuses a push whose base is not the head. */
  baseSeq: number;
  client: string;
  at: number;
  patches: Patch[];
  label?: string;
};

export type ReviewComment = {
  id: string;
  /** Where in the timeline the comment is pinned, in seconds. */
  time: number;
  author: string;
  text: string;
  at: number;
  resolved: boolean;
  /** Who and when closed it. */
  resolvedBy?: string;
};

export type ReviewLink = { token: string; url: string };

/** Thrown by push when someone else pushed first; pull again and retry. */
export class StaleError extends Error {
  constructor() {
    super("stale");
  }
}

export interface SyncBackend {
  readonly label: string;
  push(projectId: string, entry: OpEntry): Promise<{ seq: number }>;
  /** Entries with a seq above `since`, oldest first. */
  pull(projectId: string, since: number): Promise<{ entries: OpEntry[]; head: number }>;
  comments(projectId: string): Promise<ReviewComment[]>;
  addComment(projectId: string, c: Pick<ReviewComment, "time" | "text" | "author">): Promise<ReviewComment>;
  resolveComment(projectId: string, id: string, resolved: boolean, by: string): Promise<void>;
  createReview(projectId: string, info: { name: string; changes: string[] }): Promise<ReviewLink>;
}

/* ---------- a client session: pull, rebase our changes on top, push ---------- */

export type Session = {
  backend: SyncBackend;
  projectId: string;
  client: string;
  /** The document as of the last sync; our changes are the difference from it. */
  base: unknown;
  lastSeq: number;
};

export const newSession = (backend: SyncBackend, projectId: string, base: unknown, client = `c${Math.random().toString(36).slice(2, 8)}`): Session => ({ backend, projectId, client, base, lastSeq: 0 });

export type SyncResult = {
  /** The document to show now (equals `current` when nothing came in). */
  doc: unknown;
  pulled: number;
  pushed: number;
  conflicts: Conflict[];
};

/** One round: fetch what others did, rebase our unsent changes on it, send them. Updates the session. */
export async function syncOnce(s: Session, current: unknown): Promise<SyncResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { entries, head } = await s.backend.pull(s.projectId, s.lastSeq);
    const theirs = entries.filter((e) => e.client !== s.client);
    const local = diff(s.base, current);
    let doc = current;
    let conflicts: Conflict[] = [];
    let toPush = local;
    if (theirs.length) {
      const r = rebase(s.base, theirs.flatMap((e) => e.patches), local);
      doc = r.doc;
      conflicts = r.conflicts;
      toPush = r.patches;
    }
    try {
      const seq = toPush.length ? (await s.backend.push(s.projectId, { client: s.client, at: Date.now(), baseSeq: head, patches: toPush })).seq : head;
      s.base = doc;
      s.lastSeq = seq;
      return { doc, pulled: theirs.length, pushed: toPush.length, conflicts };
    } catch (e) {
      if (!(e instanceof StaleError)) throw e;
      // someone pushed between our pull and push: the session is untouched, so pull again and merge again
    }
  }
  throw new Error("The sync server is busy; try again in a moment.");
}

/* ---------- in memory ---------- */

export function memoryBackend(): SyncBackend & { log: Map<string, OpEntry[]> } {
  const log = new Map<string, OpEntry[]>();
  const notes = new Map<string, ReviewComment[]>();
  let n = 0;
  return {
    label: "In memory",
    log,
    push: async (pid, e) => {
      const list = log.get(pid) ?? log.set(pid, []).get(pid)!;
      if (e.baseSeq !== list.length) throw new StaleError();
      const seq = list.length + 1;
      list.push({ ...e, seq });
      return { seq };
    },
    pull: async (pid, since) => {
      const list = log.get(pid) ?? [];
      return { entries: list.filter((e) => (e.seq ?? 0) > since), head: list.length };
    },
    comments: async (pid) => [...(notes.get(pid) ?? [])],
    addComment: async (pid, c) => {
      const made: ReviewComment = { id: `n${++n}`, at: Date.now(), resolved: false, ...c };
      (notes.get(pid) ?? notes.set(pid, []).get(pid)!).push(made);
      return made;
    },
    resolveComment: async (pid, id, resolved, by) => {
      const c = notes.get(pid)?.find((x) => x.id === id);
      if (c) Object.assign(c, { resolved, resolvedBy: resolved ? by : undefined });
    },
    createReview: async (pid) => ({ token: `memory-${pid}`, url: `memory://review/${pid}` }),
  };
}

/* ---------- the reference service over HTTP ---------- */

export function httpBackend(baseUrl: string, token: string, fetcher: typeof fetch = fetch): SyncBackend {
  const root = baseUrl.replace(/\/+$/, "");
  const call = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetcher(`${root}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (res.status === 409) throw new StaleError();
    if (!res.ok) throw new Error(res.status === 401 ? "The sync server did not accept the access token." : `The sync server answered ${res.status}.`);
    return (await res.json()) as T;
  };
  const p = (id: string) => `/p/${encodeURIComponent(id)}`;
  return {
    label: root,
    push: (pid, entry) => call(`${p(pid)}/ops`, { method: "POST", body: JSON.stringify(entry) }),
    pull: (pid, since) => call(`${p(pid)}/ops?since=${since}`),
    comments: async (pid) => (await call<{ comments: ReviewComment[] }>(`${p(pid)}/comments`)).comments,
    addComment: (pid, c) => call(`${p(pid)}/comments`, { method: "POST", body: JSON.stringify(c) }),
    resolveComment: async (pid, id, resolved, by) => void (await call(`${p(pid)}/comments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ resolved, by }) })),
    createReview: (pid, info) => call(`${p(pid)}/review`, { method: "POST", body: JSON.stringify(info) }),
  };
}
