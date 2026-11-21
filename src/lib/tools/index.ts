import { z } from "zod";
import { layerIdOf, lineWords, useProject, type Project } from "../../store/project";
import { createRegistry, toOllamaTool, toolSignature, type AnyTool, type ToolGroup } from "./registry";
import { lineTools } from "./lines";
import { styleTools } from "./style";
import { sceneTools } from "./scene";
import { syncTools } from "./sync";
import { captionTools } from "./captions";
import { layerTools } from "./layers";
import { animationTools, motionTools, transformTools } from "./motion";
import { timelineTools } from "./timeline";
import { withLineNumbers } from "./helpers";
import { effectTools } from "./effects";
import { kineticTools } from "./kinetic";
import { titleTools } from "./titles";
import { clipKeyTools } from "./clipKeys";
import { activeTimeline, IDS } from "../../model/convert";
import { useMedia } from "../../store/media";

/** The one list of tools. Add a tool to a group file; it is picked up everywhere from here. */
export const registry = createRegistry([...styleTools, ...animationTools, ...lineTools, ...layerTools, ...sceneTools, ...syncTools, ...transformTools, ...motionTools, ...timelineTools, ...titleTools, ...kineticTools, ...effectTools, ...clipKeyTools, ...captionTools]);

export const TOOL_NAMES = registry.all.map((t) => t.name);

/** Tool definitions in Ollama's format, generated from the zod schemas. Pass groups to send a subset. */
export const getOllamaTools = (groups?: ToolGroup[]) => registry.list(groups).map(toOllamaTool);
export const OLLAMA_TOOLS = getOllamaTools();

/** Words that bring in the placement tools (move / scale / rotate). */
const TRANSFORM_WORDS =
  /\b(move|moves|moving|put|place|position|top|bottom|left|right|corner|centre|center|middle|upper|lower|scale|resize|bigger|smaller|larger|size|rotate|rotated|tilt|tilted|angle|degrees?|turn|upside)\b/i;
/** Words that bring in keyframes, transitions and templates. */
const MOTION_WORDS =
  /\b(keyframes?|key ?frames?|motion|path|drift|fly|flies|flying|travel|glide|across|transitions?|crossfade|cross-fade|dissolve|push|zoom.?through|between (all |the )?lines|templates?|presets?|look|karaoke|neon|minimal|cinematic|bold caption|caption style)\b/i;

/** Words that bring in the timeline tools (clips on video and audio tracks, markers, in/out). */
const TIMELINE_WORDS =
  /\b(clips?|tracks?|video|footage|b-?roll|audio|sound|music|voice.?over|image|photo|titles?|lower.?third|credits?|picture|trim|ripple|blade|cut|split|marker|in.?point|out.?point|insert|overwrite|append|timeline|volume|mute|solo|library|media|effects?|blur|glow|vignette|shadow|mask|chroma|green.?screen|keying|invert|mirror|flip|noise|grain|pixel\w*|sharpen|crop|dissolve|wipe|dip|fade|transitions?|keyframes?|key ?frames?|animat\w*|ease|easing|ken ?burns|zoom|scale|rotat\w*|opacity|speed|slow\w*|reverse|ramp|freeze|compound|nested|version|vertical|matte|mixer|pan|loudness|multicam|angles?)\b/i;

/** Words that bring in the kinetic tools (single words, emphasis, beats, energy). */
const CAPTION_WORDS = /\b(captions?|subtitles?|transcri\w*|fillers?|filler words?|ums?|uhs?|pauses?|silences?|reading speed|safe area|burn(?:ed)?[- ]?in)\b/i;
const KINETIC_WORDS =
  /\b(beats?|bpm|tempo|rhythm|pulse|pulsing|flash|flashing|strobe|shake|drums?|kick|snare|downbeats?|on the beat|snap|emphasis|emphasi[sz]e[sd]?|emphasi[sz]ing|stress|key ?words?|highlight (the |a |one |that )?words?|energy|energetic|intense|loudness|kinetic|words?|hook)\b/i;

