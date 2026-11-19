import { create } from "zustand";
import { deleteFile, loadFile, saveFile } from "../lib/assetdb";
import { uid } from "./project";

/**
 * Per-project media pool: any number of audio, video and image files imported once and reused.
 * Metadata lives in localStorage (`cutir:media:<projectId>`), the files themselves in IndexedDB
 * (`<projectId>/m/<itemId>`), and object URLs only exist while the project is open.
 */

export type MediaKind = "audio" | "video" | "image";

export type MediaItem = {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  size: number;
  lastModified: number;
  duration?: number; // seconds, audio and video only
  addedAt: number;
};

const metaKey = (pid: string) => `cutir:media:${pid}`;
const fileKey = (pid: string, id: string) => `${pid}/m/${id}`;

const AUDIO = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export function kindOf(f: { name: string; type: string }): MediaKind | null {
  if (f.type.startsWith("audio/") || AUDIO.test(f.name)) return "audio";
  if (f.type.startsWith("video/") || VIDEO.test(f.name)) return "video";
  if (f.type.startsWith("image/") || IMAGE.test(f.name)) return "image";
  return null;
}

const sameFile = (a: MediaItem, f: File) => a.name === f.name && a.size === f.size;

function readMeta(pid: string): MediaItem[] {
  try {
    const raw = localStorage.getItem(metaKey(pid));
    return raw ? (JSON.parse(raw) as MediaItem[]) : [];
  } catch {
    return [];
  }
}

function writeMeta(pid: string, items: MediaItem[]) {
  try {
    localStorage.setItem(metaKey(pid), JSON.stringify(items));
  } catch {
    /* storage full: the list is kept in memory for this session */
  }
}

/** Duration of an audio or video file; undefined when the browser cannot read it. */
function probeDuration(url: string, kind: "audio" | "video"): Promise<number | undefined> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    const done = (v?: number) => {
      el.removeAttribute("src");
      el.load();
      resolve(v);
    };
    const timer = setTimeout(() => done(), 8000);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(el.duration) ? el.duration : undefined);
    };
    el.onerror = () => {
      clearTimeout(timer);
      done();
    };
    el.src = url;
  });
}

/** A small JPEG frame from a video, for the pool tile. */
function videoThumb(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    const done = (s?: string) => {
      v.removeAttribute("src");
      v.load();
      resolve(s);
    };
    const timer = setTimeout(() => done(), 8000);
    v.onloadeddata = () => {
      v.currentTime = Math.min(1, (v.duration || 2) / 2);
    };
    v.onseeked = () => {
      clearTimeout(timer);
      try {
        const w = 240;
        const h = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        done(c.toDataURL("image/jpeg", 0.7));
      } catch {
        done();
      }
    };
    v.onerror = () => {
      clearTimeout(timer);
      done();
    };
    v.src = url;
  });
}

type MediaState = {
  projectId: string | null;
  items: MediaItem[];
  urls: Record<string, string>; // object URLs, this session only
  thumbs: Record<string, string>; // video poster frames, this session only
  notice: string;

  load: (projectId: string | null) => Promise<void>;
  addFiles: (files: File[]) => Promise<MediaItem[]>;
  remove: (id: string) => void;
  fileOf: (id: string) => Promise<File | null>;
  dismissNotice: () => void;
};

