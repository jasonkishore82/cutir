import { z } from "zod";
import { layerIdOf, linesOfLayer, orderByLayers, uid, useProject, type LyricLine } from "../../store/project";
import { findLayer } from "../../store/layers";
import { defineTool } from "./registry";
import { idx, num, seconds } from "./schema";
import { lineAt, round2, withLines } from "./helpers";

export const addLine = defineTool({
  name: "add_line",
  group: "lines",
  description:
    "Add a new text line. layer = layer name or number (default: the layer being edited). index = position within that layer (1-based, default: end). start/end in seconds are optional.",
  params: z.object({
    text: z.string().min(1).describe("the text"),
    layer: z.union([z.string(), z.number()]).optional().describe("layer name or number"),
    index: idx.optional(),
    start: seconds.optional(),
    end: seconds.optional(),
  }),
  apply: (p, a) => {
    let layer = a.layer !== undefined ? findLayer(p, a.layer) : undefined;
    if (a.layer !== undefined && !layer) throw new Error(`layer "${a.layer}" does not exist (layers: ${p.layers.map((l, i) => `${i + 1} ${l.name}`).join(", ")})`);
    if (!layer) {
      const active = useProject.getState().activeLayerId; // default to the layer the user is working on
      layer = p.layers.find((l) => l.id === active) ?? p.layers[0];
    }
    if (layer.locked) throw new Error(`layer "${layer.name}" is locked`);
    const mine = linesOfLayer(p, layer.id);
    const at = Math.min(a.index ?? mine.length + 1, mine.length + 1);
    const prev = mine[at - 2];
    const start = round2(a.start ?? (prev ? prev.end + 0.2 : 0));
    const end = round2(a.end ?? start + 3);
    if (end <= start) throw new Error(`end (${end}) must be after start (${start})`);
    const line: LyricLine = { id: uid(), text: a.text.trim(), start, end, layerId: layer.id };
    const next = [...mine.slice(0, at - 1), line, ...mine.slice(at - 1)];
    const others = p.lines.filter((l) => layerIdOf(p, l) !== layer!.id);
    const project = orderByLayers({ ...p, lines: [...others, ...next] });
    return { project, summary: `line ${project.lines.indexOf(line) + 1} added to ${layer.name}: "${line.text}"` };
  },
});

export const updateLine = defineTool({
  name: "update_line",
  group: "lines",
  description: "Edit an EXISTING lyric line (1-based index); to append a word, send the full new text. Times in seconds.",
  hint: "existing lines only; to append a word send the full new text",
  params: z
    .object({
      index: idx,
      text: z.string().min(1, "cannot be empty; use delete_line to remove a line").optional(),
      start: seconds.optional(),
      end: seconds.optional(),
    })
    .refine((a) => a.text !== undefined || a.start !== undefined || a.end !== undefined, "provide text, start or end"),
  apply: (p, a) => {
    const l = lineAt(p, a.index);
    const next = {
      ...l,
      ...(a.text !== undefined && { text: a.text, words: undefined }),
      ...(a.start !== undefined && { start: round2(a.start) }),
      ...(a.end !== undefined && { end: round2(a.end) }),
    };
    if (next.end <= next.start) throw new Error(`end (${next.end}) must be after start (${next.start})`);
    return { project: withLines(p, p.lines.map((x) => (x === l ? next : x))), summary: `line ${a.index} updated` };
  },
});

export const deleteLine = defineTool({
  name: "delete_line",
  group: "lines",
  description: "Delete a lyric line (1-based index) from the timeline",
  hint: "removes a line from the timeline",
  params: z.object({ index: idx }),
  apply: (p, a) => {
    const l = lineAt(p, a.index);
    return { project: withLines(p, p.lines.filter((x) => x !== l)), summary: `line ${a.index} deleted: "${l.text}"` };
  },
});

export const shiftTimings = defineTool({
  name: "shift_timings",
  group: "lines",
  description: "Shift start and end of lines from_index..to_index (1-based, inclusive) by seconds (negative = earlier)",
  params: z.object({ from_index: idx, to_index: idx, seconds: num(-3600, 3600) }),
  apply: (p, a) => {
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
  },
});

export const splitLine = defineTool({
  name: "split_line",
  group: "lines",
  description: "Split a line in two after the at_word-th word",
  params: z.object({ index: idx, at_word: idx }),
  apply: (p, a) => {
    const l = lineAt(p, a.index);
    const words = l.text.split(/\s+/).filter(Boolean);
    if (a.at_word >= words.length) throw new Error(`line ${a.index} has ${words.length} words; at_word must be 1-${words.length - 1}`);
    const mid = round2(l.start + ((l.end - l.start) * a.at_word) / words.length);
    const first: LyricLine = { id: l.id, text: words.slice(0, a.at_word).join(" "), start: l.start, end: mid, styleOverride: l.styleOverride, layerId: l.layerId };
    const second: LyricLine = { id: uid(), text: words.slice(a.at_word).join(" "), start: mid, end: l.end, styleOverride: l.styleOverride, layerId: l.layerId };
    const lines = [...p.lines.slice(0, a.index - 1), first, second, ...p.lines.slice(a.index)];
    return { project: withLines(p, lines), summary: `line ${a.index} split after word ${a.at_word}` };
  },
});

export const mergeLines = defineTool({
  name: "merge_lines",
  group: "lines",
  description: "Merge two lines into one",
  params: z.object({ index_a: idx, index_b: idx }),
  apply: (p, a) => {
    if (a.index_a === a.index_b) throw new Error("index_a and index_b must differ");
    const lo = Math.min(a.index_a, a.index_b);
    const hi = Math.max(a.index_a, a.index_b);
    const A = lineAt(p, lo);
    const B = lineAt(p, hi);
    const merged: LyricLine = { ...A, text: `${A.text} ${B.text}`, start: Math.min(A.start, B.start), end: Math.max(A.end, B.end), words: undefined };
    const lines = p.lines.filter((_, i) => i + 1 !== hi).map((l) => (l === A ? merged : l));
    return { project: withLines(p, lines), summary: `lines ${lo} and ${hi} merged` };
  },
});

export const lineTools = [addLine, updateLine, deleteLine, shiftTimings, splitLine, mergeLines];
