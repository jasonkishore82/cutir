import { create } from "zustand";
import { DEFAULT_STYLE, defaultProject, uid, useProject, type Aspect, type Project } from "./project";
import { docToView, viewToDoc } from "../model/convert";
import { loadDoc, serializeDoc } from "../model/migrate";
import { SCHEMA_VERSION, type ProjectDoc } from "../model/types";
import { useChat } from "./chat";
import { copyProjectMedia, deleteProjectMedia, useMedia } from "./media";
import { useSettings } from "./settings";
import { useVersions } from "./versions";
import { copyProjectFiles, deleteFile, deleteProjectFiles, loadFile, saveFile } from "../lib/assetdb";
import { makeThumbnail } from "../lib/thumbnail";
import { openPackage } from "../lib/storage/pack";
import { putFile } from "../lib/filestore";
import { checksum, chooseSource, fileRecoveryBackend, recoveryWriter } from "../lib/storage/recovery";

/**
 * The project library behind the Home screen.
 * localStorage layout:   cutir:library      -> JSON array of ProjectEntry (small, for the Home grid)
 *                        cutir:p:<id>       -> the project document (model v2, see src/model/types.ts)
 *                        cutir:t:<id>       -> JPEG data URL thumbnail
 *                        cutir:backup:<id>:v<n> -> the original JSON of a project saved in an older format, kept
 *                                              read-only the first time it is migrated
 * IndexedDB (assetdb):   <id>/audio, <id>/bg -> the actual song / background files
 */

export type ProjectEntry = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  aspect: Aspect;
  lineCount: number;
  audioName?: string;
};

type Library = {
  entries: ProjectEntry[];
  thumbs: Record<string, string>;
  currentId: string | null;
  screen: "home" | "editor";
  ready: boolean;
  saveFailed: boolean;
  /** Something the user should know about a project that was just opened (a recovery, an unreadable save). */
  notice: string;
  dismissNotice: () => void;

  init: () => void;
  createProject: (opts: { name: string; aspect: Aspect; fps: 30 | 60 }) => Promise<string>;
  openProject: (id: string) => Promise<void>;
  goHome: () => void;
  renameProject: (id: string, name: string) => void;
  duplicateProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  importProject: (name: string, raw: unknown) => Promise<void>;
  /** Open a project package (zip with the project and its media) as a new project. Returns the names of damaged files. */
  importPackage: (file: Blob) => Promise<string[]>;
  /** Called by autosave with the live document and its lyric view. */
  saveContent: (doc: ProjectDoc, view: Project) => void;
  saveAsset: (slot: "audio" | "bg", file: Blob, name: string) => void;
  clearAsset: (slot: "audio" | "bg") => void;
};

const LIB_KEY = "cutir:library";
const LEGACY_KEY = "cutir:project"; // single-project autosave from before the Home screen

const safeGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const safeSet = (k: string, v: string): boolean => {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
};
const safeDel = (k: string) => {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
};

function readEntries(): ProjectEntry[] {
  try {
    const raw = safeGet(LIB_KEY);
    const list = raw ? (JSON.parse(raw) as ProjectEntry[]) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === "string") : [];
  } catch {
    return [];
  }
}

function uniqueName(base: string, entries: ProjectEntry[]): string {
  const taken = new Set(entries.map((e) => e.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

const metaOf = (p: Project) => ({ aspect: p.aspect, lineCount: p.lines.length, audioName: p.audio?.name });

let liveUrls: string[] = []; // object URLs of the open project's restored files
const revokeLive = () => {
  liveUrls.forEach((u) => URL.revokeObjectURL(u));
  liveUrls = [];
};

const recoveryBackend = fileRecoveryBackend();
const recovery = recoveryWriter(recoveryBackend);
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void recovery.flush());
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void recovery.flush());
}

