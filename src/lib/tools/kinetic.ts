import { z } from "zod";
import { defineTool } from "./registry";
import { bool, color, idx, num } from "./schema";
import { lineAt, round2, wordAt } from "./helpers";
import { editProjectStyle, type Target } from "../styleEdit";
import { EFFECTS } from "../animations";
import { ensureFont, titleCaseFont } from "../fonts";
import { applyAutoEmphasis } from "../emphasis";
import { analyzeBeats, applyBeatResult, manualBeats, type BeatResult } from "../beats";
import { findLayer } from "../../store/layers";
import { DEFAULT_BEAT, layerIdOf, lineWords, resolveStyle, setWordOverride, useProject, type BeatName, type EffectName, type LyricLine, type Project, type StyleOverride, type WordOverride } from "../../store/project";
import { activeTimeline, IDS } from "../../model/convert";
import { useMedia } from "../../store/media";

/**
 * Kinetic tools (phase 16.5): single words as objects, emphasis levels, beat reactions, energy and beats.
 * Lines are 1-based like every line tool; words are 1-based within a line, or given as the word's text.
 */

/* ---------- shared argument repair ---------- */

/** Lower-case keys, rename aliases, drop null / empty values; "all" for lines means every line. */
function tidy(args: unknown, renames: Record<string, string> = {}): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return (args ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const key = k.toLowerCase().replace(/[\s-]+/g, "_");
    const to = renames[key] ?? key;
    if (v !== null && v !== "") out[to] = v;
  }
  for (const k of ["lines", "index", "layer"]) if (typeof out[k] === "string" && /^(all|every|\*|project)/i.test(out[k] as string)) delete out[k];
  return out;
}

const LINE_KEYS = { line: "index", line_index: "index", lineindex: "index", line_number: "index", n: "index" };

/** "1,3" / 2 / [1, "3"] -> [1, 3] */
const lineList = z
  .union([z.array(z.union([z.number(), z.string()])), z.number(), z.string()])
  .transform((v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : [v]).map(Number))
  .pipe(z.array(z.number().int().min(1)).min(1))
  .describe("1-based line numbers; leave out for all lines");

const layerRef = z.union([z.string(), z.number()]).describe("layer name or number");

/** Where a style change goes: given lines, a layer, or the project (every line). */
function scopeOf(p: Project, a: { lines?: number[]; layer?: string | number }): { target: Target; who: string } {
  if (a.lines?.length) return { target: { scope: "line", ids: a.lines.map((n) => lineAt(p, n).id) }, who: `line${a.lines.length > 1 ? "s" : ""} ${a.lines.join(", ")}` };
  if (a.layer !== undefined) {
    const layer = findLayer(p, a.layer);
    if (!layer) throw new Error(`layer "${a.layer}" does not exist (layers: ${p.layers.map((l, i) => `${i + 1} ${l.name}`).join(", ")})`);
    return { target: { scope: "layer", layerId: layer.id }, who: `layer ${layer.name}` };
  }
  return { target: { scope: "project" }, who: "all lines" };
}

const replaceLine = (p: Project, line: LyricLine): Project => ({ ...p, lines: p.lines.map((l) => (l.id === line.id ? line : l)) });

/* ---------- words ---------- */

const wordRef = z.union([z.number(), z.string().min(1)]).describe("1-based word number in the line, or the word itself");

const EFFECT_NAMES = Object.keys(EFFECTS) as EffectName[];
function toEffect(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if ((EFFECT_NAMES as string[]).includes(k)) return k;
  const words: Record<string, EffectName> = { spin: "rotate", bounce: "pop", grow: "zoom", slide: "slide-up", rise: "slide-up", drop: "slide-down", appear: "fade", typing: "typewriter", off: "none", cut: "none" };
  return words[k] ?? k;
}
const Effect = z.enum(EFFECT_NAMES as [EffectName, ...EffectName[]]);