/**
 * Which tool groups to offer for this message. Fewer tools = better accuracy and a shorter prompt for small models.
 * Style (with the animation slots), line, scene and sync tools are always offered; the rest only when the request
 * mentions them (or, for layers, when the project has several).
 */
export function selectToolGroups(text: string, p: Project): ToolGroup[] {
  const groups: ToolGroup[] = ["style", "lines", "scene", "sync"];
  if (p.layers.length > 1 || /\b(layers?|tracks?|lanes?|translation|translate|subtitles?|overlay|credits?|caption)\b/i.test(text)) groups.push("layers");
  if (TRANSFORM_WORDS.test(text)) groups.push("transform");
  if (MOTION_WORDS.test(text)) groups.push("motion");
  if (TIMELINE_WORDS.test(text)) groups.push("timeline");
  if (KINETIC_WORDS.test(text)) groups.push("kinetic");
  if (CAPTION_WORDS.test(text)) groups.push("captions");
  return groups;
}

/* ---------- applying calls ---------- */

export type RawCall = { tool: string; args: unknown };
export type CallResult = { tool: string; args: unknown; ok: boolean; summary: string; noop?: boolean };

const fmtIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");

/**
 * Validate and apply every call as ONE undoable history step. Invalid calls are reported, valid ones still apply.
 * Async because some tools prepare resources first (e.g. downloading a font); that happens before any change is made.
 */
export async function applyCalls(calls: RawCall[]): Promise<{ results: CallResult[]; before: Project; after: Project }> {
  type Ready = { call: RawCall; def: AnyTool; data: unknown } | { call: RawCall; fail: string };

  // phase 1 (async): look up, repair, validate, prepare
  const ready: Ready[] = [];
  for (const call of calls) {
    const def = registry.get(call.tool);
    if (!def) {
      ready.push({ call, fail: `unknown tool "${call.tool}"` });
      continue;
    }
    let args = call.args;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args); // some models send arguments as a JSON string
      } catch {
        /* leave as is; validation will report it */
      }
    }
    if (def.normalize) args = def.normalize(args);
    const parsed = def.params.safeParse(args);
    if (!parsed.success) {
      ready.push({ call, fail: `${def.name}: ${fmtIssues(parsed.error)}` });
      continue;
    }
    try {
      await def.prepare?.(parsed.data);
    } catch (err) {
      ready.push({ call, fail: `${def.name}: ${(err as Error).message}` });
      continue;
    }
    ready.push({ call, def, data: parsed.data });
  }

  // phase 2 (sync): apply everything inside a single history step
  const store = useProject.getState();
  const before = store.project;
  const results: CallResult[] = [];
  store.batch(() => withLineNumbers(before.lines.map((l) => l.id), () => {
    for (const r of ready) {
      if ("fail" in r) {
        results.push({ ...r.call, ok: false, summary: r.fail });
        continue;
      }
      try {
        if (r.def.applyDoc) {
          // timeline and media edits work on the whole document
          const cur = useProject.getState().doc;
          const { doc, summary } = r.def.applyDoc(cur, r.data);
          if (doc === cur || JSON.stringify(doc) === JSON.stringify(cur)) {
            results.push({ ...r.call, ok: true, noop: true, summary: `${summary} (already so, unchanged)` });
            continue;
          }
          useProject.getState().editDoc(() => doc);
          results.push({ ...r.call, ok: true, summary });
          continue;
        }
        const current = useProject.getState().project;
        const { project, summary } = r.def.apply!(current, r.data);
        if (JSON.stringify(project) === JSON.stringify(current)) {
          results.push({ ...r.call, ok: true, noop: true, summary: `${summary} (already set, unchanged)` });
          continue;
        }
        useProject.getState().update(() => project);
        results.push({ ...r.call, ok: true, summary });
      } catch (err) {
        results.push({ ...r.call, ok: false, summary: `${r.def.name}: ${(err as Error).message}` });
      }
    }
  }));

  return { results, before, after: useProject.getState().project };
}

/* ---------- prompts ---------- */

const MAX_PROMPT_LINES = 120;

