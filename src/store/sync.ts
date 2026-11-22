import { create } from "zustand";
import { useProject } from "./project";
import { useLibrary } from "./library";
import { useVersions } from "./versions";
import { httpBackend, newSession, syncOnce, type ReviewComment, type Session, type SyncBackend } from "../lib/sync/backend";
import { applyPatches, type Patch } from "../model/ops";
import { describeDiff, diffDocs, restoreDoc, snapshotOf } from "../lib/versions";
import type { ProjectDoc } from "../model/types";

/**
 * Optional sync and review (phase 29). Nothing here runs until a server address and token are saved and the user presses
 * a button; with no backend set the app behaves exactly as before. Sessions live in memory: after a reload the project is
 * reconnected by taking the server's version (the state before that is kept as a version).
 */

const KEY = "cutir:sync";
const clean = (d: ProjectDoc): ProjectDoc => ({ ...d, media: d.media.map(({ url: _u, ...m }) => m) });

const read = (): { url: string; token: string } => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { url: typeof v.url === "string" ? v.url : "", token: typeof v.token === "string" ? v.token : "" };
  } catch {
    return { url: "", token: "" };
  }
};

type State = {
  url: string;
  token: string;
  session: Session | null;
  busy: boolean;
  status: string;
  /** Edits that could not be merged on the last sync. */
  conflicts: string[];
  comments: ReviewComment[];
  reviewUrl: string;
  configure: (url: string, token: string) => void;
  disconnect: () => void;
  /** Send this project to an empty server project. */
  upload: () => Promise<void>;
  /** Take the server's version of this project. */
  download: () => Promise<void>;
  syncNow: () => Promise<void>;
  refreshComments: () => Promise<void>;
  addComment: (text: string, author: string, time: number) => Promise<void>;
  resolve: (id: string, resolved: boolean) => Promise<void>;
  createReview: (changesSince?: string) => Promise<void>;
};

const backendOf = (s: { url: string; token: string }): SyncBackend | null => (s.url && s.token ? httpBackend(s.url, s.token) : null);
const pidOf = () => useLibrary.getState().currentId;
const live = () => useProject.getState().doc;
const withUrls = (doc: ProjectDoc, from: ProjectDoc): ProjectDoc => {
  const urls = new Map(from.media.map((m) => [m.id, m.url]));
  return { ...doc, media: doc.media.map((m) => (urls.get(m.id) ? { ...m, url: urls.get(m.id) } : m)) };
};

/** Replay a server log from nothing: the first entry sets the whole document. */
async function replay(be: SyncBackend, pid: string): Promise<{ doc: ProjectDoc; head: number } | null> {
  const { entries, head } = await be.pull(pid, 0);
  if (!entries.length) return null;
  let doc: unknown = undefined;
  for (const e of entries) doc = applyPatches(doc, e.patches as Patch[]);
  return { doc: doc as ProjectDoc, head };
}

export const useSync = create<State>((set, get) => {
  const run = async (what: string, fn: (be: SyncBackend, pid: string) => Promise<void>) => {
    const be = backendOf(get());
    const pid = pidOf();
    if (!be || !pid) return set({ status: "Open a project and save the server address and token first." });
    set({ busy: true, status: `${what}...` });
    try {
      await fn(be, pid);
    } catch (e) {
      set({ status: (e as Error).message || "The sync server could not be reached." });
    } finally {
      set({ busy: false });
    }
  };

  return {
    ...read(),
    session: null,
    busy: false,
    status: "",
    conflicts: [],
    comments: [],
    reviewUrl: "",

    configure: (url, token) => {
      const u = url.trim().replace(/\/+$/, "");
      try {
        localStorage.setItem(KEY, JSON.stringify({ url: u, token: token.trim() }));
      } catch {
        /* ignore */
      }
      set({ url: u, token: token.trim(), session: null, status: u ? "Saved." : "Sync is off." });
    },
    disconnect: () => {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
      set({ url: "", token: "", session: null, comments: [], reviewUrl: "", conflicts: [], status: "Sync is off. Nothing was removed from the server." });
    },

    upload: () =>
      run("Uploading", async (be, pid) => {
        const { head } = await be.pull(pid, 0);
        if (head > 0) return set({ status: "The server already has this project. Use Take the server version, or Sync now if you are already connected." });
        const doc = clean(live());
        const s = newSession(be, pid, doc, undefined);
        const r = await be.push(pid, { client: s.client, at: Date.now(), baseSeq: 0, patches: [{ op: "set", path: [], value: doc }] });
        s.lastSeq = r.seq;
        set({ session: s, status: "Uploaded. Other computers can now take this version and sync." });
      }),

    download: () =>
      run("Fetching", async (be, pid) => {
        const got = await replay(be, pid);
        if (!got) return set({ status: "The server has nothing for this project yet. Upload it first." });
        await useVersions.getState().take("action", { label: "Before taking the server version" });
        const doc = withUrls(restoreDoc(snapshotOf(got.doc, "restore"), live()), live());
        useProject.getState().editDoc(() => doc);
        const s = newSession(be, pid, clean(doc), undefined);
        s.lastSeq = got.head;
        set({ session: s, status: `Took the server version (${got.head} change${got.head === 1 ? "" : "s"}).` });
      }),

    syncNow: () =>
      run("Syncing", async (_be, pid) => {
        const s = get().session;
        if (!s || s.projectId !== pid) return set({ status: "Not connected to this project yet. Upload it, or take the server version." });
        const before = live();
        const r = await syncOnce(s, clean(before));
        const next = withUrls(r.doc as ProjectDoc, before);
        if (r.pulled) {
          await useVersions.getState().take("action", { label: "Before changes from the server were merged" });
          useProject.getState().editDoc(() => next);
        }
        const notes = describeDiff(diffDocs(clean(before), clean(next)));
        set({
          conflicts: r.conflicts.map((c) => (c.reason === "deleted-by-other" ? "Skipped one of your edits: someone else deleted what it changed." : "You and someone else changed the same value; yours was kept.")),
          status: r.pulled ? `Got ${r.pulled} change${r.pulled === 1 ? "" : "s"} from others${notes.length ? ` (${notes[0]})` : ""}; sent ${r.pushed}.` : r.pushed ? `Sent ${r.pushed} change${r.pushed === 1 ? "" : "s"}.` : "Already up to date.",
        });
      }),

    refreshComments: () =>
      run("Loading comments", async (be, pid) => {
        set({ comments: await be.comments(pid), status: "" });
      }),

    addComment: (text, author, time) =>
      run("Adding comment", async (be, pid) => {
        await be.addComment(pid, { text, author: author || "Me", time });
        set({ comments: await be.comments(pid), status: "" });
      }),

    resolve: (id, resolved) =>
      run("Saving", async (be, pid) => {
        await be.resolveComment(pid, id, resolved, "Me");
        set({ comments: await be.comments(pid), status: "" });
      }),

    createReview: (name) =>
      run("Creating the link", async (be, pid) => {
        const entry = useLibrary.getState().entries.find((e) => e.id === pid);
        const versions = useVersions.getState().list;
        // what changed since the newest named version, as the reviewer's changes list
        const ref = [...versions].reverse().find((v) => v.name);
        const changes = ref ? describeDiff(diffDocs(restoreDoc(ref, live()), live())) : [];
        const link = await be.createReview(pid, { name: name || entry?.name || "Review", changes });
        set({ reviewUrl: link.url, status: "Review link created. Anyone who has it can read the changes list and comment." });
      }),
  };
});
