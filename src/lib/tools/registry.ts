import { z } from "zod";
import type { Project } from "../../store/project";
import type { ProjectDoc } from "../../model/types";

/**
 * Tool registry. A tool is defined ONCE here: its zod parameter schema, description and apply function.
 * Everything else is derived from that definition:
 *   - the JSON schema sent to Ollama        (toOllamaTool)
 *   - the one-line signature in the prompt  (toolSignature)
 *   - validation + application              (applyCalls in index.ts)
 *
 * To add a tool: write defineTool({...}) in a group file and add it to that file's export. Nothing else.
 */

export type ToolGroup = "style" | "lines" | "scene" | "sync" | "layers" | "transform" | "motion" | "timeline" | "kinetic" | "captions" | "smart" | "ui";

export type ToolResultOk = { project: Project; summary: string };

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  /** Used to send only relevant tools per request once the list grows. */
  group: ToolGroup;
  /** Extra guidance appended to this tool's line in the system prompt. */
  hint?: string;
  /** Still runs when called, but is never offered to the model (kept for old prompts and saved replies). */
  alias?: boolean;
  params: S;
  /** Repair common small-model mistakes before validation (wrong wrapper, flattened args...). */
  normalize?: (args: unknown) => unknown;
  /**
   * Optional async step that runs BEFORE apply (e.g. download a font). Throw to reject the call with a message.
   * For an `effect` tool this is where the work happens and the string it returns is the summary.
   */
  prepare?: (args: z.output<S>) => Promise<void | string>;
  /** Acts outside the project (starts an export, runs a view command): reported as done, nothing to undo. */
  effect?: boolean;
  /** Pure: returns the new project, or throws an Error whose message is shown to the user and the model. */
  apply?: (project: Project, args: z.output<S>) => ToolResultOk;
  /**
   * For edits beyond the lyric view (timeline tracks and clips, markers, media): works on the whole document.
   * Pure like `apply`. A tool has `apply` or `applyDoc`.
   */
  applyDoc?: (doc: ProjectDoc, args: z.output<S>) => { doc: ProjectDoc; summary: string };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>;

export const defineTool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> => def;

/* ---------- JSON schema generation ---------- */

type JsonSchema = Record<string, unknown>;

/** zod emits some noise that only confuses small models; strip it. */
function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== "object") return node;
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node as JsonSchema)) {
    if (k === "$schema" || k === "additionalProperties") continue;
    if (k === "maximum" && typeof v === "number" && v > 1e12) continue; // z.int() upper bound
    if (k === "minimum" && typeof v === "number" && v < -1e12) continue;
    out[k] = clean(v);
  }
  // { anyOf: [{type: boolean}, {type: string, enum: ["true","false"]}] } -> { type: boolean }
  const any = out.anyOf as JsonSchema[] | undefined;
  if (any && any.some((s) => s.type === "boolean")) {
    delete out.anyOf;
    out.type = "boolean";
  }
  return out;
}

export function paramsSchema(def: AnyTool): JsonSchema {
  const raw = z.toJSONSchema(def.params, { io: "input", unrepresentable: "any" });
  return clean(raw) as JsonSchema;
}

export function toOllamaTool(def: AnyTool) {
  return { type: "function" as const, function: { name: def.name, description: def.description, parameters: paramsSchema(def) } };
}

/** e.g. update_line{index,text?,start?,end?} */
export function toolSignature(def: AnyTool): string {
  const s = paramsSchema(def) as { properties?: Record<string, unknown>; required?: string[] };
  const req = new Set(s.required ?? []);
  const keys = Object.keys(s.properties ?? {}).map((k) => (req.has(k) ? k : `${k}?`));
  return `${def.name}{${keys.join(",")}}${def.hint ? ` (${def.hint})` : ""}`;
}

/* ---------- the registry itself ---------- */

export function createRegistry(tools: AnyTool[]) {
  const byName = new Map<string, AnyTool>();
  for (const t of tools) {
    if (byName.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    byName.set(t.name, t);
  }
  return {
    all: tools,
    get: (name: string) => byName.get(name),
    /** All tools, or just those in the given groups. */
    list: (groups?: ToolGroup[]) => tools.filter((t) => !t.alias && (!groups || groups.includes(t.group))),
  };
}
