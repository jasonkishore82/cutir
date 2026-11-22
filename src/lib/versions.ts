import { loadDoc, serializeDoc } from "../model/migrate";
import type { Clip, ProjectDoc, Timeline } from "../model/types";

/**
 * Version history (phase 29): snapshots of the whole project document. Automatic ones are taken on a timer and before
 * big changes; named ones are kept until deleted. A snapshot is the saved JSON of the document (no media files, no
 * session URLs), so restoring is loading it again and keeping the media that is open now.
 */

export type SnapshotReason = "auto" | "action" | "manual" | "restore";

export type Snapshot = {
  id: string;
  at: number;
  /** Set for versions the user named; these are never pruned. */
  name?: string;
  reason: SnapshotReason;
  /** What a change looked like when it was taken, for the list. */
  label?: string;
  timelines: number;
  clips: number;
  json: string;
};

export const MAX_AUTO = 40;

const count = (doc: ProjectDoc) => doc.timelines.reduce((n, t) => n + t.clips.length, 0);

export function snapshotOf(doc: ProjectDoc, reason: SnapshotReason, opts: { name?: string; label?: string; at?: number; id?: string } = {}): Snapshot {
  const clean: ProjectDoc = { ...doc, media: doc.media.map(({ url: _u, ...m }) => m) };
  return {
    id: opts.id ?? `${(opts.at ?? Date.now()).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: opts.at ?? Date.now(),
    name: opts.name,
    reason,
    label: opts.label,
    timelines: doc.timelines.length,
    clips: count(doc),
    json: serializeDoc(clean),
  };
}

/** Keep every named and manual version and the newest `maxAuto` of the rest. */
export function prune(list: Snapshot[], maxAuto = MAX_AUTO): Snapshot[] {
  const keep = (s: Snapshot) => !!s.name || s.reason === "manual";
  const auto = list.filter((s) => !keep(s)).sort((a, b) => b.at - a.at).slice(0, maxAuto);
  const ids = new Set([...auto, ...list.filter(keep)].map((s) => s.id));
  return list.filter((s) => ids.has(s.id)).sort((a, b) => a.at - b.at);
}

/** Load a snapshot as a document. Media files that are open now are kept (a snapshot holds no session URLs). */
export function restoreDoc(snap: Snapshot, current: ProjectDoc): ProjectDoc {
  const { doc } = loadDoc(snap.json);
  const live = new Map(current.media.map((m) => [m.id, m]));
  return { ...doc, media: doc.media.map((m) => (live.get(m.id)?.url ? { ...m, url: live.get(m.id)!.url } : m)) };
}

/** A change big enough to be worth a snapshot of what came before it. */
export function isMajorChange(prev: ProjectDoc, next: ProjectDoc): string | null {
  if (prev === next) return null;
  // a different project was opened, not a change to this one
  if (!next.timelines.some((t) => prev.timelines.some((p) => p.id === t.id))) return null;
  const dt = next.timelines.length - prev.timelines.length;
  if (dt < 0) return "Before a timeline was deleted";
  if (dt > 0) return "Before a timeline was added";
  const dc = count(next) - count(prev);
  if (dc <= -5) return `Before ${-dc} clips were removed`;
  if (dc >= 8) return `Before ${dc} clips were added`;
  if (next.media.length < prev.media.length - 2) return "Before media was removed";
  return null;
}

/* ---------- compare ---------- */

export type TimelineDiff = { id: string; name: string; added: number; removed: number; changed: number; moved: number; markers: number; tracks: number };
export type DocDiff = {
  timelinesAdded: string[];
  timelinesRemoved: string[];
  timelines: TimelineDiff[];
  mediaAdded: string[];
  mediaRemoved: string[];
  settings: string[];
};

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) : x));

function diffTimeline(a: Timeline, b: Timeline): TimelineDiff {
  const ac = new Map(a.clips.map((c) => [c.id, c]));
  const bc = new Map(b.clips.map((c) => [c.id, c]));
  let changed = 0, moved = 0;
  for (const [id, c] of bc) {
    const o = ac.get(id);
    if (!o) continue;
    if (o.start !== c.start || o.trackId !== c.trackId) moved++;
    const rest = (x: Clip) => ({ ...x, start: 0, trackId: "" });
    if (canon(rest(o)) !== canon(rest(c))) changed++;
  }
  const mk = (t: Timeline) => new Set(t.markers.map((m) => `${m.time.toFixed(3)}|${m.name}`));
  const ma = mk(a), mb = mk(b);
  const markers = [...mb].filter((x) => !ma.has(x)).length + [...ma].filter((x) => !mb.has(x)).length;
  const ta = new Set(a.tracks.map((t) => t.id)), tb = new Set(b.tracks.map((t) => t.id));
  const tracks = [...tb].filter((x) => !ta.has(x)).length + [...ta].filter((x) => !tb.has(x)).length;
  return { id: b.id, name: b.name, added: [...bc.keys()].filter((id) => !ac.has(id)).length, removed: [...ac.keys()].filter((id) => !bc.has(id)).length, changed, moved, markers, tracks };
}

/** What changed from `a` (older) to `b` (newer). */
export function diffDocs(a: ProjectDoc, b: ProjectDoc): DocDiff {
  const ta = new Map(a.timelines.map((t) => [t.id, t]));
  const tb = new Map(b.timelines.map((t) => [t.id, t]));
  const timelines = [...tb.values()].filter((t) => ta.has(t.id)).map((t) => diffTimeline(ta.get(t.id)!, t)).filter((d) => d.added || d.removed || d.changed || d.moved || d.markers || d.tracks);
  const ma = new Map(a.media.map((m) => [m.id, m]));
  const mb = new Map(b.media.map((m) => [m.id, m]));
  const settings = (Object.keys({ ...a.settings, ...b.settings }) as (keyof ProjectDoc["settings"])[]).filter((k) => canon(a.settings[k]) !== canon(b.settings[k]));
  return {
    timelinesAdded: [...tb.values()].filter((t) => !ta.has(t.id)).map((t) => t.name),
    timelinesRemoved: [...ta.values()].filter((t) => !tb.has(t.id)).map((t) => t.name),
    timelines,
    mediaAdded: [...mb.values()].filter((m) => !ma.has(m.id)).map((m) => m.name),
    mediaRemoved: [...ma.values()].filter((m) => !mb.has(m.id)).map((m) => m.name),
    settings,
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The diff as short lines for the list. Empty when the two are the same. */
export function describeDiff(d: DocDiff): string[] {
  const out: string[] = [];
  for (const n of d.timelinesAdded) out.push(`Timeline "${n}" added`);
  for (const n of d.timelinesRemoved) out.push(`Timeline "${n}" removed`);
  for (const t of d.timelines) {
    const bits = [t.added && `${plural(t.added, "clip")} added`, t.removed && `${plural(t.removed, "clip")} removed`, t.moved && `${t.moved} moved`, t.changed && `${t.changed} changed`, t.markers && plural(t.markers, "marker change"), t.tracks && plural(t.tracks, "track change")].filter(Boolean);
    out.push(`"${t.name}": ${bits.join(", ")}`);
  }
  if (d.mediaAdded.length) out.push(`Media added: ${d.mediaAdded.slice(0, 4).join(", ")}${d.mediaAdded.length > 4 ? ", ..." : ""}`);
  if (d.mediaRemoved.length) out.push(`Media removed: ${d.mediaRemoved.slice(0, 4).join(", ")}${d.mediaRemoved.length > 4 ? ", ..." : ""}`);
  if (d.settings.length) out.push(`Settings changed: ${d.settings.join(", ")}`);
  return out;
}

/* ---------- storage ---------- */

export type VersionBackend = {
  read: (projectId: string) => Promise<Snapshot[]>;
  write: (projectId: string, list: Snapshot[]) => Promise<boolean>;
};

export const memoryVersionBackend = (): VersionBackend => {
  const m = new Map<string, string>();
  return { read: async (id) => JSON.parse(m.get(id) ?? "[]"), write: async (id, l) => (m.set(id, JSON.stringify(l)), true) };
};

/** Versions of a project live in the browser file store, next to its media. */
export const fileVersionBackend = (): VersionBackend => ({
  read: async (id) => {
    const { getFile } = await import("./filestore");
    const f = await getFile(`${id}/versions.json`);
    if (!f) return [];
    try {
      const raw = JSON.parse(await f.text());
      return Array.isArray(raw) ? raw.filter((s) => s && typeof s.json === "string" && typeof s.at === "number") : [];
    } catch {
      return [];
    }
  },
  write: async (id, list) => {
    try {
      const { putFile } = await import("./filestore");
      await putFile(`${id}/versions.json`, new Blob([JSON.stringify(list)], { type: "application/json" }), "versions.json");
      return true;
    } catch {
      return false;
    }
  },
});
