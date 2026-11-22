import { z } from "zod";
import { defineTool } from "./registry";
import { num } from "./schema";
import { activeTimeline, docToView } from "../../model/convert";
import type { ProjectDoc, Timeline } from "../../model/types";
import * as E from "../../timeline/engine";
import { linesOfLayer, uid, useProject, type Layer, type Project } from "../../store/project";
import { activeConfig } from "../../store/settings";
import { useDeliver } from "../../store/deliver";
import { useTimelineUi } from "../../timeline/ui";
import { BUILTIN_PRESETS } from "../deliver/presets";
import { cutDoc, linesToCues, withLayerCues } from "../captions/ops";
import { LANGUAGES, languageName, translateCues, withTranslation } from "../captions/translate";
import { captionLook, mediaUrl, transcribeTimeline } from "../captions/run";
import { totalOf, type Range } from "../captions/transcript";
import type { Cue } from "../captions/cues";
import { levelsFor } from "../ai/audioLevels";
import { planSilenceCuts } from "../ai/silence";
import { detectCuts, sampleDiffs, sceneTimes } from "../ai/scenes";
import { findMoments } from "../ai/moments";
import { DEFAULT_RULES } from "../captions/checks";

/**
 * Smart actions (phase 28): remove silences, cut to the beat, find moments in a transcript, detect scenes, make and
 * translate captions, export. Heavy work (decoding, sampling, a model) happens in `prepare`, before the single
 * undoable apply, exactly like auto_sync; the project only changes in `apply` / `applyDoc`.
 */

const tl = (doc: ProjectDoc) => activeTimeline(doc);
const on = (doc: ProjectDoc, fn: (t: Timeline) => Timeline) => E.onActive(doc, fn);
const sec = (n: number) => `${Math.round(n * 10) / 10}s`;

/* ---------- remove silences ---------- */

let pendingCuts: { ranges: Range[]; threshold: number } | null = null;

export const removeSilences = defineTool({
  name: "remove_silences",
  group: "smart",
  description: "Cut the pauses out of the video and the sound: every stretch of quiet longer than minLen is removed and the gap closes. Works from the sound itself, no transcript needed.",
  hint: "minLen = shortest pause in seconds (default 0.5); keep = silence left in each pause (default 0.1); threshold = dB, automatic when missing",
  params: z.object({
    minLen: num(0.1, 10).optional(),
    keep: num(0, 2).optional(),
    threshold: num(-90, -10).optional().describe("quiet below this many dB, e.g. -40"),
  }),
  normalize: (a) => {
    if (!a || typeof a !== "object") return a;
    const o = { ...(a as Record<string, unknown>) };
    for (const k of ["min", "min_length", "minLength", "longer_than", "longerThan", "duration", "seconds"]) if (k in o && !("minLen" in o)) o.minLen = o[k];
    return o;
  },
  prepare: async (a) => {
    const doc = useProject.getState().doc;
    const t = tl(doc);
    const ids = t.clips.filter((c) => c.mediaId && !c.fill && t.tracks.find((x) => x.id === c.trackId)?.kind === "audio").map((c) => c.mediaId!);
    if (!ids.length) throw new Error("there is no sound on the timeline to find pauses in");
    const levels = await levelsFor(doc, ids);
    pendingCuts = planSilenceCuts(t, levels, { minLen: a.minLen, keep: a.keep, threshold: a.threshold });
  },
  applyDoc: (doc, a) => {
    const plan = pendingCuts;
    pendingCuts = null;
    if (!plan) throw new Error("the sound was not analysed");
    if (!plan.ranges.length) return { doc, summary: `no pause longer than ${a.minLen ?? 0.5}s found (quiet below ${Math.round(plan.threshold)} dB)` };
    return { doc: cutDoc(doc, plan.ranges, { picture: true }), summary: `cut ${plan.ranges.length} pause${plan.ranges.length === 1 ? "" : "s"}, ${sec(totalOf(plan.ranges))} shorter (quiet below ${Math.round(plan.threshold)} dB)` };
  },
});

/* ---------- cut to the beat ---------- */

export const cutToBeats = defineTool({
  name: "cut_to_beats",
  group: "smart",
  description: "Cut the video on the beat: a cut at every beat (or every 2nd, 4th... beat) between two times. Needs beats (detect_beats).",
  hint: "every = cut on every Nth beat (default 4, one bar); from/to = seconds (default the whole timeline)",
  params: z.object({ every: z.coerce.number().int().min(1).max(32).default(4), from: num(0, 36000).optional(), to: num(0, 36000).optional() }),
  applyDoc: (doc, a) => {
    const t = tl(doc);
    const beats = t.markers.filter(E_isBeat).sort((x, y) => x.time - y.time);
    if (!beats.length) throw new Error("there are no beats yet; run detect_beats first");
    const lo = a.from ?? 0;
    const hi = a.to ?? E.timelineEnd(t);
    const times = beats.filter((_, i) => i % a.every === 0).map((m) => m.time).filter((x) => x > lo + 0.05 && x < hi - 0.05).slice(0, 400);
    if (!times.length) throw new Error("no beat falls in that range");
    let next = doc;
    for (const x of times) next = on(next, (y) => E.blade(y, x));
    return { doc: next, summary: `cut at ${times.length} beat${times.length === 1 ? "" : "s"} (every ${a.every === 1 ? "beat" : `${a.every} beats`})` };
  },
});
const E_isBeat = (m: { kind?: string }) => m.kind === "beat";

