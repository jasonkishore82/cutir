import { loadDoc, serializeDoc } from "../../model/migrate";
import type { ProjectDoc } from "../../model/types";
import { entryIsIntact, readZip, writeZip, type PackEntry, type ZipItem } from "./zipfile";

/**
 * Project package (phase 29): one zip with the project, its media pool and every media file, for backup and for moving
 * to another machine. Layout: cutir-package.json (manifest), project.json, media.json, bins.json, media/<itemId>.
 * The zip's own CRCs are the integrity check; reading verifies the project file and, on request, every file.
 */

export const PACKAGE_FORMAT = "cutir-package";
export const PACKAGE_VERSION = 1;

export type PoolItem = { id: string; name: string; size?: number; mime?: string; storage?: "copy" | "link"; [k: string]: unknown };

export type PackageInput = {
  name: string;
  doc: ProjectDoc;
  items: PoolItem[];
  bins: unknown[];
  /** The file of a pool item, or null when it cannot be read (a linked original that moved, no permission). */
  readFile: (item: PoolItem) => Promise<Blob | null>;
  /** The files the project itself points at (the song and background of a lyric video), by their file key. */
  readSlot?: (fileKey: string) => Promise<Blob | null>;
  onProgress?: (done: number, total: number) => void;
};

export type Manifest = { format: typeof PACKAGE_FORMAT; version: number; createdAt: number; name: string; files: { id: string; name: string; size: number }[]; missing: string[] };

const json = (v: unknown) => new Blob([typeof v === "string" ? v : JSON.stringify(v)], { type: "application/json" });

export async function buildPackage(input: PackageInput): Promise<{ blob: Blob; missing: string[]; bytes: number }> {
  const files: Manifest["files"] = [];
  const missing: string[] = [];
  const entries: PackEntry[] = [];
  for (const it of input.items) {
    const blob = await input.readFile(it);
    if (!blob) {
      missing.push(it.name);
      continue;
    }
    files.push({ id: it.id, name: it.name, size: blob.size });
    entries.push({ name: `media/${it.id}`, blob });
  }
  for (const m of input.doc.media) {
    if (!m.fileKey || !input.readSlot) continue;
    const blob = await input.readSlot(m.fileKey);
    if (blob) entries.push({ name: `slot/${m.fileKey}`, blob });
    else missing.push(m.name);
  }
  const manifest: Manifest = { format: PACKAGE_FORMAT, version: PACKAGE_VERSION, createdAt: Date.now(), name: input.name, files, missing };
  const clean: ProjectDoc = { ...input.doc, media: input.doc.media.map(({ url: _u, ...m }) => m) };
  // linked originals are copied into the package, so on the other machine they are ordinary copies
  const items = input.items.map((i) => (i.storage === "link" ? { ...i, storage: "copy" } : i));
  const head: PackEntry[] = [
    { name: "cutir-package.json", blob: json(manifest) },
    { name: "project.json", blob: json(serializeDoc(clean)) },
    { name: "media.json", blob: json(items) },
    { name: "bins.json", blob: json(input.bins) },
  ];
  const blob = await writeZip([...head, ...entries], input.onProgress);
  return { blob, missing, bytes: blob.size };
}

export type OpenedPackage = {
  manifest: Manifest;
  doc: ProjectDoc;
  items: PoolItem[];
  bins: unknown[];
  /** Pool item id -> the file entry. */
  files: Map<string, ZipItem>;
  /** File key -> the file of a project media reference. */
  slots: Map<string, ZipItem>;
  /** Names of files that are damaged (only when verified). */
  damaged: string[];
};

export async function openPackage(zip: Blob, opts: { verify?: boolean } = {}): Promise<OpenedPackage> {
  const entries = await readZip(zip);
  const get = (n: string) => entries.find((e) => e.name === n);
  const man = get("cutir-package.json");
  const proj = get("project.json");
  if (!man || !proj) throw new Error("This zip is not a Cutir project package.");
  if (!(await entryIsIntact(man)) || !(await entryIsIntact(proj))) throw new Error("The package is damaged: its project data does not match its checksum.");
  const manifest = JSON.parse(await (await man.read()).text()) as Manifest;
  if (manifest.format !== PACKAGE_FORMAT) throw new Error("This zip is not a Cutir project package.");
  if (manifest.version > PACKAGE_VERSION) throw new Error("This package was made by a newer version of Cutir. Update the app to open it.");
  const { doc } = loadDoc(await (await proj.read()).text());
  const read = async <T,>(n: string, fallback: T): Promise<T> => {
    const e = get(n);
    try {
      return e ? (JSON.parse(await (await e.read()).text()) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const items = await read<PoolItem[]>("media.json", []);
  const bins = await read<unknown[]>("bins.json", []);
  const files = new Map<string, ZipItem>();
  const slots = new Map<string, ZipItem>();
  const damaged: string[] = [];
  for (const e of entries) {
    const isMedia = e.name.startsWith("media/");
    if (!isMedia && !e.name.startsWith("slot/")) continue;
    const id = e.name.slice(isMedia ? 6 : 5);
    (isMedia ? files : slots).set(id, e);
    if (opts.verify && !(await entryIsIntact(e))) damaged.push(isMedia ? (items.find((i) => i.id === id)?.name ?? id) : (doc.media.find((m) => m.fileKey === id)?.name ?? id));
  }
  return { manifest, doc, items, bins, files, slots, damaged };
}
