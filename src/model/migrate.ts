import { normalizeProject, type Project } from "../store/project";
import { docToView, viewToDoc } from "./convert";
import { SCHEMA_VERSION, type ProjectDoc } from "./types";

/**
 * Saved projects carry `schemaVersion`. Each version step has one migration function; loading runs them in order.
 *
 *   1  phases 1 to 10: { audio, background, layers, lines, style, aspect, fps, transition } (no schemaVersion field).
 *      Older shapes inside version 1 (one animation name, no layers...) are repaired by normalizeProject.
 *   2  this model: settings, media, bins, timelines with tracks and clips.
 */

type Raw = Record<string, unknown>;

/** Version of a parsed project file. Files from before versioning are version 1. */
export function versionOf(raw: unknown): number {
  if (raw && typeof raw === "object" && typeof (raw as Raw).schemaVersion === "number") return (raw as Raw).schemaVersion as number;
  return 1;
}

const MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
  // 1 -> 2: the song becomes an audio clip, the background a video (or generator) clip, layers subtitle tracks and
  // lines subtitle clips
  1: (raw) => viewToDoc(normalizeProject(raw as Partial<Project>)) as unknown as Raw,
};

/**
 * Bring a current-version document up to date with today's defaults (new style fields and so on) without losing
 * anything the lyric view does not cover.
 */
function refresh(doc: ProjectDoc): ProjectDoc {
  return viewToDoc(normalizeProject(docToView(doc)), doc);
}

export type Loaded = { doc: ProjectDoc; fromVersion: number };

/** Parse any saved project (object or JSON text) into the current model. Throws on files from a newer Cutir. */
export function loadDoc(input: unknown): Loaded {
  let raw = (typeof input === "string" ? JSON.parse(input) : input) as Raw;
  const fromVersion = versionOf(raw);
  if (fromVersion > SCHEMA_VERSION) throw new Error(`This project was saved by a newer version of Cutir (format ${fromVersion}).`);
  for (let v = fromVersion; v < SCHEMA_VERSION; v++) raw = MIGRATIONS[v](raw);
  return { doc: refresh(raw as unknown as ProjectDoc), fromVersion };
}

/** JSON for saving. Session-only object URLs are left out. */
export function serializeDoc(doc: ProjectDoc): string {
  return JSON.stringify({ ...doc, media: doc.media.map(({ url: _u, ...m }) => (void _u, m)) }, null, 2);
}
