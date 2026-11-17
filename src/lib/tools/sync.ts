import { z } from "zod";
import { defineTool } from "./registry";
import { runAlignment } from "../autosync";
import type { LyricLine } from "../../store/project";

// prepare() runs the (long) alignment; apply() then writes the result. They run back to back inside applyCalls.
let pending: { lines: LyricLine[]; skippedTags: number } | null = null;

export const autoSync = defineTool({
  name: "auto_sync",
  group: "sync",
  description:
    "Automatically time the lyrics to the uploaded song (runs the local Python aligner). Use when the user asks to auto-sync or align the lyrics.",
  hint: "starts the auto-sync; separate=true isolates the vocals first (better for produced songs)",
  params: z.object({
    separate: z.boolean().optional().describe("isolate the vocals first (slower, more accurate)"),
    language: z.string().optional().describe("lyrics language code, e.g. en, es, hi"),
    model: z.enum(["tiny", "base", "small", "medium", "large-v3"]).optional(),
  }),
  prepare: async (a) => {
    pending = await runAlignment(a);
  },
  apply: (p) => {
    const r = pending;
    pending = null;
    if (!r) throw new Error("auto-sync produced no result");
    const tags = r.skippedTags ? `, removed ${r.skippedTags} section tag${r.skippedTags === 1 ? "" : "s"}` : "";
    return { project: { ...p, lines: r.lines }, summary: `auto-synced ${r.lines.length} lines${tags}` };
  },
});

export const syncTools = [autoSync];
