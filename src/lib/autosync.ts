import { create } from "zustand";
import { linesOfLayer, useProject, type LyricLine } from "../store/project";
import { DEFAULT_ALIGNER_URL, alignLines, type AlignProgress } from "./aligner";
import { activeTimeline } from "../model/convert";
import { useMedia } from "../store/media";
import type { ProjectDoc } from "../model/types";

/**
 * One shared auto-sync job. The left-panel button, the chat ("auto sync") and the auto_sync tool all run it,
 * so they all show the same progress and only one job runs at a time.
 */

export type SyncPhase = "idle" | "running" | "done";

type Job = {
  phase: SyncPhase;
  stage: AlignProgress["stage"];
  pct?: number; // 0..1 when the current stage can be measured
  separate: boolean;
};

export const useSyncJob = create<Job>(() => ({ phase: "idle", stage: "uploading", pct: undefined, separate: false }));

let abortCtl: AbortController | null = null;

const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};

/** Settings come from the Auto-sync options in the left panel (stored in localStorage). */
export function getAlignSettings() {
  return {
    url: read("cutir:alignerUrl", DEFAULT_ALIGNER_URL),
    language: read("cutir:alignLang", "en"),
    model: read("cutir:alignModel", "base"),
    separate: read("cutir:alignSeparate", "0") === "1",
  };
}

export type SyncOverrides = { language?: string; model?: string; separate?: boolean };

/**
 * The song to time the lyrics to: the project's own song, else the first audio clip on the timeline (a file added
 * from the media library). `url` is missing while a library file has not been opened this session; `poolId` then
 * lets `songFile` read it.
 */
export type SongSource = { name: string; url?: string; poolId?: string };
export function findSong(project: { audio?: { url?: string; name: string; mediaId?: string } }, doc: ProjectDoc, urls: Record<string, string>): SongSource | null {
  const a = project.audio;
  if (a?.url) return { name: a.name, url: a.url };
  if (a?.mediaId) return { name: a.name, url: urls[a.mediaId], poolId: a.mediaId };
  const tl = activeTimeline(doc);
  const clip = tl?.clips.filter((c) => c.mediaId && doc.media.find((m) => m.id === c.mediaId)?.kind === "audio").sort((x, y) => y.duration - x.duration)[0];
  const m = clip && doc.media.find((x) => x.id === clip.mediaId);
  if (!m) return null;
  return { name: m.name, url: m.url ?? (m.poolId ? urls[m.poolId] : undefined), poolId: m.poolId };
}

/** An object URL for the song, opening the library file if needed. */
async function songUrl(src: SongSource): Promise<string | null> {
  if (src.url) return src.url;
  if (!src.poolId) return null;
  const f = await useMedia.getState().fileOf(src.poolId);
  return f ? URL.createObjectURL(f) : null;
}

/** Align the current project's lyrics to its song. Returns the new lines; does NOT touch the project. */
export async function runAlignment(over: SyncOverrides = {}): Promise<{ lines: LyricLine[]; skippedTags: number }> {
  if (useSyncJob.getState().phase === "running") throw new Error("Auto-sync is already running.");
  const { project } = useProject.getState();
  const src = findSong(project, useProject.getState().doc, useMedia.getState().urls);
  const songSrc = src ? await songUrl(src) : null;
  if (!src || !songSrc) throw new Error("Upload the song first (Audio, in the left panel).");
  const main = linesOfLayer(project, project.layers[0].id); // only the main lyrics layer is timed to the song
  if (!main.length) throw new Error(`Add the lyrics first (layer "${project.layers[0].name}").`);

  const s = { ...getAlignSettings(), ...over };
  abortCtl = new AbortController();
  useSyncJob.setState({ phase: "running", stage: "uploading", pct: undefined, separate: s.separate });

  try {
    const result = await alignLines(
      s.url,
      { url: songSrc, name: src.name },
      main,
      { language: s.language, model: s.model, separate: s.separate },
      abortCtl.signal,
      (p) => useSyncJob.setState({ stage: p.stage, pct: p.pct })
    );
    useSyncJob.setState({ phase: "done", pct: 1 });
    setTimeout(() => useSyncJob.getState().phase === "done" && useSyncJob.setState({ phase: "idle" }), 1300);
    return result;
  } catch (e) {
    useSyncJob.setState({ phase: "idle" });
    throw (e as Error).name === "AbortError" ? new Error("Auto-sync cancelled.") : e;
  } finally {
    abortCtl = null;
  }
}

export const cancelAlignment = () => abortCtl?.abort();

/** "auto sync", "autosync", "sync the lyrics", "align my lyrics" ... (not "tap to sync") */
const INTENT = /\b(auto[\s-]?sync(?:ing)?|sync (?:my |the |these |all )?(?:lyrics|song|timings?|timing)|(?:auto[\s-]?)?align (?:my |the |these )?lyrics)\b/i;
export const isAutoSyncIntent = (text: string) => INTENT.test(text) && !/\btap\b/i.test(text);

/** "auto sync with vocal separation" -> separate: true; "...without separating" -> false */
export function syncOverridesFromText(text: string): SyncOverrides {
  const t = text.toLowerCase();
  if (/\b(without|no|skip)\b.{0,15}\b(separat|vocal|demucs)/.test(t)) return { separate: false };
  if (/\b(separat|isolate|demucs|vocals? only|with vocals?)/.test(t)) return { separate: true };
  return {};
}