export function buildSystemPrompt(p: Project, fallbackJson: boolean, groups?: ToolGroup[]): string {
  const bg =
    p.background.type === "gradient"
      ? `gradient ${p.background.colors.join(",")} angle ${p.background.angle}`
      : `asset ${p.background.asset?.name ?? "(none)"}`;
  const shown = p.lines.slice(0, MAX_PROMPT_LINES);
  const multi = p.layers.length > 1;
  const layerName = (l: (typeof p.lines)[number]) => p.layers.find((x) => x.id === layerIdOf(p, l))?.name ?? "";
  const rows = shown
    .map((l, i) => `${i + 1} | ${multi ? `${layerName(l)} | ` : ""}${l.start.toFixed(2)}-${l.end.toFixed(2)} | ${l.text.slice(0, 70)}`)
    .join("\n");
  const more = p.lines.length > shown.length ? `\n(+${p.lines.length - shown.length} more lines)` : "";

  const parts = [
    "You are the assistant inside Cutir, a lyric video editor. ONLY call tools when the user asks to change the video. For greetings, thanks or questions, answer in one short sentence and do NOT call any tool. Questions about the project (how many lines, what a line says) are answered from the LINES list below: it is always the current project. When editing: one edit per call (several calls are fine), only change what was asked (to delete line 2, call delete_line once with index 2; never delete lines the user did not name), and never repeat values that are already set. Line numbers are 1-based and refer to the LINES list as it is now, for every call in your reply; times are seconds.",
    `Tools: ${registry.list(groups).map(toolSignature).join(", ")}.`,
    `STYLE: ${JSON.stringify(p.style)}`,
    `BACKGROUND: ${bg}`,
    `ASPECT: ${p.aspect}`,
    ...(multi
      ? [`LAYERS (drawn bottom to top): ${p.layers.map((l, i) => `${i + 1} ${l.name}${l.visible ? "" : " (hidden)"}${l.locked ? " (locked)" : ""}`).join(", ")}`]
      : []),
    `LINES (${p.lines.length} in total; ${multi ? "index | layer | start-end | text" : "index | start-end | text"}):\n${rows || "(none)"}${more}`,
  ];
  // timeline tools need the clip ids, tracks and library names
  if (groups?.includes("timeline")) {
    const doc = useProject.getState().doc;
    const tl = activeTimeline(doc);
    const tracks = tl.tracks.filter((t) => t.kind !== "subtitle").map((t) => `${t.name} (${t.kind}${t.target ? ", target" : ""}${t.locked ? ", locked" : ""}${t.muted ? ", muted" : ""})`);
    const clips = tl.clips
      .filter((c) => !c.fill && !c.text)
      .slice(0, 80)
      .map((c) => {
        const keyed = Object.entries(c.anim ?? {}).filter(([, k]) => k?.length).map(([n, k]) => `${n}:${k!.length}`);
        const fx = c.effects.map((f) => f.type + (Object.keys(f.keys ?? {}).length ? "(keyed)" : "")).join(",");
        return `${c.id} | ${tl.tracks.find((t) => t.id === c.trackId)?.name} | ${c.start.toFixed(2)}-${(c.start + c.duration).toFixed(2)} | ${doc.media.find((m) => m.id === c.mediaId)?.name ?? ""}${fx ? ` | fx ${fx}` : ""}${keyed.length ? ` | keys ${keyed.join(" ")}` : ""}`;
      });
    const media = useMedia.getState().items.slice(0, 60).map((i) => `${i.name} (${i.kind}${i.duration ? ` ${i.duration.toFixed(1)}s` : ""})`);
    parts.push(`TRACKS: ${tracks.join(", ") || "(none)"}`, `CLIPS (id | track | start-end | media):\n${clips.join("\n") || "(none)"}`, `MEDIA LIBRARY: ${media.join(", ") || "(empty)"}`);
  }
  if (groups?.includes("kinetic")) parts.push(kineticPrompt(p));
  if (fallbackJson) {
    parts.push(
      'Tools are unavailable. Reply with ONE ```json block containing {"actions":[{"tool":"<name>","args":{...}}]} and nothing else needed.'
    );
  }
  return parts.join("\n");
}

