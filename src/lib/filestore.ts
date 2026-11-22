import { deleteFile as idbDelete, loadFile as idbLoad, saveFile as idbSave } from "./assetdb";

/**
 * Where media files live.
 *
 * - Origin Private File System (OPFS) first: files are streamed in chunk by chunk (a 2 GB video is never held in
 *   memory) and read back as disk-backed File objects. Keys like "<projectId>/m/<id>" become nested folders.
 * - IndexedDB when OPFS is not available (older Safari) and for files stored before OPFS was used.
 * - Linked files: with the File System Access API the project can keep a handle to the original file instead of a
 *   copy. Handles are kept in IndexedDB; reading one may need the user's permission again after a reload.
 */

export type Stored = "opfs" | "idb";

const hasOpfs = () => typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;

async function dirOf(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    let dir = await navigator.storage.getDirectory();
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir;
  } catch {
    return null;
  }
}

const split = (key: string) => {
  const parts = key.split("/").filter(Boolean);
  return { dirs: ["cutir", ...parts.slice(0, -1)], name: parts[parts.length - 1] };
};

/** Store a file under `key`. Large files are streamed to disk, never read into memory. */
export async function putFile(key: string, blob: Blob, name = "file"): Promise<Stored> {
  if (hasOpfs()) {
    const { dirs, name: leaf } = split(key);
    const dir = await dirOf(dirs, true);
    try {
      const fh = await dir?.getFileHandle(leaf, { create: true });
      if (fh && "createWritable" in fh) {
        const w = await fh.createWritable();
        await blob.stream().pipeTo(w); // closes the writable when done
        return "opfs";
      }
    } catch {
      /* quota or browser without writable streams: fall back */
    }
  }
  await idbSave(key, blob, name);
  return "idb";
}

/** A stored file (OPFS first, then IndexedDB), or null when it is gone. */
export async function getFile(key: string, name = "file", type = ""): Promise<File | null> {
  if (hasOpfs()) {
    const { dirs, name: leaf } = split(key);
    const dir = await dirOf(dirs, false);
    try {
      const fh = await dir?.getFileHandle(leaf);
      if (fh) {
        const f = await fh.getFile();
        return new File([f], name, { type: type || f.type, lastModified: f.lastModified }); // still disk-backed
      }
    } catch {
      /* not in OPFS */
    }
  }
  const old = await idbLoad(key);
  return old ? new File([old.blob], name || old.name, { type: type || old.blob.type }) : null;
}

export async function removeFile(key: string) {
  if (hasOpfs()) {
    const { dirs, name } = split(key);
    const dir = await dirOf(dirs, false);
    try {
      await dir?.removeEntry(name);
    } catch {
      /* already gone */
    }
  }
  await idbDelete(key);
}

/** Remove a whole folder, e.g. everything of a deleted project. */
export async function removeFolder(prefix: string) {
  if (!hasOpfs()) return;
  const parts = ["cutir", ...prefix.split("/").filter(Boolean)];
  const parent = await dirOf(parts.slice(0, -1), false);
  try {
    await parent?.removeEntry(parts[parts.length - 1], { recursive: true });
  } catch {
    /* already gone */
  }
}

/* ---------- linked originals (File System Access API) ---------- */

export const canLink = () => typeof window !== "undefined" && "showOpenFilePicker" in window;

const HDB = "cutir-handles";
function handleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HDB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("h");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function handleTx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  try {
    const db = await handleDb();
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction("h", mode);
      const r = run(t.objectStore("h"));
      t.oncomplete = () => (db.close(), resolve(r ? (r.result as T) : undefined));
      t.onerror = t.onabort = () => (db.close(), reject(t.error));
    });
  } catch {
    return undefined;
  }
}

export const saveHandle = (key: string, h: FileSystemFileHandle) => handleTx("readwrite", (s) => s.put(h, key)).then(() => undefined);
export const forgetHandle = (key: string) => handleTx("readwrite", (s) => s.delete(key)).then(() => undefined);
export const loadHandle = (key: string) => handleTx<FileSystemFileHandle>("readonly", (s) => s.get(key) as IDBRequest<FileSystemFileHandle>);

type PermHandle = FileSystemFileHandle & {
  queryPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
};

/** Read a linked original. `ask` prompts for permission (needs a click); without it a missing permission returns "permission". */
export async function readLinked(key: string, ask = false): Promise<File | "permission" | null> {
  const h = (await loadHandle(key)) as PermHandle | undefined;
  if (!h) return null;
  try {
    let state = (await h.queryPermission?.({ mode: "read" })) ?? "granted";
    if (state !== "granted" && ask) state = (await h.requestPermission?.({ mode: "read" })) ?? "denied";
    if (state !== "granted") return "permission";
    return await h.getFile();
  } catch {
    return null; // moved or deleted
  }
}

/** Let the user pick files to link (not copied). */
export async function pickLinkedFiles(accept: Record<string, string[]>): Promise<FileSystemFileHandle[]> {
  const picker = (window as unknown as { showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
  try {
    return await picker({ multiple: true, types: [{ description: "Media", accept }] });
  } catch {
    return []; // cancelled
  }
}

/** Every file under a folder of the file store (OPFS), with its size. Files kept in IndexedDB are not listed. */
export async function listFiles(prefix: string): Promise<{ key: string; size: number }[]> {
  if (!hasOpfs()) return [];
  const root = await dirOf(["cutir", ...prefix.split("/").filter(Boolean)], false);
  const out: { key: string; size: number }[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, `${path}/${name}`);
      else out.push({ key: `${path}/${name}`, size: (await (h as FileSystemFileHandle).getFile()).size });
    }
  };
  if (root) await walk(root, prefix.replace(/\/+$/, ""));
  return out;
}