export const setWordStyle = defineTool({
  name: "set_word_style",
  group: "kinetic",
  description:
    "Style ONE word of a line on its own: colour, emphasis level, size, nudge, tilt, font and its own entrance/exit. Everything not given keeps following the line. reset=true puts the word back to the line's look.",
  hint: "word = 1-based word number or the word text; scale 1 = normal; x,y = nudge in percent of the frame; rotation in degrees; emphasis 0-3; in/out = effect names like the animation tools",
  params: z.object({
    index: idx.describe("1-based line number"),
    word: wordRef,
    color: color.optional(),
    emphasis: z.coerce.number().int().min(0).max(3).optional(),
    scale: num(0.1, 8).optional(),
    x: num(-100, 100).optional().describe("nudge across, percent of width"),
    y: num(-100, 100).optional().describe("nudge down, percent of height"),
    rotation: num(-360, 360).optional(),
    font: z.string().min(1).optional(),
    in: Effect.optional(),
    out: Effect.optional(),
    reset: bool.optional(),
  }),
  normalize: (a) => {
    const o = tidy(a, { ...LINE_KEYS, word_index: "word", text: "word", colour: "color", size: "scale", angle: "rotation", degrees: "rotation", font_family: "font", fontfamily: "font", level: "emphasis", animation_in: "in", animation_out: "out", entrance: "in", exit: "out" });
    if ("in" in o) o.in = toEffect(o.in);
    if ("out" in o) o.out = toEffect(o.out);
    if (typeof o.scale === "string" && /%$/.test(o.scale)) o.scale = parseFloat(o.scale) / 100;
    if (typeof o.scale === "number" && o.scale > 8) o.scale = o.scale / 100;
    return o;
  },
  prepare: async (a) => {
    if (a.font) await ensureFont(a.font);
  },
  apply: (p, a) => {
    const line = lineAt(p, a.index);
    const w = wordAt(line, a.word);
    const text = lineWords(line.text)[w];
    if (a.reset) {
      const wo = { ...(line.wordOverrides ?? {}) };
      delete wo[w];
      const next: LyricLine = { ...line, wordOverrides: wo };
      if (!Object.keys(wo).length) delete next.wordOverrides;
      return { project: replaceLine(p, next), summary: `line ${a.index}: "${text}" back to the line's look` };
    }
    const cur: WordOverride = line.wordOverrides?.[w] ?? {};
    const patch: Partial<WordOverride> = {};
    const changed: string[] = [];
    let style: StyleOverride | undefined = cur.style;
    if (a.color) (style = { ...style, color: a.color }), changed.push(`colour ${a.color}`);
    if (a.font) (style = { ...style, fontFamily: titleCaseFont(a.font) }), changed.push(`font ${titleCaseFont(a.font)}`);
    if (a.in || a.out) {
      const anim = { ...style?.animation };
      if (a.in) (anim.in = { ...anim.in, name: a.in }), changed.push(`in ${a.in}`);
      if (a.out) {
        if (!EFFECTS[a.out].out) throw new Error(`${a.out} can only be an entrance`);
        anim.out = { ...anim.out, name: a.out };
        changed.push(`out ${a.out}`);
      }
      style = { ...style, animation: anim };
    }
    if (style !== cur.style) patch.style = style;
    if (a.scale !== undefined || a.x !== undefined || a.y !== undefined || a.rotation !== undefined) {
      const t = { ...cur.transform };
      if (a.scale !== undefined) (t.scale = a.scale), changed.push(`scale ${a.scale}`);
      if (a.x !== undefined) (t.x = a.x / 100), changed.push(`x ${a.x}%`);
      if (a.y !== undefined) (t.y = a.y / 100), changed.push(`y ${a.y}%`);
      if (a.rotation !== undefined) (t.rotation = a.rotation), changed.push(`rotation ${a.rotation}`);
      patch.transform = t;
    }
    if (a.emphasis !== undefined) (patch.emphasis = a.emphasis as WordOverride["emphasis"]), changed.push(`emphasis ${a.emphasis}`);
    if (!changed.length) throw new Error("nothing to change: give color, emphasis, scale, x, y, rotation, font, in or out (or reset)");
    return { project: replaceLine(p, setWordOverride(line, w, patch)), summary: `line ${a.index}, "${text}": ${changed.join(", ")}` };
  },
});

