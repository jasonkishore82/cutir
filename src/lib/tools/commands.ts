import { z } from "zod";
import { defineTool } from "./registry";
import { allCommands, runCommand } from "../commands/registry";

/**
 * One tool for everything the UI can do that does not edit the project (phase 28): the commands of the command
 * registry (pages, view, tools, playback). It is built from the registry, so a new command shows up for the assistant
 * without any change here. Editing commands are left out: the assistant has real tools for those, with undo.
 */

const ALLOWED = new Set(["View", "Pages", "Tools", "Playback"]);

const offered = () => allCommands().filter((c) => ALLOWED.has(c.category) && !c.id.startsWith("ai.") && !c.id.startsWith("macro."));

export const runCommandTool = defineTool({
  name: "run_command",
  group: "ui",
  effect: true,
  description: "Do something in the interface: open a page (Edit, Color, Deliver...), switch tool, toggle snapping, play or pause, go to the start or end, fullscreen. id is the command title or id.",
  hint: "id = e.g. \"Go to the Color page\" or \"tool.blade\"; see the command list",
  params: z.object({ id: z.string().min(1) }),
  prepare: async (a) => {
    const list = offered();
    const k = a.id.trim().toLowerCase();
    const c =
      list.find((x) => x.id.toLowerCase() === k) ??
      list.find((x) => x.title.toLowerCase() === k) ??
      list.find((x) => x.title.toLowerCase().includes(k)) ??
      list.find((x) => k.length > 3 && `${x.category} ${x.title} ${x.keywords ?? ""}`.toLowerCase().includes(k));
    if (!c) throw new Error(`no such command "${a.id}". Some: ${list.slice(0, 12).map((x) => x.title).join(", ")}`);
    const ok = await runCommand(c.id);
    if (!ok) throw new Error(`"${c.title}" cannot run right now`);
    return `ran "${c.title}"`;
  },
});

export const commandTools = [runCommandTool];
