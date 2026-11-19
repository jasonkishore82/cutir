import { create } from "zustand";
import { uid } from "./project";
import { canLink, getFile, pickLinkedFiles, putFile, readLinked, removeFile, removeFolder, saveHandle, forgetHandle } from "../lib/filestore";
import { playbackNote, probeImage, probeMedia, type ProbeInfo } from "../lib/probe";

/**
 * Per-project media pool: every file imported into a project, organised in bins and reused on timelines.
 *
 * - Metadata: localStorage `cutir:media:<projectId>` (items) and `cutir:bins:<projectId>` (bins).
 * - Files: the Origin Private File System at `<projectId>/m/<itemId>` (IndexedDB as a fallback and for files
 *   imported before), or a link to the original file when it was linked instead of copied.
 * - Poster frames: cached as files at `<projectId>/thumb/<itemId>`.
 * Object URLs exist only while the project is open; they point at disk-backed files, so nothing is held in memory.
 */

export type MediaKind = "audio" | "video" | "image" | "subtitle" | "font";

export type MediaStatus = "ok" | "missing" | "needs-permission";

export type MediaItem = {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  size: number;
  lastModified: number;
  addedAt: number;
  /** Copied into the project, or linked to the original file on disk. */
  storage?: "copy" | "link";
  binId?: string;
  duration?: number; // seconds, audio and video only
  width?: number;
  height?: number;
  fps?: number;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  channels?: number;
  hasAudio?: boolean;
  /** Why it cannot be played here (unsupported codec...). Empty when fine. */
  note?: string;
  /** Source marks for three- and four-point edits, in source seconds. */
  markIn?: number;
  markOut?: number;
};

export type Bin = { id: string; name: string; parentId?: string };

/** Built-in bins that filter instead of holding items. */
export type SmartBin = "all" | "video" | "audio" | "image" | "subtitle" | "font" | "unused";

const metaKey = (pid: string) => `cutir:media:${pid}`;
const binKey = (pid: string) => `cutir:bins:${pid}`;
export const fileKey = (pid: string, id: string) => `${pid}/m/${id}`;
const thumbKey = (pid: string, id: string) => `${pid}/thumb/${id}`;

const AUDIO = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const SUBTITLE = /\.(srt|vtt|lrc|ass|ssa)$/i;
const FONT = /\.(ttf|otf|woff2?)$/i;

export const ACCEPT =
  "audio/*,video/*,image/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus,.mp4,.mov,.webm,.mkv,.srt,.vtt,.lrc,.ass,.ssa,.ttf,.otf,.woff,.woff2";

export function kindOf(f: { name: string; type: string }): MediaKind | null {
  if (SUBTITLE.test(f.name)) return "subtitle";
  if (FONT.test(f.name) || f.type.startsWith("font/")) return "font";
  if (f.type.startsWith("audio/") || AUDIO.test(f.name)) return "audio";
  if (f.type.startsWith("video/") || VIDEO.test(f.name)) return "video";
  if (f.type.startsWith("image/") || IMAGE.test(f.name)) return "image";
  return null;
}

const sameFile = (a: MediaItem, f: File) => a.name === f.name && a.size === f.size;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full: kept in memory for this session */
  }
}

/** A small JPEG frame from a video, for the pool tile. */
function videoThumb(url: string): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    const done = (b?: Blob | null) => {
      v.removeAttribute("src");
      v.load();
      resolve(b ?? undefined);
    };
    const timer = setTimeout(() => done(), 10000);
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
        c.toBlob((b) => done(b), "image/jpeg", 0.7);
      } catch {
        done();
      }
    };
    v.onerror = () => (clearTimeout(timer), done());
    v.src = url;
  });
}

const fromProbe = (info: ProbeInfo, kind: MediaKind): Partial<MediaItem> => ({
  duration: info.duration,
  width: info.width,
  height: info.height,
  fps: info.fps,
  container: info.container,
  videoCodec: info.videoCodec,
  audioCodec: info.audioCodec,
  channels: info.channels,
  hasAudio: info.hasAudio,
  note: playbackNote(info, kind),
});

type Progress = { done: number; total: number; current: string } | null;