export const emphasizeWords = defineTool({
  name: "emphasize_words",
  group: "kinetic",
  description: "Make key words of a line stand out with an emphasis level (1 mild, 2 strong, 3 strongest; 0 = back to normal). Each level's look is shared by every word at that level.",
  hint: "words = list of word numbers (1-based) or word texts; level 0-3",
  params: z.object({
    index: idx.describe("1-based line number"),
    words: z.union([z.array(wordRef), wordRef]).transform((v) => (Array.isArray(v) ? v : [v])),
    level: z.coerce.number().int().min(0).max(3).default(2),
  }),
  normalize: (a) => {
    const o = tidy(a, { ...LINE_KEYS, word: "words", emphasis: "level", strength: "level" });
    // "love, fire" as one string means two words
    if (typeof o.words === "string" && /,/.test(o.words)) o.words = o.words.split(/\s*,\s*/).filter(Boolean);
    return o;
  },
  apply: (p, a) => {
    let line = lineAt(p, a.index);
    const all = lineWords(line.text);
    const hit = a.words.map((w) => wordAt(line, w));
    for (const w of hit) line = setWordOverride(line, w, { emphasis: a.level as WordOverride["emphasis"] });
    const names = hit.map((w) => `"${all[w]}"`).join(", ");
    return { project: replaceLine(p, line), summary: a.level ? `line ${a.index}: ${names} at emphasis ${a.level}` : `line ${a.index}: emphasis cleared on ${names}` };
  },
});

export const autoEmphasis = defineTool({
  name: "auto_emphasis",
  group: "kinetic",
  description: "Pick the key words of each line automatically (held notes, long words, hook words; never filler words) and give them emphasis levels. Replaces earlier emphasis on those lines.",
  params: z.object({ lines: lineList.optional() }),
  normalize: (a) => tidy(a, { index: "lines", line: "lines" }),
  apply: (p, a) => {
    const ids = a.lines?.map((n) => lineAt(p, n).id);
    const project = applyAutoEmphasis(p, ids);
    const n = project.lines.reduce((s, l) => s + Object.values(l.wordOverrides ?? {}).filter((o) => o.emphasis).length, 0);
    return { project, summary: `auto emphasis on ${a.lines ? `line${a.lines.length > 1 ? "s" : ""} ${a.lines.join(", ")}` : "all lines"} (${n} emphasised word${n === 1 ? "" : "s"} in the project)` };
  },
});

/* ---------- beat reaction and energy ---------- */

const BEAT_NAMES: BeatName[] = ["none", "pulse", "flash", "shake", "nudge", "colour-swap", "jump-cut"];
function toBeatName(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase().replace(/[\s_]+/g, "-").replace("color", "colour");
  if ((BEAT_NAMES as string[]).includes(k)) return k;
  if (/^(off|stop|nothing|no)$/.test(k)) return "none";
  if (/pulse|bounce|thump|punch|pump|throb|beat/.test(k)) return "pulse";
  if (/flash|strobe|blink|light/.test(k)) return "flash";
  if (/shake|jitter|rattle|vibrat/.test(k)) return "shake";
  if (/nudge|bump|kick|push/.test(k)) return "nudge";
  if (/swap|colou?r/.test(k)) return "colour-swap";
  if (/cut|jump/.test(k)) return "jump-cut";
  return k;
}

export const setBeatReaction = defineTool({
  name: "set_beat_reaction",
  group: "kinetic",
  description: "Make text react on every beat of the song (pulse, flash, shake, nudge, colour-swap, jump-cut; none = off). Big hits react more than soft ones. Needs beats (detect_beats).",
  hint: "effect one of none,pulse,flash,shake,nudge,colour-swap,jump-cut; strength 0-2 (1 = normal); downbeatsOnly = only the first beat of each bar; lines or layer, leave both out for all lines",
  params: z.object({
    effect: z.enum(BEAT_NAMES as [BeatName, ...BeatName[]]),
    strength: num(0, 2).optional(),
    downbeatsOnly: bool.optional(),
    lines: lineList.optional(),
    layer: layerRef.optional(),
  }),
  normalize: (a) => {
    const o = tidy(a, { name: "effect", reaction: "effect", type: "effect", beat: "effect", index: "lines", line: "lines", amount: "strength", intensity: "strength", downbeats_only: "downbeatsOnly", downbeatsonly: "downbeatsOnly", downbeats: "downbeatsOnly", on_downbeats: "downbeatsOnly" });
    if ("effect" in o) o.effect = toBeatName(o.effect);
    const s = typeof o.strength === "string" ? parseFloat(o.strength) : o.strength;
    if (typeof s === "number" && s > 2 && s <= 200) o.strength = s / 100;
    return o;
  },
  apply: (p, a) => {
    const { target, who } = scopeOf(p, a);
    // current values where this scope reads them, so unchanged fields stay as they are
    const first = target.scope === "line" ? p.lines.find((l) => l.id === target.ids[0]) : undefined;
    const cur = (first ? resolveStyle(p, first).animation.beat : p.style.animation.beat) ?? DEFAULT_BEAT;
    const slot = { name: a.effect, strength: a.strength ?? cur.strength ?? 1, downbeatsOnly: a.downbeatsOnly ?? cur.downbeatsOnly ?? false };
    const set: [string, unknown][] = [["animation.beat", slot]];
    const project = editProjectStyle(p, target, { set });
    const warn = a.effect !== "none" && !p.beats?.length ? " (no beats yet: run detect_beats so it has something to react to)" : "";
    return { project, summary: `${who}: beat ${a.effect}${a.effect !== "none" ? ` x${slot.strength}${slot.downbeatsOnly ? " on downbeats" : ""}` : ""}${warn}` };
  },
});