/** Beats, tempo and the words that already carry emphasis, for the kinetic tools. */
function kineticPrompt(p: Project): string {
  const doc = useProject.getState().doc;
  const song = doc.media.find((m) => m.id === activeTimeline(doc).clips.find((c) => c.id === IDS.audioClip)?.mediaId);
  const tempo = song?.analysis?.tempo;
  const beats = p.beats?.length
    ? `BEATS: ${p.beats.length} beats${tempo ? ` at ${Math.round(tempo)} BPM` : ""}; set_beat_reaction and snap_to_beats use them.`
    : "BEATS: none yet; call detect_beats before set_beat_reaction or snap_to_beats.";
  const emph = p.lines
    .slice(0, MAX_PROMPT_LINES)
    .map((l, i) => {
      const words = lineWords(l.text);
      const marked = Object.entries(l.wordOverrides ?? {}).filter(([, o]) => o.emphasis).map(([k, o]) => `${words[Number(k)] ?? k}=${o.emphasis}`);
      return marked.length ? `${i + 1}: ${marked.join(" ")}` : "";
    })
    .filter(Boolean);
  return `${beats} Words are numbered from 1 within a line (or name the word). Emphasis levels: 1 mild, 2 strong, 3 strongest, 0 normal; auto_emphasis picks them for you.${emph.length ? ` EMPHASIS (line: word=level): ${emph.join(", ")}` : ""}`;
}

const SMALL_TALK = /^\s*(hi+|hello+|hey+|hiya|yo|sup|howdy|thanks?|thank you|thx|ok(ay)?|cool|nice|great|good (morning|afternoon|evening|night)|bye|goodbye|how are you\??|who are you\??|what can you do\??|help)[\s!.?]*$/i;

/** Greetings and chit-chat: answer normally, no tools. Small models otherwise invent edits. */
export const isSmallTalk = (text: string) => SMALL_TALK.test(text);

export const CHAT_ONLY_PROMPT =
  "You are the assistant inside Cutir, a lyric video editor. Reply in one or two short friendly sentences. You can change text style, lyric lines and timings, backgrounds, animations and aspect ratio when asked. Do not claim to have changed anything.";

/** Index of the bracket that closes the one at `from` (string-aware), or -1. */
function matchBracket(s: string, from: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every JSON object/array embedded in free text (inside code fences, <tool_call> tags, or bare). */
function findJson(text: string): { value: unknown; start: number; end: number }[] {
  const found: { value: unknown; start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const end = matchBracket(text, i);
    if (end < 0) continue;
    try {
      found.push({ value: JSON.parse(text.slice(i, end + 1)), start: i, end: end + 1 });
      i = end; // skip past it; nested objects are part of this one
    } catch {
      /* not valid JSON starting here; keep scanning */
    }
  }
  return found;
}

/**
 * Turn the many shapes models use for a tool call into RawCalls:
 *   {"name":"set_aspect","arguments":{...}}      (Qwen / OpenAI style)
 *   {"tool":"set_aspect","args":{...}}           (our own JSON-reply format)
 *   {"function":{"name":...,"arguments":...}}    (Ollama tool_calls entries)
 *   {"actions":[...]} / {"tool_calls":[...]} / [ ... ]
 * Only names of registered tools count, so ordinary JSON in a reply is left alone.
 */
function toCalls(v: unknown): RawCall[] {
  if (Array.isArray(v)) return v.flatMap(toCalls);
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.actions)) return o.actions.flatMap(toCalls);
  if (Array.isArray(o.tool_calls)) return o.tool_calls.flatMap(toCalls);
  const fn = o.function && typeof o.function === "object" ? (o.function as Record<string, unknown>) : o;
  const name = fn.name ?? fn.tool;
  if (typeof name !== "string" || !registry.get(name)) return [];
  return [{ tool: name, args: fn.arguments ?? fn.parameters ?? fn.args ?? {} }];
}