export const useLibrary = create<Library>((set, get) => {
  const persistEntries = (entries: ProjectEntry[]) => {
    set({ entries, saveFailed: !safeSet(LIB_KEY, JSON.stringify(entries)) && get().saveFailed });
  };

  const loadThumbs = (entries: ProjectEntry[]) => {
    const thumbs: Record<string, string> = {};
    for (const e of entries) {
      const t = safeGet(`cutir:t:${e.id}`);
      if (t) thumbs[e.id] = t;
    }
    return thumbs;
  };

  const writeProject = (id: string, doc: ProjectDoc, p: Project, withThumb: boolean) => {
    const text = serializeDoc(doc);
    const ok = safeSet(`cutir:p:${id}`, text);
    if (ok) safeSet(`cutir:s:${id}`, checksum(text));
    recovery.schedule(id, text); // a second copy a few seconds later, in the file store
    let thumb: string | null = null;
    if (withThumb) {
      thumb = makeThumbnail(p);
      if (thumb) safeSet(`cutir:t:${id}`, thumb);
    }
    const entries = get().entries.map((e) => (e.id === id ? { ...e, updatedAt: ok ? Date.now() : e.updatedAt, ...metaOf(p) } : e));
    set({
      entries,
      thumbs: thumb ? { ...get().thumbs, [id]: thumb } : get().thumbs,
      saveFailed: !ok,
    });
    safeSet(LIB_KEY, JSON.stringify(entries));
  };

  /**
   * Read a project (any saved format) and put its media files back (object URLs are session-only).
   * A project saved in an older format is migrated; its original JSON is kept once as a read-only backup.
   */
  const hydrate = async (id: string): Promise<ProjectDoc> => {
    let raw = safeGet(`cutir:p:${id}`);
    const pick = chooseSource({ json: raw, sum: safeGet(`cutir:s:${id}`), savedAt: get().entries.find((e) => e.id === id)?.updatedAt ?? 0 }, await recoveryBackend.read(id));
    if (pick.source === "recovery") {
      raw = pick.json;
      if (safeGet(`cutir:p:${id}`)) safeSet(`cutir:damaged:${id}`, safeGet(`cutir:p:${id}`) as string);
      safeSet(`cutir:p:${id}`, raw);
      safeSet(`cutir:s:${id}`, checksum(raw));
      set({ notice: pick.why === "newer" ? "Your last changes did not reach the saved copy, so Cutir opened the recovery copy instead." : "The saved copy of this project was damaged. Cutir opened the recovery copy; the damaged one is kept." });
    } else if (pick.source === "none" && raw) {
      safeSet(`cutir:damaged:${id}`, raw);
      raw = null;
      set({ notice: "This project could not be read and no recovery copy exists. The damaged data is kept in this browser; the project opens empty." });
    }
    let doc: ProjectDoc;
    if (!raw) doc = viewToDoc(defaultProject());
    else {
      const { doc: loaded, fromVersion } = loadDoc(raw);
      doc = loaded;
      if (fromVersion < SCHEMA_VERSION) {
        const backupKey = `cutir:backup:${id}:v${fromVersion}`;
        if (safeGet(backupKey) === null) safeSet(backupKey, raw);
        safeSet(`cutir:p:${id}`, serializeDoc(doc));
      }
    }
    revokeLive();
    const media = await Promise.all(
      doc.media.map(async (m) => {
        const f = await loadFile(`${id}/${m.fileKey}`);
        if (!f) return m;
        const u = URL.createObjectURL(f.blob);
        liveUrls.push(u);
        return { ...m, url: u };
      })
    );
    return { ...doc, media };
  };

  const addEntry = (name: string, p: Project): ProjectEntry => {
    const now = Date.now();
    const entry: ProjectEntry = { id: uid() + uid(), name, createdAt: now, updatedAt: now, ...metaOf(p) };
    persistEntries([entry, ...get().entries]);
    return entry;
  };

  return {
    entries: [],
    thumbs: {},
    currentId: null,
    screen: "home",
    ready: false,
    saveFailed: false,
    notice: "",
    dismissNotice: () => set({ notice: "" }),

    init: () => {
      if (get().ready) return;
      let entries = readEntries();
      // one-time migration of the old single-project autosave
      const legacy = safeGet(LEGACY_KEY);
      if (legacy) {
        try {
          const { doc } = loadDoc(legacy);
          const p = docToView(doc);
          const id = uid() + uid();
          const now = Date.now();
          if (safeSet(`cutir:p:${id}`, serializeDoc(doc))) {
            entries = [{ id, name: "Untitled project", createdAt: now, updatedAt: now, ...metaOf(p) }, ...entries];
            safeSet(LIB_KEY, JSON.stringify(entries));
            safeDel(LEGACY_KEY);
          }
        } catch {
          /* unreadable legacy data: leave it alone */
        }
      }
      set({ entries, thumbs: loadThumbs(entries), ready: true });
    },

    createProject: async ({ name, aspect, fps }) => {
      const p: Project = { ...defaultProject(), aspect, fps, style: { ...DEFAULT_STYLE } };
      const entry = addEntry(uniqueName(name.trim() || "Untitled project", get().entries), p);
      safeSet(`cutir:p:${entry.id}`, serializeDoc(viewToDoc(p)));
      await get().openProject(entry.id);
      return entry.id;
    },

    openProject: async (id) => {
      const cur = get().currentId;
      if (cur && cur !== id) {
        writeProject(cur, useProject.getState().doc, useProject.getState().project, true);
      }
      const doc = await hydrate(id);
      if (cur !== id) {
        useChat.getState().loadProject(id); // chats belong to the project they were started in
        void useMedia.getState().load(id);
      }
      useVersions.setState({ projectId: null, list: [] }); // loading another document is not a change to the old one
      useProject.getState().loadDoc(doc);
      useProject.setState({ chatOpen: useSettings.getState().showAiOnOpen });
      set({ currentId: id, screen: "editor" });
    },

    goHome: () => {
      const id = get().currentId;
      if (id) writeProject(id, useProject.getState().doc, useProject.getState().project, true);
      useChat.getState().loadProject(null);
      void useMedia.getState().load(null);
      set({ currentId: null, screen: "home" });
      revokeLive();
    },

    renameProject: (id, name) => {
      const n = name.trim();
      if (!n) return;
      persistEntries(get().entries.map((e) => (e.id === id ? { ...e, name: n } : e)));
    },

    duplicateProject: async (id) => {
      const src = get().entries.find((e) => e.id === id);
      if (!src) return;
      const raw = safeGet(`cutir:p:${id}`);
      if (!raw) return;
      const now = Date.now();
      const copy: ProjectEntry = { ...src, id: uid() + uid(), name: uniqueName(`${src.name} copy`, get().entries), createdAt: now, updatedAt: now };
      safeSet(`cutir:p:${copy.id}`, raw);
      const thumb = safeGet(`cutir:t:${id}`);
      if (thumb) safeSet(`cutir:t:${copy.id}`, thumb);
      await copyProjectFiles(id, copy.id);
      await copyProjectMedia(id, copy.id);
      persistEntries([copy, ...get().entries]);
      set({ thumbs: loadThumbs(get().entries) });
    },

    deleteProject: async (id) => {
      safeDel(`cutir:p:${id}`);
      safeDel(`cutir:t:${id}`);
      safeDel(`cutir:chats:${id}`);
      await deleteProjectFiles(id);
      await deleteProjectMedia(id);
      const { [id]: _gone, ...thumbs } = get().thumbs;
      void _gone;
      persistEntries(get().entries.filter((e) => e.id !== id));
      set({ thumbs });
    },

    importProject: async (name, raw) => {
      const { doc } = loadDoc(raw); // any format; a file from a newer Cutir throws with a message
      const entry = addEntry(uniqueName(name.trim() || "Imported project", get().entries), docToView(doc));
      safeSet(`cutir:p:${entry.id}`, serializeDoc(doc));
      await get().openProject(entry.id);
    },

    importPackage: async (file) => {
      const pkg = await openPackage(file, { verify: true });
      const entry = addEntry(uniqueName(pkg.manifest.name || "Imported project", get().entries), docToView(pkg.doc));
      const id = entry.id;
      for (const it of pkg.items) {
        const e = pkg.files.get(it.id);
        if (!e || pkg.damaged.includes(it.name)) continue;
        await putFile(`${id}/m/${it.id}`, await e.read(), it.name);
      }
      for (const m of pkg.doc.media) {
        const e = pkg.slots.get(m.fileKey);
        if (e && !pkg.damaged.includes(m.name)) await saveFile(`${id}/${m.fileKey}`, await e.read(), m.name);
      }
      safeSet(`cutir:media:${id}`, JSON.stringify(pkg.items.filter((i) => pkg.files.has(i.id) && !pkg.damaged.includes(i.name))));
      safeSet(`cutir:bins:${id}`, JSON.stringify(pkg.bins));
      safeSet(`cutir:p:${id}`, serializeDoc(pkg.doc));
      await get().openProject(id);
      return pkg.damaged;
    },

    saveContent: (doc, p) => {
      const id = get().currentId;
      if (id) writeProject(id, doc, p, false);
    },

    saveAsset: (slot, file, name) => {
      const id = get().currentId;
      if (id) void saveFile(`${id}/${slot}`, file, name);
    },

    clearAsset: (slot) => {
      const id = get().currentId;
      if (id) void deleteFile(`${id}/${slot}`);
    },
  };
});

/** Best-effort save when the tab closes (thumbnail included). */
export function installUnloadSave() {
  window.addEventListener("beforeunload", () => {
    const { currentId } = useLibrary.getState();
    if (!currentId) return;
    safeSet(`cutir:p:${currentId}`, serializeDoc(useProject.getState().doc));
  });
}
