import { loadDoc } from "../../model/migrate";

/**
 * Crash recovery and integrity (phase 29). Every save of a project writes its text to localStorage together with a
 * checksum, and a second copy to the file store a moment later. On open, the two are compared: a copy that does not
 * parse or does not match its checksum is not trusted, and a recovery copy newer than the saved one (the last write
 * never landed: crash, quota) wins.
 */

/** FNV-1a over UTF-16 code units, with the length: small, fast, and enough to catch a cut-off or garbled write. */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${text.length}`;
}

export type RecoveryCopy = { at: number; sum: string; json: string };

export type Source =
  | { source: "local"; json: string }
  | { source: "recovery"; json: string; why: "newer" | "damaged" }
  | { source: "none"; why: string };

const readable = (json: string): boolean => {
  try {
    loadDoc(json);
    return true;
  } catch {
    return false;
  }
};

/** Whether a stored text can be trusted: it parses and (when a checksum was saved) matches it. */
export const isIntact = (json: string | null, sum: string | null): json is string => !!json && (sum === null || checksum(json) === sum) && readable(json);

/**
 * Pick the text to open. `savedAt` is when the library last recorded a save (ms); a recovery copy more than a second
 * newer means a save was lost.
 */
export function chooseSource(local: { json: string | null; sum: string | null; savedAt: number }, recovery: RecoveryCopy | null): Source {
  const localOk = isIntact(local.json, local.sum);
  const recOk = !!recovery && isIntact(recovery.json, recovery.sum);
  if (localOk && recOk && recovery!.at > local.savedAt + 1000 && recovery!.json !== local.json) return { source: "recovery", json: recovery!.json, why: "newer" };
  if (localOk) return { source: "local", json: local.json as string };
  if (recOk) return { source: "recovery", json: recovery!.json, why: local.json ? "damaged" : "newer" };
  if (!local.json && !recovery) return { source: "none", why: "empty" };
  return { source: "none", why: "Neither the saved copy nor the recovery copy can be read." };
}

export type RecoveryBackend = {
  read: (id: string) => Promise<RecoveryCopy | null>;
  write: (id: string, copy: RecoveryCopy) => Promise<void>;
};

export const memoryRecoveryBackend = (): RecoveryBackend & { store: Map<string, RecoveryCopy> } => {
  const store = new Map<string, RecoveryCopy>();
  return { store, read: async (id) => store.get(id) ?? null, write: async (id, c) => void store.set(id, c) };
};

export const fileRecoveryBackend = (): RecoveryBackend => ({
  read: async (id) => {
    try {
      const { getFile } = await import("../filestore");
      const f = await getFile(`${id}/recovery.json`);
      if (!f) return null;
      const c = JSON.parse(await f.text());
      return c && typeof c.json === "string" && typeof c.sum === "string" && typeof c.at === "number" ? (c as RecoveryCopy) : null;
    } catch {
      return null;
    }
  },
  write: async (id, c) => {
    try {
      const { putFile } = await import("../filestore");
      await putFile(`${id}/recovery.json`, new Blob([JSON.stringify(c)], { type: "application/json" }), "recovery.json");
    } catch {
      /* best effort */
    }
  },
});

/**
 * Writes recovery copies a few seconds apart instead of on every keystroke. `flush` writes what is waiting right away
 * (called when the tab is hidden or closed).
 */
export function recoveryWriter(backend: RecoveryBackend, delay = 3000, now: () => number = Date.now) {
  let pending: { id: string; json: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    const p = pending;
    pending = null;
    if (p) await backend.write(p.id, { at: now(), sum: checksum(p.json), json: p.json });
  };
  return {
    schedule: (id: string, json: string) => {
      if (pending && pending.id !== id) void flush();
      pending = { id, json };
      timer ??= setTimeout(() => void flush(), delay);
    },
    flush,
  };
}
