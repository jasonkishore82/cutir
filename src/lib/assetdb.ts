/**
 * Per-project file storage (audio, background image/video) in IndexedDB, so a project reopened from the
 * Home screen gets its song and background back. Keys look like "<projectId>/audio".
 * Every call is best-effort: if IndexedDB is unavailable the app still works, files just are not remembered.
 */

const DB = "cutir-assets";
const STORE = "files";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = run(t.objectStore(STORE));
      t.oncomplete = () => {
        db.close();
        resolve(r ? (r.result as T) : undefined);
      };
      t.onerror = t.onabort = () => {
        db.close();
        reject(t.error);
      };
    });
  } catch {
    return undefined;
  }
}

export type StoredFile = { blob: Blob; name: string };

export const saveFile = (key: string, blob: Blob, name: string) =>
  tx("readwrite", (s) => s.put({ blob, name } satisfies StoredFile, key)).then(() => undefined);

export const loadFile = (key: string) => tx<StoredFile>("readonly", (s) => s.get(key) as IDBRequest<StoredFile>);

export const deleteFile = (key: string) => tx("readwrite", (s) => s.delete(key)).then(() => undefined);

/** Remove every file of a project, or copy them to another project (used by Duplicate). */
export async function deleteProjectFiles(projectId: string) {
  for (const slot of ["audio", "bg"]) await deleteFile(`${projectId}/${slot}`);
}

export async function copyProjectFiles(from: string, to: string) {
  for (const slot of ["audio", "bg"]) {
    const f = await loadFile(`${from}/${slot}`);
    if (f) await saveFile(`${to}/${slot}`, f.blob, f.name);
  }
}
