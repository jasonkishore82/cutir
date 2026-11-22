import { applyCalls, registry } from "../tools";
import { runCommand, getCommand } from "../commands/registry";
import { groupSteps, type Macro } from "./macroData";
import { useMacros } from "../../store/macros";

/** Steps that cannot run: a tool or a command this version does not have (a macro from another version or person). */
export function missingSteps(m: Macro): string[] {
  const out: string[] = [];
  for (const s of m.steps) {
    if (s.kind === "tool" && !registry.get(s.tool)) out.push(s.tool);
    if (s.kind === "command" && !getCommand(s.id)) out.push(s.id);
  }
  return out;
}

export type PlayResult = { ok: boolean; message: string };

/**
 * Play a macro. Runs of tool steps are applied together as one undo step; a command between them runs on its own.
 * Stops at the first step that fails and says which one. What it does is not recorded.
 */
export async function playMacro(m: Macro): Promise<PlayResult> {
  const missing = missingSteps(m);
  if (missing.length) return { ok: false, message: `This macro uses ${[...new Set(missing)].join(", ")}, which this version does not have.` };
  const store = useMacros.getState();
  if (store.recording) return { ok: false, message: "Stop recording first." };
  if (store.playing) return { ok: false, message: "A macro is already playing." };
  store.setPlaying(true);
  let done = 0;
  try {
    for (const g of groupSteps(m.steps)) {
      if (g.kind === "tools") {
        const { results } = await applyCalls(g.calls);
        const bad = results.find((r) => !r.ok);
        if (bad) return { ok: false, message: `Stopped after ${done} step${done === 1 ? "" : "s"}: ${bad.summary}` };
        done += g.calls.length;
      } else if (g.kind === "command") {
        if (!(await runCommand(g.id))) return { ok: false, message: `Stopped after ${done} step${done === 1 ? "" : "s"}: "${getCommand(g.id)?.title ?? g.id}" cannot run right now.` };
        done += 1;
      }
    }
    return { ok: true, message: `Played "${m.name}" (${done} step${done === 1 ? "" : "s"}).` };
  } finally {
    useMacros.getState().setPlaying(false);
  }
}
