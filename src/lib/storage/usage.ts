/**
 * Storage manager (phase 29): what a project takes up, per kind of file and per media item, and what can be cleaned.
 * Files are listed by key as the file store keeps them: <project>/m/<item>, proxy/<item>, opt/<item>, thumb/<item>,
 * plus versions.json and recovery.json. Anything else under the project folder is "other".
 */

export type FileEntry = { key: string; size: number };
export type ItemInfo = { id: string; name: string; size?: number; storage?: "copy" | "link" };

export type Usage = {
  total: number;
  media: number;
  proxies: number;
  optimized: number;
  thumbs: number;
  versions: number;
  recovery: number;
  other: number;
  /** Largest items first, with every file that belongs to each. */
  items: { id: string; name: string; bytes: number; linked: boolean }[];
  /** Files no pool item owns. Safe to delete. */
  orphans: FileEntry[];
};

export function projectUsage(projectId: string, files: FileEntry[], items: ItemInfo[]): Usage {
  const byId = new Map(items.map((i) => [i.id, i]));
  const u: Usage = { total: 0, media: 0, proxies: 0, optimized: 0, thumbs: 0, versions: 0, recovery: 0, other: 0, items: [], orphans: [] };
  const per = new Map<string, number>();
  const prefix = `${projectId}/`;
  for (const f of files) {
    if (!f.key.startsWith(prefix)) continue;
    const rest = f.key.slice(prefix.length);
    u.total += f.size;
    const m = /^(m|proxy|opt|thumb)\/(.+)$/.exec(rest);
    if (m) {
      const id = m[2];
      if (!byId.has(id)) {
        u.orphans.push(f);
        u[m[1] === "m" ? "media" : m[1] === "proxy" ? "proxies" : m[1] === "opt" ? "optimized" : "thumbs"] += f.size;
        continue;
      }
      per.set(id, (per.get(id) ?? 0) + (m[1] === "thumb" ? 0 : f.size));
      u[m[1] === "m" ? "media" : m[1] === "proxy" ? "proxies" : m[1] === "opt" ? "optimized" : "thumbs"] += f.size;
    } else if (rest === "versions.json") u.versions += f.size;
    else if (rest === "recovery.json") u.recovery += f.size;
    else u.other += f.size;
  }
  u.items = items.map((i) => ({ id: i.id, name: i.name, bytes: per.get(i.id) ?? 0, linked: i.storage === "link" })).sort((a, b) => b.bytes - a.bytes);
  return u;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

/** What the browser says about space: used and the most it will let this site have. */
export async function deviceStorage(): Promise<{ used: number; quota: number; persisted: boolean } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage ?? 0, quota: e.quota ?? 0, persisted: (await navigator.storage.persisted?.()) ?? false };
  } catch {
    return null;
  }
}
