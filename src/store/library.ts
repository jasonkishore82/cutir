import { create } from "zustand";
import {
  DEFAULT_STYLE,
  defaultProject,
  normalizeProject,
  serializeProject,
  uid,
  useProject,
  type AssetRef,
  type Aspect,
  type Project,
} from "./project";
import { useChat } from "./chat";
import { copyProjectMedia, deleteProjectMedia, useMedia } from "./media";
import { useSettings } from "./settings";
import { copyProjectFiles, deleteFile, deleteProjectFiles, loadFile, saveFile } from "../lib/assetdb";
import { makeThumbnail } from "../lib/thumbnail";

/**
 * The project library behind the Home screen.
 * localStorage layout:   cutir:library      -> JSON array of ProjectEntry (small, for the Home grid)
 *                        cutir:p:<id>       -> the project JSON (lyrics, style, asset names)
 *                        cutir:t:<id>       -> JPEG data URL thumbnail
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

  init: () => void;
  createProject: (opts: { name: string; aspect: Aspect; fps: 30 | 60 }) => Promise<string>;
  openProject: (id: string) => Promise<void>;
  goHome: () => void;
  renameProject: (id: string, name: string) => void;
  duplicateProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  importProject: (name: string, raw: unknown) => Promise<void>;
  /** Called by autosave with the live project. */
  saveContent: (p: Project) => void;
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

  const writeProject = (id: string, p: Project, withThumb: boolean) => {
    const ok = safeSet(`cutir:p:${id}`, serializeProject(p));
    let thumb: string | null = null;
    if (withThumb) {
      thumb = makeThumbnail(p);
      if (thumb) safeSet(`cutir:t:${id}`, thumb);
    }
    const entries = get().entries.map((e) => (e.id === id ? { ...e, updatedAt: Date.now(), ...metaOf(p) } : e));
    set({
      entries,
      thumbs: thumb ? { ...get().thumbs, [id]: thumb } : get().thumbs,
      saveFailed: !ok,
    });
    safeSet(LIB_KEY, JSON.stringify(entries));
  };

  /** Read a project and put its saved audio/background back (object URLs are session-only). */
  const hydrate = async (id: string): Promise<Project> => {
    const raw = safeGet(`cutir:p:${id}`);
    const project = raw ? normalizeProject(JSON.parse(raw)) : defaultProject();
    revokeLive();
    const url = (b: Blob) => {
      const u = URL.createObjectURL(b);
      liveUrls.push(u);
      return u;
    };
    if (project.audio) {
      const f = await loadFile(`${id}/audio`);
      if (f) project.audio = { ...project.audio, url: url(f.blob) };
    }
    if (project.background.type === "asset" && project.background.asset) {
      const f = await loadFile(`${id}/bg`);
      if (f) project.background = { ...project.background, asset: { ...project.background.asset, url: url(f.blob) } as AssetRef };
    }
    return project;
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

    init: () => {
      if (get().ready) return;
      let entries = readEntries();
      // one-time migration of the old single-project autosave
      const legacy = safeGet(LEGACY_KEY);
      if (legacy) {
        try {
          const p = normalizeProject(JSON.parse(legacy));
          const id = uid() + uid();
          const now = Date.now();
          if (safeSet(`cutir:p:${id}`, serializeProject(p))) {
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
      safeSet(`cutir:p:${entry.id}`, serializeProject(p));
      await get().openProject(entry.id);
      return entry.id;
    },

    openProject: async (id) => {
      const cur = get().currentId;
      if (cur && cur !== id) {
        writeProject(cur, useProject.getState().project, true);
      }
      const project = await hydrate(id);
      if (cur !== id) {
        useChat.getState().loadProject(id); // chats belong to the project they were started in
        void useMedia.getState().load(id);
      }
      useProject.getState().loadProject(project);
      useProject.setState({ chatOpen: useSettings.getState().showAiOnOpen });
      set({ currentId: id, screen: "editor" });
    },

    goHome: () => {
      const id = get().currentId;
      if (id) writeProject(id, useProject.getState().project, true);
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
      const p = normalizeProject(raw as Partial<Project>);
      const entry = addEntry(uniqueName(name.trim() || "Imported project", get().entries), p);
      safeSet(`cutir:p:${entry.id}`, serializeProject(p));
      await get().openProject(entry.id);
    },

    saveContent: (p) => {
      const id = get().currentId;
      if (id) writeProject(id, p, false);
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
    const p = useProject.getState().project;
    safeSet(`cutir:p:${currentId}`, serializeProject(p));
  });
}