/* ---------- find moments in a transcript ---------- */

function captionLayer(p: Project, ref?: string): Layer {
  const k = ref?.trim().toLowerCase();
  const l = (k && (p.layers.find((x) => x.id === ref) ?? p.layers.find((x) => x.name.toLowerCase().includes(k)))) || p.layers.find((x) => linesOfLayer(p, x.id).length) || p.layers[0];
  if (!l) throw new Error("there are no captions; make them first (generate_captions)");
  return l;
}

export const findMomentsTool = defineTool({
  name: "find_moments",
  group: "smart",
  description: "Find where something is said in the captions and put a marker on each moment. Matches the words of query; put a phrase in quotes for an exact match.",
  hint: "query = what to look for; layer = caption track (default the first with captions)",
  params: z.object({ query: z.string().min(1), layer: z.string().optional(), max: z.coerce.number().int().min(1).max(40).default(12) }),
  applyDoc: (doc, a) => {
    const view = docToView(doc);
    const layer = captionLayer(view, a.layer);
    const cues = linesToCues(linesOfLayer(view, layer.id));
    if (!cues.length) throw new Error(`"${layer.name}" has no captions to search; generate captions first`);
    const found = findMoments(cues, a.query, a.max);
    if (!found.length) return { doc, summary: `nothing in the captions matches "${a.query}"` };
    let next = doc;
    for (const m of found) {
      const label = m.text.length > 40 ? `${m.text.slice(0, 40)}...` : m.text;
      next = on(next, (x) => E.addMarker(x, m.start, { name: label, color: "#38bdf8", note: m.text }).tl);
    }
    return { doc: next, summary: `${found.length} moment${found.length === 1 ? "" : "s"} marked: ${found.slice(0, 5).map((m) => sec(m.start)).join(", ")}${found.length > 5 ? "..." : ""}` };
  },
});

/* ---------- detect scenes ---------- */

let pendingScenes: number[] | null = null;

export const detectScenes = defineTool({
  name: "detect_scenes",
  group: "smart",
  description: "Find the scene changes in the video clips (the selected ones, or all) and put a marker on each. Changes nothing else.",
  hint: "sensitivity 0-1 (default 0.5, higher finds more); minGap = shortest scene in seconds",
  params: z.object({ sensitivity: num(0, 1).optional(), minGap: num(0.2, 30).optional(), clips: z.array(z.string()).optional() }),
  prepare: async (a) => {
    const doc = useProject.getState().doc;
    const t = tl(doc);
    const pick = a.clips?.length ? a.clips : useTimelineUi.getState().selected;
    let clips = t.clips.filter((c) => c.mediaId && !c.fill && doc.media.find((m) => m.id === c.mediaId)?.kind === "video" && t.tracks.find((x) => x.id === c.trackId)?.kind === "video");
    if (pick.length) clips = clips.filter((c) => pick.includes(c.id));
    if (!clips.length) throw new Error("there is no video clip to look at");
    const all: number[] = [];
    const seen = new Set<string>();
    for (const c of clips.slice(0, 20)) {
      const url = mediaUrl(doc, c.mediaId!);
      if (!url) throw new Error(`${doc.media.find((m) => m.id === c.mediaId)?.name ?? "a clip"} is not open yet; open it from the media library first`);
      const span = c.sourceOut - c.sourceIn;
      const step = Math.max(0.25, span / 1200);
      const diffs = await sampleDiffs(url, c.sourceIn, c.sourceOut, step);
      const cuts = detectCuts(diffs, step, { sensitivity: a.sensitivity, minGap: a.minGap });
      for (const x of sceneTimes(c, cuts.map((i) => c.sourceIn + i * step))) {
        const key = x.toFixed(2);
        if (!seen.has(key)) (seen.add(key), all.push(x));
      }
    }
    pendingScenes = all.sort((x, y) => x - y);
  },
  applyDoc: (doc) => {
    const times = pendingScenes;
    pendingScenes = null;
    if (!times) throw new Error("the video was not analysed");
    if (!times.length) return { doc, summary: "no scene changes found" };
    let n = 0;
    const next = on(doc, (x) => {
      let y = x;
      for (const time of times) y = E.addMarker(y, time, { name: `Scene ${++n}`, color: "#f59e0b" }).tl;
      return y;
    });
    return { doc: next, summary: `${times.length} scene change${times.length === 1 ? "" : "s"} marked: ${times.slice(0, 5).map(sec).join(", ")}${times.length > 5 ? "..." : ""}` };
  },
});

