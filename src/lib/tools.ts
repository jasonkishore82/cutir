import { z } from "zod";
import { uid, useProject, type LyricLine, type Project } from "../store/project";

/* ---------- helpers ---------- */

const round2 = (n: number) => Math.round(n * 100) / 100;

const COLOR_NAMES: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#e53935", pink: "#ff5fa2", hotpink: "#ff69b4", orange: "#ff8a1f",
  yellow: "#ffd84a", gold: "#ffc933", green: "#34c759", lime: "#a3e635", teal: "#14b8a6", cyan: "#22d3ee",
  blue: "#3b82f6", navy: "#1e2a6b", indigo: "#4f46e5", purple: "#8b5cf6", violet: "#7c3aed", magenta: "#e11d8f",
  gray: "#9ca3af", grey: "#9ca3af", brown: "#8b5a2b", peach: "#ffb38a", coral: "#ff7f6e",
};

const color = z
  .string()
  .transform((s) => {
    const k = s.trim().toLowerCase().replace(/\s+/g, "");
    return COLOR_NAMES[k] ?? k;
  })
  .pipe(z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, "must be a hex color like #ff8800 or a basic color name"));

const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const bool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
const idx = z.coerce.number().int().min(1);

const Position = z.enum(["top", "center", "bottom"]);
const Animation = z.enum(["fade", "pop", "slide-up", "typewriter", "word-highlight"]);
const Aspect = z.enum(["16:9", "9:16", "1:1"]);

const StylePatch = z
  .object({
    fontFamily: z.string().min(1),
    fontSize: num(8, 400),
    color,
    uppercase: bool,
    letterSpacing: num(-20, 100),
    lineHeight: num(0.5, 4),
    maxCharsPerLine: z.coerce.number().int().min(4).max(120),
    shadow: z.object({ blur: num(0, 100), offsetX: num(-100, 100), offsetY: num(-100, 100), opacity: num(0, 1) }).partial().strict(),
    outline: z.object({ width: num(0, 40), color }).partial().strict(),
    position: Position,
    animation: Animation,
    animationMs: num(0, 3000),
  })
  .partial()
  .strict();

/* ---------- argument schemas, one per tool ---------- */

const schemas = {
  update_style: z.object({ patch: StylePatch }),
  add_line: z.object({ text: z.string().min(1), index: idx.optional(), start: num(0, 36000).optional(), end: num(0, 36000).optional() }),
  delete_line: z.object({ index: idx }),
  update_line: z
    .object({ index: idx, text: z.string().min(1, "cannot be empty; use delete_line to remove a line").optional(), start: num(0, 36000).optional(), end: num(0, 36000).optional() })
    .refine((a) => a.text !== undefined || a.start !== undefined || a.end !== undefined, "provide text, start or end"),
  shift_timings: z.object({ from_index: idx, to_index: idx, seconds: num(-3600, 3600) }),
  split_line: z.object({ index: idx, at_word: idx }),
  merge_lines: z.object({ index_a: idx, index_b: idx }),
  set_background: z.discriminatedUnion("type", [
    z.object({ type: z.literal("gradient"), colors: z.array(color).min(2).max(6), angle: num(0, 360).default(135) }),
    z.object({ type: z.literal("asset") }),
  ]),
  set_animation: z.object({ name: Animation, durationMs: num(0, 3000).optional() }),
  set_aspect: z.object({ ratio: Aspect }),
} as const;

export type ToolName = keyof typeof schemas;
export const TOOL_NAMES = Object.keys(schemas) as ToolName[];

/* ---------- Ollama tool definitions (hand-written, kept small for an 8B model) ---------- */