/** Pull tool calls out of a model reply that wrote them as text. Returns the reply with the JSON removed. */
export function parseActionsFromText(text: string): { calls: RawCall[]; stripped: string } {
  const calls: RawCall[] = [];
  const cut: [number, number][] = [];
  for (const j of findJson(text)) {
    const c = toCalls(j.value);
    if (c.length) {
      calls.push(...c);
      cut.push([j.start, j.end]);
    }
  }
  if (!calls.length) return { calls: [], stripped: text };

  let stripped = "";
  let pos = 0;
  for (const [a, b] of cut) {
    stripped += text.slice(pos, a);
    pos = b;
  }
  stripped += text.slice(pos);
  // leftover wrappers around the removed JSON
  stripped = stripped
    .replace(/```(?:json)?\s*```/gi, "")
    .replace(/<\/?tool_call>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { calls, stripped };
}

/* ---------- guards for small models ---------- */

/** Line numbers the user named: "line 2", "lines 2 and 5", "lines 3-6", "line 4, 7". */
export function namedLineNumbers(text: string): Set<number> {
  const out = new Set<number>();
  const re = /\blines?\s+((?:\d+\s*(?:-|–|to)\s*\d+|\d+)(?:\s*(?:,|and|&|\+)\s*(?:\d+\s*(?:-|–|to)\s*\d+|\d+))*)/gi;
  for (const m of text.matchAll(re)) {
    for (const part of m[1].split(/\s*(?:,|and|&|\+)\s*/i)) {
      const r = /^(\d+)\s*(?:-|–|to)\s*(\d+)$/i.exec(part.trim());
      if (r) {
        const [a, b] = [Number(r[1]), Number(r[2])].sort((x, y) => x - y);
        for (let n = a; n <= b && n - a < 500; n++) out.add(n);
      } else if (/^\d+$/.test(part.trim())) out.add(Number(part.trim()));
    }
  }
  return out;
}

/**
 * When the user named the lines to delete, a model must not delete others (small models sometimes call delete_line
 * for every line). Calls for lines they did not name are skipped and reported.
 */
export function limitDeletes(text: string, calls: RawCall[]): { calls: RawCall[]; skipped: CallResult[] } {
  if (!/\b(delete|remove|drop|erase|get rid of)\b/i.test(text)) return { calls, skipped: [] };
  const named = namedLineNumbers(text);
  if (!named.size) return { calls, skipped: [] };
  const keep: RawCall[] = [];
  const skipped: CallResult[] = [];
  const seen = new Set<number>();
  for (const c of calls) {
    if (c.tool !== "delete_line") {
      keep.push(c);
      continue;
    }
    let args = c.args as { index?: unknown } | string;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        /* leave it */
      }
    }
    const n = Number((args as { index?: unknown })?.index);
    if (named.has(n) && !seen.has(n)) {
      seen.add(n);
      keep.push(c);
    } else skipped.push({ tool: c.tool, args: c.args, ok: false, summary: `skipped delete_line ${Number.isFinite(n) ? n : "?"}: you asked to delete line${named.size > 1 ? "s" : ""} ${[...named].join(", ")} only` });
  }
  return { calls: keep, skipped };
}

/** Answers to simple counting questions straight from the project, so they are always right. Null otherwise. */
export function quickAnswer(text: string, p: Project): string | null {
  if (!/^\s*(how many|what is the number of|number of|count( the)?)\b/i.test(text) && !/\bhow many\b.*\?\s*$/i.test(text)) return null;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (/\b(lyric )?lines?\b/i.test(text)) {
    const layers = p.layers.length > 1 ? ` on ${n(p.layers.length, "layer", "layers")}` : "";
    return p.lines.length ? `There ${p.lines.length === 1 ? "is" : "are"} ${n(p.lines.length, "line", "lines")}${layers}.` : "There are no lines yet.";
  }
  if (/\blayers?\b/i.test(text)) return `There ${p.layers.length === 1 ? "is" : "are"} ${n(p.layers.length, "layer", "layers")}.`;
  if (/\bwords?\b/i.test(text)) {
    const words = p.lines.reduce((k, l) => k + l.text.split(/\s+/).filter(Boolean).length, 0);
    return `There ${words === 1 ? "is" : "are"} ${n(words, "word", "words")} in ${n(p.lines.length, "line", "lines")}.`;
  }
  return null;
}