export const setEnergy = defineTool({
  name: "set_energy",
  group: "kinetic",
  description: "How much the song's loudness drives the motion: 0 = steady, 1 = calm in quiet parts and intense in loud choruses.",
  hint: "amount 0-1 (0.5 = half); lines or layer, leave both out for all lines",
  params: z.object({ amount: num(0, 1), lines: lineList.optional(), layer: layerRef.optional() }),
  normalize: (a) => {
    const o = tidy(a, { energy: "amount", value: "amount", level: "amount", strength: "amount", index: "lines", line: "lines" });
    const s = typeof o.amount === "string" ? parseFloat(o.amount) : o.amount;
    if (typeof s === "number" && s > 1 && s <= 100) o.amount = s / 100;
    return o;
  },
  apply: (p, a) => {
    const { target, who } = scopeOf(p, a);
    return { project: editProjectStyle(p, target, { set: [["energy", a.amount]] }), summary: `${who}: energy ${Math.round(a.amount * 100)}%` };
  },
});

/* ---------- beats ---------- */

const MIN_LEN = 0.1;
const EPS = 1e-6;

/** Nearest beat time to t (binary search over sorted times). */
function nearest(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(times[lo] - t) <= Math.abs(times[hi] - t) ? times[lo] : times[hi];
}

/**
 * Pure: lines with their edges moved to the nearest beat. A line stays at least 0.1 s long and never overlaps the
 * lines next to it on its layer; when snapping an edge would break that, the edge stays where it was.
 */
export function snapLinesToBeats(p: Project, ids: Set<string> | null, edges: "start" | "end" | "both", times: number[]): { project: Project; moved: number } {
  const next = new Map<string, LyricLine>();
  let moved = 0;
  for (const layer of p.layers) {
    const own = p.lines.filter((l) => layerIdOf(p, l) === layer.id).sort((a, b) => a.start - b.start);
    let prevEnd = -Infinity;
    own.forEach((l, i) => {
      if (ids && !ids.has(l.id)) {
        prevEnd = l.end;
        return;
      }
      const nextStart = own[i + 1] ? own[i + 1].start : Infinity;
      const s1 = edges !== "end" ? round2(nearest(times, l.start)) : l.start;
      const e1 = edges !== "start" ? round2(nearest(times, l.end)) : l.end;
      const ok = (s: number, e: number) => e - s >= MIN_LEN - EPS && s >= prevEnd - EPS && e <= nextStart + EPS;
      const [s, e] = ([[s1, e1], [s1, l.end], [l.start, e1]] as [number, number][]).find(([s, e]) => ok(s, e)) ?? [l.start, l.end];
      if (s !== l.start || e !== l.end) {
        moved++;
        next.set(l.id, { ...l, start: s, end: e });
      }
      prevEnd = e;
    });
  }
  return { project: { ...p, lines: p.lines.map((l) => next.get(l.id) ?? l) }, moved };
}