const fn = (name: string, description: string, properties: object, required: string[]) => ({
  type: "function" as const,
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const OLLAMA_TOOLS = [
  fn(
    "update_style",
    "Change text style. patch may include: fontFamily, fontSize, color(hex), uppercase, letterSpacing, lineHeight, maxCharsPerLine, shadow{blur,offsetX,offsetY,opacity}, outline{width,color}, position(top|center|bottom), animation, animationMs",
    { patch: { type: "object", description: "style fields to change" } },
    ["patch"]
  ),
  fn(
    "add_line",
    "Add a new lyric line. index = position to insert at (1-based, default: end). start/end in seconds are optional.",
    { text: { type: "string" }, index: { type: "integer" }, start: { type: "number" }, end: { type: "number" } },
    ["text"]
  ),
  fn("delete_line", "Delete a lyric line (1-based index) from the timeline", { index: { type: "integer" } }, ["index"]),
  fn(
    "update_line",
    "Edit an EXISTING lyric line (1-based index); to append a word, send the full new text. Times in seconds.",
    { index: { type: "integer" }, text: { type: "string" }, start: { type: "number" }, end: { type: "number" } },
    ["index"]
  ),
  fn(
    "shift_timings",
    "Shift start and end of lines from_index..to_index (1-based, inclusive) by seconds (negative = earlier)",
    { from_index: { type: "integer" }, to_index: { type: "integer" }, seconds: { type: "number" } },
    ["from_index", "to_index", "seconds"]
  ),
  fn(
    "split_line",
    "Split a line in two after the at_word-th word",
    { index: { type: "integer" }, at_word: { type: "integer" } },
    ["index", "at_word"]
  ),
  fn("merge_lines", "Merge two lines into one", { index_a: { type: "integer" }, index_b: { type: "integer" } }, ["index_a", "index_b"]),
  fn(
    "set_background",
    "Set a gradient background (colors as hex, angle in degrees) or keep the uploaded asset",
    { type: { type: "string", enum: ["gradient", "asset"] }, colors: { type: "array", items: { type: "string" } }, angle: { type: "number" } },
    ["type"]
  ),
  fn(
    "set_animation",
    "Set line entry animation",
    { name: { type: "string", enum: ["fade", "pop", "slide-up", "typewriter", "word-highlight"] }, durationMs: { type: "number" } },
    ["name"]
  ),
  fn("set_aspect", "Set the aspect ratio", { ratio: { type: "string", enum: ["16:9", "9:16", "1:1"] } }, ["ratio"]),
];

/* ---------- applying a tool call to a project (pure) ---------- */

function lineAt(p: Project, n: number): LyricLine {
  const l = p.lines[n - 1];
  if (!l)
    throw new Error(
      p.lines.length
        ? `line ${n} does not exist (project has ${p.lines.length} lines)`
        : `line ${n} does not exist: there are no lines yet. Use add_line to create one`
    );
  return l;
}

const withLines = (p: Project, lines: LyricLine[]): Project => ({ ...p, lines });

function apply(p: Project, name: ToolName, a: any): { project: Project; summary: string } {
  switch (name) {
    case "update_style": {
      const { shadow, outline, ...rest } = a.patch;
      const style = {
        ...p.style,
        ...rest,
        shadow: { ...p.style.shadow, ...shadow },
        outline: { ...p.style.outline, ...outline },
      };
      const keys = Object.keys(a.patch);
      if (!keys.length) throw new Error("patch is empty");
      return { project: { ...p, style }, summary: `style: ${keys.join(", ")}` };
    }
    case "add_line": {
      const at = Math.min(a.index ?? p.lines.length + 1, p.lines.length + 1);
      const prev = p.lines[at - 2];
      const start = round2(a.start ?? (prev ? prev.end + 0.2 : 0));
      const end = round2(a.end ?? start + 3);
      if (end <= start) throw new Error(`end (${end}) must be after start (${start})`);
      const line: LyricLine = { id: uid(), text: a.text.trim(), start, end };
      const lines = [...p.lines.slice(0, at - 1), line, ...p.lines.slice(at - 1)];
      return { project: withLines(p, lines), summary: `line ${at} added: "${line.text}"` };
    }
    case "delete_line": {
      const l = lineAt(p, a.index);
      return { project: withLines(p, p.lines.filter((x) => x !== l)), summary: `line ${a.index} deleted: "${l.text}"` };
    }
    case "update_line": {
      const l = lineAt(p, a.index);
      const next = { ...l, ...(a.text !== undefined && { text: a.text, words: undefined }), ...(a.start !== undefined && { start: round2(a.start) }), ...(a.end !== undefined && { end: round2(a.end) }) };
      if (next.end <= next.start) throw new Error(`end (${next.end}) must be after start (${next.start})`);
      return { project: withLines(p, p.lines.map((x) => (x === l ? next : x))), summary: `line ${a.index} updated` };
    }
    case "shift_timings": {
      const from = Math.min(a.from_index, a.to_index);
      const to = Math.max(a.from_index, a.to_index);
      lineAt(p, from);
      lineAt(p, to);
      const lines = p.lines.map((l, i) => {
        if (i + 1 < from || i + 1 > to) return l;
        const start = round2(l.start + a.seconds);
        if (start < 0) throw new Error(`line ${i + 1} would start before 0s`);
        return { ...l, start, end: round2(l.end + a.seconds), words: undefined };
      });
      return { project: withLines(p, lines), summary: `lines ${from}-${to} shifted ${a.seconds > 0 ? "+" : ""}${a.seconds}s` };
    }
    case "split_line": {
      const l = lineAt(p, a.index);
      const words = l.text.split(/\s+/).filter(Boolean);
      if (a.at_word >= words.length) throw new Error(`line ${a.index} has ${words.length} words; at_word must be 1-${words.length - 1}`);
      const mid = round2(l.start + ((l.end - l.start) * a.at_word) / words.length);
      const first: LyricLine = { id: l.id, text: words.slice(0, a.at_word).join(" "), start: l.start, end: mid, styleOverride: l.styleOverride };
      const second: LyricLine = { id: Math.random().toString(36).slice(2, 10), text: words.slice(a.at_word).join(" "), start: mid, end: l.end, styleOverride: l.styleOverride };
      const lines = [...p.lines.slice(0, a.index - 1), first, second, ...p.lines.slice(a.index)];
      return { project: withLines(p, lines), summary: `line ${a.index} split after word ${a.at_word}` };
    }
    case "merge_lines": {
      if (a.index_a === a.index_b) throw new Error("index_a and index_b must differ");
      const lo = Math.min(a.index_a, a.index_b);
      const hi = Math.max(a.index_a, a.index_b);
      const A = lineAt(p, lo);
      const B = lineAt(p, hi);
      const merged: LyricLine = { ...A, text: `${A.text} ${B.text}`, start: Math.min(A.start, B.start), end: Math.max(A.end, B.end), words: undefined };
      const lines = p.lines.filter((_, i) => i + 1 !== hi).map((l) => (l === A ? merged : l));
      return { project: withLines(p, lines), summary: `lines ${lo} and ${hi} merged` };
    }
    case "set_background": {
      if (a.type === "gradient") {
        const noise = p.background.type === "gradient" ? p.background.noise : true;
        return { project: { ...p, background: { type: "gradient", colors: a.colors, angle: a.angle, noise } }, summary: `gradient ${a.colors.join(" > ")} @${a.angle}deg` };
      }
      if (p.background.type === "asset" && p.background.asset) return { project: p, summary: "background asset kept" };
      throw new Error("no background file is loaded; ask the user to upload one in the left panel");
    }
    case "set_animation":
      return {
        project: { ...p, style: { ...p.style, animation: a.name, animationMs: a.durationMs ?? p.style.animationMs } },
        summary: `animation ${a.name}${a.durationMs !== undefined ? ` ${a.durationMs}ms` : ""}`,
      };
    case "set_aspect":
      return { project: { ...p, aspect: a.ratio }, summary: `aspect ${a.ratio}` };
  }
}

/* ---------- entry points ---------- */

export type RawCall = { tool: string; args: unknown };
export type CallResult = { tool: string; args: unknown; ok: boolean; summary: string; noop?: boolean };

const STYLE_KEYS = Object.keys(StylePatch.shape);

/** Small models often drop the wrapper object or send string arguments; repair the common cases. */
function normalizeArgs(tool: string, args: unknown): unknown {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return a;
    }
  }
  if (tool === "update_style" && a && typeof a === "object" && !("patch" in a)) {
    const keys = Object.keys(a as object);
    if (keys.length && keys.every((k) => STYLE_KEYS.includes(k))) return { patch: a };
  }
  if (tool === "set_background" && a && typeof a === "object" && !("type" in a) && "colors" in a) {
    return { type: "gradient", ...(a as object) };
  }
  return a;
}

const fmtIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");

/** Validate and apply every call as ONE undoable history step. Invalid calls are reported, valid ones still apply. */
export function applyCalls(calls: RawCall[]): { results: CallResult[]; before: Project; after: Project } {
  const store = useProject.getState();
  const before = store.project;
  const results: CallResult[] = [];

  store.batch(() => {
    for (const call of calls) {
      const name = call.tool as ToolName;
      if (!(name in schemas)) {
        results.push({ ...call, ok: false, summary: `unknown tool "${call.tool}"` });
        continue;
      }
      const parsed = schemas[name].safeParse(normalizeArgs(name, call.args));
      if (!parsed.success) {
        results.push({ ...call, ok: false, summary: `${name}: ${fmtIssues(parsed.error)}` });
        continue;
      }
      try {
        const current = useProject.getState().project;
        const { project, summary } = apply(current, name, parsed.data);
        if (JSON.stringify(project) === JSON.stringify(current)) {
          results.push({ ...call, ok: true, noop: true, summary: `${summary} (already set, unchanged)` });
          continue;
        }
        useProject.getState().update(() => project);
        results.push({ ...call, ok: true, summary });
      } catch (err) {
        results.push({ ...call, ok: false, summary: `${name}: ${(err as Error).message}` });
      }
    }
  });

  return { results, before, after: useProject.getState().project };
}

