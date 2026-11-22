/**
 * Macros (phase 28): a recorded sequence of steps that can be played again and shared as JSON.
 * A step is a tool call (the same ones the assistant makes) or a command from the command registry.
 */

export type Step = { kind: "tool"; tool: string; args: Record<string, unknown> } | { kind: "command"; id: string };

export type Macro = { id: string; name: string; steps: Step[]; created: number };

export const MAX_STEPS = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function sanitizeStep(raw: unknown): Step | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "command" && typeof raw.id === "string" && raw.id.length > 0 && raw.id.length < 80) return { kind: "command", id: raw.id };
  if (raw.kind === "tool" && typeof raw.tool === "string" && /^[a-z_]{2,40}$/.test(raw.tool)) {
    const args = isObj(raw.args) ? raw.args : {};
    // arguments are plain data: round-trip through JSON so nothing odd rides along
    try {
      return { kind: "tool", tool: raw.tool, args: JSON.parse(JSON.stringify(args)) };
    } catch {
      return null;
    }
  }
  return null;
}

export function sanitizeMacro(raw: unknown, newId: () => string): Macro | null {
  if (!isObj(raw) || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps.slice(0, MAX_STEPS).map(sanitizeStep).filter((s): s is Step => !!s);
  if (!steps.length) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 60) : "Macro";
  return { id: newId(), name, steps, created: typeof raw.created === "number" ? raw.created : Date.now() };
}

export const macrosToJson = (macros: Macro[]) => JSON.stringify({ cutirMacros: 1, macros: macros.map(({ name, steps, created }) => ({ name, steps, created })) }, null, 2);

export function macrosFromJson(text: string, newId: () => string): { macros: Macro[]; skipped: number } | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const list = isObj(j) && Array.isArray(j.macros) ? j.macros : Array.isArray(j) ? j : null;
  if (!list) return null;
  const macros: Macro[] = [];
  for (const m of list) {
    const ok = sanitizeMacro(m, newId);
    if (ok) macros.push(ok);
  }
  return { macros, skipped: list.length - macros.length };
}

/** "trim_clip start 1 s", for the list of steps. */
export function describeStep(s: Step): string {
  if (s.kind === "command") return s.id;
  const a = Object.entries(s.args)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${s.tool}${a ? ` ${a}` : ""}`;
}

/** Steps with consecutive tool calls grouped, so a group is applied as one undo step. */
export function groupSteps(steps: Step[]): (Step | { kind: "tools"; calls: { tool: string; args: Record<string, unknown> }[] })[] {
  const out: ReturnType<typeof groupSteps> = [];
  for (const s of steps) {
    if (s.kind === "tool") {
      const last = out[out.length - 1];
      if (last && last.kind === "tools") last.calls.push({ tool: s.tool, args: s.args });
      else out.push({ kind: "tools", calls: [{ tool: s.tool, args: s.args }] });
    } else out.push(s);
  }
  return out;
}