export const useMedia = create<MediaState>((set, get) => {
  const revoke = () => Object.values(get().urls).forEach((u) => URL.revokeObjectURL(u));

  const enrich = async (pid: string, item: MediaItem, url: string) => {
    if (item.kind === "image") return;
    const duration = await probeDuration(url, item.kind);
    if (get().projectId !== pid) return;
    if (duration !== undefined) {
      const items = get().items.map((i) => (i.id === item.id ? { ...i, duration } : i));
      set({ items });
      writeMeta(pid, items);
    }
    if (item.kind === "video") {
      const thumb = await videoThumb(url);
      if (thumb && get().projectId === pid) set((s) => ({ thumbs: { ...s.thumbs, [item.id]: thumb } }));
    }
  };

  return {
    projectId: null,
    items: [],
    urls: {},
    thumbs: {},
    notice: "",

    load: async (pid) => {
      revoke();
      set({ projectId: pid, items: [], urls: {}, thumbs: {}, notice: "" });
      if (!pid) return;
      const items = readMeta(pid);
      const urls: Record<string, string> = {};
      const present: MediaItem[] = [];
      for (const it of items) {
        const f = await loadFile(fileKey(pid, it.id));
        if (get().projectId !== pid) return; // another project was opened meanwhile
        if (f) {
          urls[it.id] = URL.createObjectURL(f.blob);
          present.push(it);
        }
      }
      set({ items: present, urls });
      // posters for videos, one at a time so large files do not compete
      for (const it of present) {
        if (it.kind === "video" && get().projectId === pid) {
          const thumb = await videoThumb(urls[it.id]);
          if (thumb && get().projectId === pid) set((s) => ({ thumbs: { ...s.thumbs, [it.id]: thumb } }));
        }
      }
    },

    addFiles: async (files) => {
      const pid = get().projectId;
      if (!pid) return [];
      const result: MediaItem[] = [];
      const skipped: string[] = [];
      for (const f of files) {
        const existing = get().items.find((i) => sameFile(i, f));
        if (existing) {
          result.push(existing);
          continue;
        }
        const kind = kindOf(f);
        if (!kind) {
          skipped.push(f.name);
          continue;
        }
        const item: MediaItem = { id: uid(), name: f.name, kind, mime: f.type, size: f.size, lastModified: f.lastModified, addedAt: Date.now() };
        await saveFile(fileKey(pid, item.id), f, f.name);
        if (get().projectId !== pid) return result;
        const url = URL.createObjectURL(f);
        const items = [...get().items, item];
        set((s) => ({ items, urls: { ...s.urls, [item.id]: url } }));
        writeMeta(pid, items);
        result.push(item);
        void enrich(pid, item, url);
      }
      set({ notice: skipped.length ? `Skipped ${skipped.length} unsupported file${skipped.length === 1 ? "" : "s"}: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ", ..." : ""}` : "" });
      return result;
    },

    remove: (id) => {
      const pid = get().projectId;
      if (!pid) return;
      const url = get().urls[id];
      if (url) URL.revokeObjectURL(url);
      void deleteFile(fileKey(pid, id));
      const items = get().items.filter((i) => i.id !== id);
      set((s) => {
        const { [id]: _u, ...urls } = s.urls;
        const { [id]: _t, ...thumbs } = s.thumbs;
        void _u;
        void _t;
        return { items, urls, thumbs };
      });
      writeMeta(pid, items);
    },

    fileOf: async (id) => {
      const pid = get().projectId;
      const item = get().items.find((i) => i.id === id);
      if (!pid || !item) return null;
      const f = await loadFile(fileKey(pid, id));
      return f ? new File([f.blob], item.name, { type: item.mime || f.blob.type, lastModified: item.lastModified }) : null;
    },

    dismissNotice: () => set({ notice: "" }),
  };
});

/** Remove a project's pool (used when the project is deleted). */
export async function deleteProjectMedia(pid: string) {
  for (const it of readMeta(pid)) await deleteFile(fileKey(pid, it.id));
  try {
    localStorage.removeItem(metaKey(pid));
  } catch {
    /* ignore */
  }
}

/** Copy a project's pool to another project (used by Duplicate). */
export async function copyProjectMedia(from: string, to: string) {
  const items = readMeta(from);
  for (const it of items) {
    const f = await loadFile(fileKey(from, it.id));
    if (f) await saveFile(fileKey(to, it.id), f.blob, f.name);
  }
  if (items.length) writeMeta(to, items);
}