export const snapToBeats = defineTool({
  name: "snap_to_beats",
  group: "kinetic",
  description: "Move line starts and/or ends onto the nearest beat of the song, so lines appear and leave on the beat. Lines never overlap and stay at least 0.1 s long.",
  hint: "edges start|end|both (default start); downbeatsOnly = snap to the first beat of each bar; lines = 1-based numbers, leave out for all",
  params: z.object({
    lines: lineList.optional(),
    edges: z.enum(["start", "end", "both"]).default("start"),
    downbeatsOnly: bool.optional(),
  }),
  normalize: (a) => {
    const o = tidy(a, { index: "lines", line: "lines", edge: "edges", which: "edges", downbeats_only: "downbeatsOnly", downbeatsonly: "downbeatsOnly", downbeats: "downbeatsOnly" });
    if (typeof o.edges === "string") {
      const k = o.edges.toLowerCase();
      o.edges = /both|all|start.*end|end.*start/.test(k) ? "both" : /end|out|finish/.test(k) ? "end" : /start|begin|in/.test(k) ? "start" : k;
    }
    return o;
  },
  apply: (p, a) => {
    const beats = (p.beats ?? []).filter((b) => !a.downbeatsOnly || b.downbeat);
    if (!p.beats?.length) throw new Error("the project has no beats yet: run detect_beats first");
    if (!beats.length) throw new Error("no downbeats found: snap to every beat instead (downbeatsOnly false)");
    const ids = a.lines ? new Set(a.lines.map((n) => lineAt(p, n).id)) : null;
    const { project, moved } = snapLinesToBeats(p, ids, a.edges, beats.map((b) => b.time));
    return { project, summary: `snapped ${a.edges === "both" ? "starts and ends" : `${a.edges}s`} of ${moved} line${moved === 1 ? "" : "s"} to the ${a.downbeatsOnly ? "downbeats" : "beats"}` };
  },
});

// prepare() runs the (slow) analysis; applyDoc() then writes it as one undo step. They run back to back in applyCalls.
let pendingBeats: { mediaId: string; result: BeatResult } | null = null;

/** The document's song media entry (the lyric view's audio). */
function songMedia() {
  const doc = useProject.getState().doc;
  const id = activeTimeline(doc).clips.find((c) => c.id === IDS.audioClip)?.mediaId ?? IDS.audioMedia;
  return doc.media.find((m) => m.id === id);
}

/** The song's file: from the media library when it came from there, else the session's object URL. */
async function songBlob(m: { poolId?: string; url?: string }): Promise<Blob | null> {
  const pool = useMedia.getState();
  if (m.poolId && pool.items.some((i) => i.id === m.poolId)) {
    const f = await pool.fileOf(m.poolId);
    if (f) return f;
  }
  const url = m.url ?? useProject.getState().project.audio?.url;
  if (!url) return null;
  const res = await fetch(url).catch(() => null);
  return res && res.ok ? res.blob() : null;
}

export const detectBeats = defineTool({
  name: "detect_beats",
  group: "kinetic",
  description: "Find the tempo and every beat of the song and put the beats on the timeline (needed for beat reactions and snap_to_beats). Give tempo (and firstDownbeat) to set them by hand when detection gets a song wrong.",
  hint: "no arguments to detect; or tempo in BPM and firstDownbeat in seconds for a steady grid",
  params: z.object({
    tempo: num(30, 300).optional().describe("beats per minute, to set the grid by hand"),
    firstDownbeat: num(0, 600).optional().describe("seconds to the first downbeat (with tempo)"),
    beatsPerBar: z.coerce.number().int().min(1).max(12).optional(),
  }),
  normalize: (a) => tidy(a, { bpm: "tempo", offset: "firstDownbeat", first_downbeat: "firstDownbeat", firstdownbeat: "firstDownbeat", downbeat: "firstDownbeat", beats_per_bar: "beatsPerBar", beatsperbar: "beatsPerBar" }),
  prepare: async (a) => {
    pendingBeats = null;
    const song = songMedia();
    if (!song) throw new Error("add the song first (Audio, in the left panel)");
    // the pool id when there is one, so every timeline using the same file gets the beats
    const mediaId = song.poolId ?? song.id;
    if (a.tempo) {
      const duration = song.duration ?? 0;
      if (!(duration > 0)) throw new Error("the song's length is not known yet; wait for it to load");
      pendingBeats = { mediaId, result: manualBeats(a.tempo, a.firstDownbeat ?? 0, duration, a.beatsPerBar ?? 4) };
      return;
    }
    const blob = await songBlob(song);
    if (!blob) throw new Error("could not read the song file (open the project again or re-add the song)");
    pendingBeats = { mediaId, result: await analyzeBeats(blob) };
  },
  applyDoc: (doc) => {
    const r = pendingBeats;
    pendingBeats = null;
    if (!r) throw new Error("beat detection produced no result");
    const { beats, analysis } = r.result;
    const down = beats.filter((b) => b.downbeat).length;
    return { doc: applyBeatResult(doc, r.mediaId, r.result), summary: `found ${beats.length} beats at ${Math.round(analysis.tempo)} BPM (${down} downbeats${analysis.source === "manual" ? ", set by hand" : ""})` };
  },
});

export const kineticTools = [setWordStyle, emphasizeWords, autoEmphasis, setBeatReaction, setEnergy, snapToBeats, detectBeats];