type MediaState = {
  projectId: string | null;
  items: MediaItem[];
  bins: Bin[];
  status: Record<string, MediaStatus>;
  urls: Record<string, string>; // object URLs, this session only
  thumbs: Record<string, string>; // poster frames, this session only
  progress: Progress;
  notice: string;

  load: (projectId: string | null) => Promise<void>;
  addFiles: (files: File[], binId?: string) => Promise<MediaItem[]>;
  /** Pick files to link instead of copy (File System Access API). */
  linkFiles: (binId?: string) => Promise<MediaItem[]>;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  moveToBin: (ids: string[], binId?: string) => void;
  setMarks: (id: string, marks: { markIn?: number | null; markOut?: number | null }) => void;
  /** Replace a missing (or any) item's file, keeping its id so the timeline keeps pointing at it. */
  relink: (id: string, file: File) => Promise<void>;
  /** Ask again for permission to read a linked original. Needs a user click. */
  grantAccess: (id: string) => Promise<void>;
  addBin: (name: string, parentId?: string) => string;
  renameBin: (id: string, name: string) => void;
  /** Delete a bin; its items and sub-bins move to its parent. */
  deleteBin: (id: string) => void;
  fileOf: (id: string) => Promise<File | null>;
  dismissNotice: () => void;
};