/* ---------- prompts ---------- */

const MAX_PROMPT_LINES = 120;

export function buildSystemPrompt(p: Project, fallbackJson: boolean): string {
  const bg =
    p.background.type === "gradient"
      ? `gradient ${p.background.colors.join(",")} angle ${p.background.angle}`
      : `asset ${p.background.asset?.name ?? "(none)"}`;
  const shown = p.lines.slice(0, MAX_PROMPT_LINES);
  const rows = shown.map((l, i) => `${i + 1} | ${l.start.toFixed(2)}-${l.end.toFixed(2)} | ${l.text.slice(0, 70)}`).join("\n");
  const more = p.lines.length > shown.length ? `\n(+${p.lines.length - shown.length} more lines)` : "";

  const parts = [
    "You are the assistant inside Cutir, a lyric video editor. ONLY call tools when the user asks to change the video. For greetings, thanks or questions, answer in one short sentence and do NOT call any tool. When editing: one edit per call (several calls are fine), only change what was asked, and never repeat values that are already set. Line numbers are 1-based, times are seconds.",
    "Tools: update_style{patch}, add_line{text,index?,start?,end?}, update_line{index,text?,start?,end?} (existing lines only; to append a word send the full new text), delete_line{index} (removes a line from the timeline), shift_timings{from_index,to_index,seconds}, split_line{index,at_word}, merge_lines{index_a,index_b}, set_background{type:'gradient',colors[],angle}, set_animation{name,durationMs}, set_aspect{ratio}.",
    "Style patch keys: fontFamily,fontSize,color(hex),uppercase,letterSpacing,lineHeight,maxCharsPerLine,shadow{blur,offsetX,offsetY,opacity},outline{width,color},position(top|center|bottom),animation,animationMs. Animations: fade,pop,slide-up,typewriter,word-highlight.",
    `STYLE: ${JSON.stringify(p.style)}`,
    `BACKGROUND: ${bg}`,
    `ASPECT: ${p.aspect}`,
    `LINES (index | start-end | text):\n${rows || "(none)"}${more}`,
  ];
  if (fallbackJson) {
    parts.push(
      'Tools are unavailable. Reply with ONE ```json block containing {"actions":[{"tool":"<name>","args":{...}}]} and nothing else needed.'
    );
  }
  return parts.join("\n");
}

const SMALL_TALK = /^\s*(hi+|hello+|hey+|hiya|yo|sup|howdy|thanks?|thank you|thx|ok(ay)?|cool|nice|great|good (morning|afternoon|evening|night)|bye|goodbye|how are you\??|who are you\??|what can you do\??|help)[\s!.?]*$/i;

/** Greetings and chit-chat: answer normally, no tools. Small models otherwise invent edits. */
export const isSmallTalk = (text: string) => SMALL_TALK.test(text);

export const CHAT_ONLY_PROMPT =
  "You are the assistant inside Cutir, a lyric video editor. Reply in one or two short friendly sentences. You can change text style, lyric lines and timings, backgrounds, animations and aspect ratio when asked. Do not claim to have changed anything.";

/** Pull `{actions:[...]}` out of a model reply (fenced block, or a bare JSON object). */
export function parseActionsFromText(text: string): { calls: RawCall[]; stripped: string } {
  const candidates: { raw: string; whole: string }[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push({ raw: m[1], whole: m[0] });
  if (!candidates.length) {
    const m = /\{[\s\S]*"actions"[\s\S]*\}/.exec(text);
    if (m) candidates.push({ raw: m[0], whole: m[0] });
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.raw.trim());
      const list = Array.isArray(obj) ? obj : obj?.actions;
      if (!Array.isArray(list)) continue;
      const calls = list
        .filter((x) => x && typeof x.tool === "string")
        .map((x) => ({ tool: x.tool as string, args: x.args ?? x.arguments ?? {} }));
      if (calls.length) return { calls, stripped: text.replace(c.whole, "").trim() };
    } catch {
      /* not JSON, try the next candidate */
    }
  }
  return { calls: [], stripped: text };
}