/* ---------- captions: make and translate ---------- */

let pendingCaptions: { cues: Cue[]; language?: string } | null = null;

export const generateCaptions = defineTool({
  name: "generate_captions",
  group: "smart",
  description: "Make captions from the speech on the timeline (speech to text, with the engine chosen in the Captions panel).",
  hint: "language = code like en, es (default: the Captions panel setting, or automatic)",
  params: z.object({ language: z.string().optional() }),
  prepare: async (a) => {
    pendingCaptions = await transcribeTimeline({ language: a.language });
  },
  apply: (p) => {
    const r = pendingCaptions;
    pendingCaptions = null;
    if (!r) throw new Error("nothing was transcribed");
    const id = uid();
    const name = r.language ? `Captions (${languageName(r.language)})` : "Captions";
    const project = withLayerCues(p, id, r.cues, { name, lang: r.language, visible: true, locked: false, style: captionLook() });
    return { project, summary: `${r.cues.length} captions made${r.language ? ` (${languageName(r.language)})` : ""}` };
  },
});

let pendingTranslation: { name: string; lang: string; cues: Cue[]; style?: Layer["style"] } | null = null;

const langOf = (ref: string) => {
  const k = ref.trim().toLowerCase();
  return LANGUAGES.find((l) => l.code === k) ?? LANGUAGES.find((l) => l.name.toLowerCase() === k) ?? LANGUAGES.find((l) => l.name.toLowerCase().startsWith(k));
};

export const translateCaptions = defineTool({
  name: "translate_captions",
  group: "smart",
  description: "Translate a caption track into another language as a new track with the same timing, using the AI provider chosen in Settings.",
  hint: `to = language name or code (${LANGUAGES.slice(0, 8).map((l) => l.code).join(", ")}...); layer = the track to translate (default the first with captions)`,
  params: z.object({ to: z.string().min(1), layer: z.string().optional() }),
  prepare: async (a) => {
    const p = useProject.getState().project;
    const lang = langOf(a.to);
    if (!lang) throw new Error(`unknown language "${a.to}"`);
    const layer = captionLayer(p, a.layer);
    const cues = linesToCues(linesOfLayer(p, layer.id));
    if (!cues.length) throw new Error(`"${layer.name}" has no captions to translate`);
    const out = await translateCues(activeConfig(), cues, lang.code, { from: layer.lang });
    pendingTranslation = { name: lang.name, lang: lang.code, cues: withTranslation(cues, out, DEFAULT_RULES), style: layer.style };
  },
  apply: (p) => {
    const r = pendingTranslation;
    pendingTranslation = null;
    if (!r) throw new Error("nothing was translated");
    const id = uid();
    return { project: withLayerCues(p, id, r.cues, { name: r.name, lang: r.lang, visible: true, locked: false, ...(r.style ? { style: r.style } : {}) }), summary: `${r.cues.length} captions translated into ${r.name}` };
  },
});

/* ---------- export ---------- */

export const exportVideo = defineTool({
  name: "export_video",
  group: "smart",
  effect: true,
  description: `Add the timeline to the render queue with a preset (${BUILTIN_PRESETS.map((p) => p.id).join(", ")}). The file downloads when the render finishes.`,
  hint: "preset = id above (default youtube-1080); range = whole, inout or selection",
  params: z.object({ preset: z.string().default("youtube-1080"), range: z.enum(["whole", "inout", "selection"]).default("whole") }),
  prepare: async (a) => {
    const k = a.preset.trim().toLowerCase();
    const store = useDeliver.getState();
    const preset = [...BUILTIN_PRESETS, ...store.custom].find((p) => p.id === k || p.name.toLowerCase() === k) ?? BUILTIN_PRESETS.find((p) => p.id.includes(k) || p.name.toLowerCase().includes(k));
    if (!preset) throw new Error(`no preset "${a.preset}". Presets: ${BUILTIN_PRESETS.map((p) => p.id).join(", ")}`);
    const t = tl(useProject.getState().doc);
    const range = a.range === "inout" && t.inPoint === undefined && t.outPoint === undefined ? "whole" : a.range;
    const jobs = store.add({ preset, range, start: t.inPoint, end: t.outPoint, source: "original" });
    if (!jobs.length) throw new Error("there is nothing to export");
    return `queued "${jobs[0].name}" in the render queue (Deliver page)`;
  },
});

export const smartTools = [removeSilences, cutToBeats, findMomentsTool, detectScenes, generateCaptions, translateCaptions, exportVideo];
