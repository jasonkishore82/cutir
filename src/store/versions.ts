import { create } from "zustand";
import { useProject } from "./project";
import { useLibrary } from "./library";
import { duplicateTimeline } from "../timeline/compound";
import { fileVersionBackend, isMajorChange, prune, restoreDoc, snapshotOf, type Snapshot, type SnapshotReason, type VersionBackend } from "../lib/versions";

/** Version history of the open project (phase 29): see lib/versions.ts for the snapshots themselves. */

const EVERY_KEY = "cutir:verEvery";
export const INTERVALS = [0, 2, 5, 10, 30] as const;

const readEvery = (): number => {
  try {
    const n = Number(localStorage.getItem(EVERY_KEY));
    return (INTERVALS as readonly number[]).includes(n) ? n : 5;
  } catch {
    return 5;
  }
};

type State = {
  projectId: string | null;
  list: Snapshot[];
  /** Minutes between automatic snapshots; 0 = off. */
  every: number;
  setEvery: (m: number) => void;
  load: (projectId: string | null) => Promise<void>;
  /** Take a snapshot of the document now (or of `doc`, e.g. the state before a big change). */
  take: (reason: SnapshotReason, opts?: { name?: string; label?: string; doc?: ReturnType<typeof liveDoc> }) => Promise<Snapshot | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Replace the document with a snapshot. One undo step; the current state is saved first so nothing is lost. */
  restore: (id: string) => Promise<boolean>;
  /** Copy the active timeline as a branch to try something on. */
  branch: (name?: string) => string | null;
};

const liveDoc = () => useProject.getState().doc;
let backend: VersionBackend = fileVersionBackend();
export const setVersionBackend = (b: VersionBackend) => (backend = b);

export const useVersions = create<State>((set, get) => ({
  projectId: null,
  list: [],
  every: readEvery(),
  setEvery: (every) => {
    try {
      localStorage.setItem(EVERY_KEY, String(every));
    } catch {
      /* ignore */
    }
    set({ every });
  },
  load: async (projectId) => {
    set({ projectId, list: [] });
    if (!projectId) return;
    const list = await backend.read(projectId);
    if (get().projectId === projectId) set({ list });
  },
  take: async (reason, opts = {}) => {
    const { projectId } = get();
    if (!projectId) return null;
    const snap = snapshotOf(opts.doc ?? liveDoc(), reason, { name: opts.name, label: opts.label });
    const last = get().list[get().list.length - 1];
    if (last && last.json === snap.json && !opts.name) return last; // nothing changed since the last one
    const list = prune([...get().list, snap]);
    set({ list });
    await backend.write(projectId, list);
    return snap;
  },
  rename: async (id, name) => {
    const { projectId } = get();
    const list = get().list.map((s) => (s.id === id ? { ...s, name: name.trim() || undefined } : s));
    set({ list });
    if (projectId) await backend.write(projectId, list);
  },
  remove: async (id) => {
    const { projectId } = get();
    const list = get().list.filter((s) => s.id !== id);
    set({ list });
    if (projectId) await backend.write(projectId, list);
  },
  restore: async (id) => {
    const snap = get().list.find((s) => s.id === id);
    if (!snap) return false;
    await get().take("restore", { label: "Before restoring an older version" });
    const doc = restoreDoc(snap, liveDoc());
    useProject.getState().editDoc(() => doc);
    return true;
  },
  branch: (name) => {
    const doc = liveDoc();
    const src = doc.timelines.find((t) => t.id === doc.activeTimelineId) ?? doc.timelines[0];
    const made = duplicateTimeline(doc, src.id, name?.trim() || `${src.name} branch`);
    if (!made) return null;
    useProject.getState().editDoc(() => made.doc);
    useProject.getState().setActiveTimeline(made.timelineId);
    return made.timelineId;
  },
}));

/**
 * Watch the open project: snapshot on a timer when something changed, and keep the state from before any big change.
 * Returns a function that stops it.
 */
export function startVersioning(): () => void {
  let lastDoc = liveDoc();
  let timer: ReturnType<typeof setInterval> | undefined;
  const arm = () => {
    clearInterval(timer);
    const m = useVersions.getState().every;
    if (m > 0) {
      timer = setInterval(() => {
        const doc = liveDoc();
        if (doc === lastDoc) return;
        lastDoc = doc;
        void useVersions.getState().take("auto");
      }, m * 60_000);
    }
  };
  arm();
  const offEvery = useVersions.subscribe((s, p) => s.every !== p.every && arm());
  const offDoc = useProject.subscribe((s, p) => {
    if (s.doc === p.doc || !useVersions.getState().projectId) return;
    const why = isMajorChange(p.doc, s.doc);
    if (why && useVersions.getState().every > 0) void useVersions.getState().take("action", { label: why, doc: p.doc });
  });
  const offLib = useLibrary.subscribe((s, p) => {
    if (s.currentId !== p.currentId) {
      lastDoc = liveDoc();
      void useVersions.getState().load(s.currentId);
    }
  });
  void useVersions.getState().load(useLibrary.getState().currentId);
  return () => {
    clearInterval(timer);
    offEvery();
    offDoc();
    offLib();
  };
}