export const useMedia = create<MediaState>((set, get) => {
  const revoke = () => [...Object.values(get().urls), ...Object.values(get().thumbs)].forEach((u) => URL.revokeObjectURL(u));
  const saveItems = () => {
    const pid = get().projectId;
    if (pid) writeJson(metaKey(pid), get().items);
  };
  const saveBins = () => {
    const pid = get().projectId;
    if (pid) writeJson(binKey(pid), get().bins);
  };
  const patch = (id: string, p: Partial<MediaItem>) => {
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }));
    saveItems();
  };
  const setUrl = (id: string, url?: string) =>
    set((s) => {
      if (s.urls[id]) URL.revokeObjectURL(s.urls[id]);
      const urls = { ...s.urls };
      if (url) urls[id] = url;
      else delete urls[id];
      return { urls };
    });
  const setStatus = (id: string, st: MediaStatus) => set((s) => ({ status: { ...s.status, [id]: st } }));

  /** Probe and make a poster frame; runs after the file is stored so imports never wait on it. */
  const enrich = async (pid: string, item: MediaItem, file: File) => {
    try {
      if (item.kind === "audio" || item.kind === "video") {
        const info = await probeMedia(file);
        if (get().projectId !== pid) return;
        patch(item.id, fromProbe(info, item.kind));
      } else if (item.kind === "image") {
        const size = await probeImage(file);
        if (size && get().projectId === pid) patch(item.id, size);
      }
    } catch (e) {
      if (get().projectId === pid) patch(item.id, { note: `Could not read this file: ${(e as Error).message}.` });
    }
    if (item.kind === "video" && get().projectId === pid) {
      const url = get().urls[item.id];
      const blob = url ? await videoThumb(url) : undefined;
      if (blob && get().projectId === pid) {
        void putFile(thumbKey(pid, item.id), blob, "thumb.jpg");
        set((s) => ({ thumbs: { ...s.thumbs, [item.id]: URL.createObjectURL(blob) } }));
      }
    }
  };

  /** Open the file of an item for this session (URL, status, poster). */
  const open = async (pid: string, it: MediaItem): Promise<File | null> => {
    let file: File | null = null;
    if (it.storage === "link") {
      const r = await readLinked(fileKey(pid, it.id));
      if (r === "permission") {
        setStatus(it.id, "needs-permission");
        return null;
      }
      file = r;
    } else file = await getFile(fileKey(pid, it.id), it.name, it.mime);
    if (get().projectId !== pid) return null;
    if (!file) {
      setStatus(it.id, "missing");
      return null;
    }
    setStatus(it.id, "ok");
    setUrl(it.id, URL.createObjectURL(file));
    return file;
  };

  const importOne = async (pid: string, f: File, binId: string | undefined, link?: FileSystemFileHandle): Promise<MediaItem | "skip"> => {
    const existing = get().items.find((i) => sameFile(i, f));
    if (existing) return existing;
    const kind = kindOf(f);
    if (!kind) return "skip";
    const item: MediaItem = {
      id: uid(),
      name: f.name,
      kind,
      mime: f.type,
      size: f.size,
      lastModified: f.lastModified,
      addedAt: Date.now(),
      storage: link ? "link" : "copy",
      binId,
    };
    if (link) await saveHandle(fileKey(pid, item.id), link);
    else await putFile(fileKey(pid, item.id), f, f.name); // streamed: large files never sit in memory
    if (get().projectId !== pid) return item;
    set((s) => ({ items: [...s.items, item], status: { ...s.status, [item.id]: "ok" } }));
    setUrl(item.id, URL.createObjectURL(f));
    saveItems();
    void enrich(pid, item, f);
    return item;
  };

  const importMany = async (entries: { file: File; link?: FileSystemFileHandle }[], binId?: string) => {
    const pid = get().projectId;
    if (!pid || !entries.length) return [];
    const result: MediaItem[] = [];
    const skipped: string[] = [];
    set({ progress: { done: 0, total: entries.length, current: entries[0].file.name } });
    for (let i = 0; i < entries.length; i++) {
      const { file, link } = entries[i];
      set({ progress: { done: i, total: entries.length, current: file.name } });
      const r = await importOne(pid, file, binId, link);
      if (r === "skip") skipped.push(file.name);
      else result.push(r);
      await new Promise((r) => setTimeout(r, 0)); // let the page paint between files
    }
    set({
      progress: null,
      notice: skipped.length ? `Skipped ${skipped.length} unsupported file${skipped.length === 1 ? "" : "s"}: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ", ..." : ""}` : "",
    });
    return result;
  };

  return {
    projectId: null,
    items: [],
    bins: [],
    status: {},
    urls: {},
    thumbs: {},
    progress: null,
    notice: "",

    load: async (pid) => {
      revoke();
      set({ projectId: pid, items: [], bins: [], status: {}, urls: {}, thumbs: {}, notice: "", progress: null });
      if (!pid) return;
      const items = readJson<MediaItem[]>(metaKey(pid), []);
      set({ items, bins: readJson<Bin[]>(binKey(pid), []) });
      for (const it of items) {
        await open(pid, it);
        if (get().projectId !== pid) return; // another project was opened meanwhile
        if (it.kind === "video") {
          const t = await getFile(thumbKey(pid, it.id), "thumb.jpg", "image/jpeg");
          if (t && get().projectId === pid) set((s) => ({ thumbs: { ...s.thumbs, [it.id]: URL.createObjectURL(t) } }));
        }
      }
      // items imported before probing existed get their details now, one at a time
      for (const it of get().items) {
        if (get().projectId !== pid) return;
        const needs = (it.kind === "video" && (!get().thumbs[it.id] || it.width === undefined)) || (it.kind === "audio" && it.channels === undefined);
        if (needs && get().status[it.id] === "ok") {
          const f = await get().fileOf(it.id);
          if (f) await enrich(pid, it, f);
        }
      }
    },

    addFiles: (files, binId) => importMany(files.map((file) => ({ file })), binId),

    linkFiles: async (binId) => {
      if (!canLink()) return [];
      const handles = await pickLinkedFiles({
        "video/*": [".mp4", ".mov", ".webm", ".mkv", ".m4v"],
        "audio/*": [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".opus"],
        "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif"],
      });
      const entries = await Promise.all(handles.map(async (h) => ({ file: await h.getFile(), link: h })));
      return importMany(entries, binId);
    },

    remove: (id) => {
      const pid = get().projectId;
      if (!pid) return;
      const item = get().items.find((i) => i.id === id);
      setUrl(id, undefined);
      if (item?.storage === "link") void forgetHandle(fileKey(pid, id));
      else void removeFile(fileKey(pid, id));
      void removeFile(thumbKey(pid, id));
      set((s) => {
        const { [id]: _t, ...thumbs } = s.thumbs;
        const { [id]: _s, ...status } = s.status;
        if (_t) URL.revokeObjectURL(_t);
        void _s;
        return { items: s.items.filter((i) => i.id !== id), thumbs, status };
      });
      saveItems();
    },

    rename: (id, name) => {
      const n = name.trim();
      if (n) patch(id, { name: n });
    },

    moveToBin: (ids, binId) => {
      const set_ = new Set(ids);
      set((s) => ({ items: s.items.map((i) => (set_.has(i.id) ? { ...i, binId } : i)) }));
      saveItems();
    },

    setMarks: (id, m) => {
      const it = get().items.find((i) => i.id === id);
      if (!it) return;
      const next = { ...it };
      if (m.markIn !== undefined) next.markIn = m.markIn ?? undefined;
      if (m.markOut !== undefined) next.markOut = m.markOut ?? undefined;
      patch(id, { markIn: next.markIn, markOut: next.markOut });
    },

    relink: async (id, file) => {
      const pid = get().projectId;
      const it = get().items.find((i) => i.id === id);
      if (!pid || !it) return;
      if (it.storage === "link") await forgetHandle(fileKey(pid, id));
      await putFile(fileKey(pid, id), file, file.name);
      patch(id, { storage: "copy", size: file.size, mime: file.type, lastModified: file.lastModified, note: "" });
      setStatus(id, "ok");
      setUrl(id, URL.createObjectURL(file));
      const fresh = get().items.find((i) => i.id === id)!;
      void enrich(pid, fresh, file);
    },

    grantAccess: async (id) => {
      const pid = get().projectId;
      if (!pid) return;
      const r = await readLinked(fileKey(pid, id), true);
      if (r && r !== "permission") {
        setStatus(id, "ok");
        setUrl(id, URL.createObjectURL(r));
      } else setStatus(id, r === "permission" ? "needs-permission" : "missing");
    },

    addBin: (name, parentId) => {
      const bin: Bin = { id: uid(), name: name.trim() || "New bin", parentId };
      set((s) => ({ bins: [...s.bins, bin] }));
      saveBins();
      return bin.id;
    },

    renameBin: (id, name) => {
      const n = name.trim();
      if (!n) return;
      set((s) => ({ bins: s.bins.map((b) => (b.id === id ? { ...b, name: n } : b)) }));
      saveBins();
    },

    deleteBin: (id) => {
      const bin = get().bins.find((b) => b.id === id);
      if (!bin) return;
      set((s) => ({
        bins: s.bins.filter((b) => b.id !== id).map((b) => (b.parentId === id ? { ...b, parentId: bin.parentId } : b)),
        items: s.items.map((i) => (i.binId === id ? { ...i, binId: bin.parentId } : i)),
      }));
      saveBins();
      saveItems();
    },

    fileOf: async (id) => {
      const pid = get().projectId;
      const item = get().items.find((i) => i.id === id);
      if (!pid || !item) return null;
      if (item.storage === "link") {
        const r = await readLinked(fileKey(pid, id));
        return r && r !== "permission" ? r : null;
      }
      return getFile(fileKey(pid, id), item.name, item.mime);
    },

    dismissNotice: () => set({ notice: "" }),
  };
});

