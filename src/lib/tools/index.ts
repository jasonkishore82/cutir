import { z } from "zod";
import { useProject, type Project } from "../../store/project";
import { createRegistry, toOllamaTool, toolSignature, type AnyTool, type ToolGroup } from "./registry";
import { lineTools } from "./lines";
import { styleTools } from "./style";
import { sceneTools } from "./scene";
import { syncTools } from "./sync";

/** The one list of tools. Add a tool to a group file; it is picked up everywhere from here. */
export const registry = createRegistry([...styleTools, ...lineTools, ...sceneTools, ...syncTools]);

export const TOOL_NAMES = registry.all.map((t) => t.name);

/** Tool definitions in Ollama's format, generated from the zod schemas. Pass groups to send a subset. */
export const getOllamaTools = (groups?: ToolGroup[]) => registry.list(groups).map(toOllamaTool);
export const OLLAMA_TOOLS = getOllamaTools();

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
  store.batch(() => {
    for (const r of ready) {
      if ("fail" in r) {
        results.push({ ...r.call, ok: false, summary: r.fail });
        continue;
      }
      try {
        const current = useProject.getState().project;
        const { project, summary } = r.def.apply(current, r.data);
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
  });

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
  const rows = shown.map((l, i) => `${i + 1} | ${l.start.toFixed(2)}-${l.end.toFixed(2)} | ${l.text.slice(0, 70)}`).join("\n");
  const more = p.lines.length > shown.length ? `\n(+${p.lines.length - shown.length} more lines)` : "";

  const parts = [
    "You are the assistant inside Cutir, a lyric video editor. ONLY call tools when the user asks to change the video. For greetings, thanks or questions, answer in one short sentence and do NOT call any tool. When editing: one edit per call (several calls are fine), only change what was asked, and never repeat values that are already set. Line numbers are 1-based, times are seconds.",
    `Tools: ${registry.list(groups).map(toolSignature).join(", ")}.`,
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