/** Ids of bins under `id` (itself included), for showing a bin with its sub-bins. */
export function binTree(bins: Bin[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of bins) if (b.parentId && out.has(b.parentId) && !out.has(b.id)) (out.add(b.id), (grew = true));
  }
  return out;
}

/** Remove a project's pool (used when the project is deleted). */
export async function deleteProjectMedia(pid: string) {
  for (const it of readJson<MediaItem[]>(metaKey(pid), [])) {
    await removeFile(fileKey(pid, it.id));
    await forgetHandle(fileKey(pid, it.id));
  }
  await removeFolder(pid);
  try {
    localStorage.removeItem(metaKey(pid));
    localStorage.removeItem(binKey(pid));
  } catch {
    /* ignore */
  }
}

/** Copy a project's pool to another project (used by Duplicate). Linked items stay linked to the same original. */
export async function copyProjectMedia(from: string, to: string) {
  const items = readJson<MediaItem[]>(metaKey(from), []);
  for (const it of items) {
    if (it.storage === "link") {
      const r = await readLinked(fileKey(from, it.id));
      if (r && r !== "permission") await putFile(fileKey(to, it.id), r, it.name);
      continue;
    }
    const f = await getFile(fileKey(from, it.id), it.name, it.mime);
    if (f) await putFile(fileKey(to, it.id), f, f.name);
  }
  if (items.length) {
    writeJson(metaKey(to), items.map((i) => (i.storage === "link" ? { ...i, storage: "copy" as const } : i)));
    writeJson(binKey(to), readJson<Bin[]>(binKey(from), []));
  }
}
