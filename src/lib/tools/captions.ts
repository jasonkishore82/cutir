import { z } from "zod";
import { defineTool } from "./registry";
import { docToView } from "../../model/convert";
import { linesOfLayer, type Project } from "../../store/project";
import { ASPECT_SIZES } from "../renderer";
import { DEFAULT_RULES, checkCues, fixCues, type CaptionRules } from "../captions/checks";
import { CAPTION_PRESETS, presetById, styleFor, type SafeArea } from "../captions/presets";
import { DEFAULT_FILLERS, findFillers, findPauses, flatWords, planCuts, totalOf } from "../captions/transcript";
import { cutDoc, linesToCues, withLayerCues } from "../captions/ops";

/**
 * Caption tools (phase 25): check and fix captions against reading-speed and layout rules, set a caption look, and
 * remove filler words and pauses (which cuts the picture and sound too). They act on a caption track by name
 * (the first track when none is named).
 */

const rulesFrom = (a: { maxCps?: number; maxChars?: number; maxLines?: number }): CaptionRules => ({
  ...DEFAULT_RULES,
  ...(a.maxCps ? { maxCps: a.maxCps } : {}),
  ...(a.maxChars ? { maxChars: a.maxChars } : {}),
  ...(a.maxLines ? { maxLines: a.maxLines } : {}),
});

function layerOf(p: Project, ref: string | undefined) {
  if (!ref) return p.layers[0];
  const k = ref.trim().toLowerCase();
  const l = p.layers.find((x) => x.id === ref) ?? p.layers.find((x) => x.name.toLowerCase() === k) ?? p.layers.find((x) => x.name.toLowerCase().includes(k)) ?? p.layers.find((x) => (x.lang ?? "") === k);
  if (!l) throw new Error(`no caption track "${ref}". Tracks: ${p.layers.map((x) => x.name).join(", ")}`);
  return l;
}

const rulesShape = {
  layer: z.string().optional().describe("caption track name (default: the first)"),
  maxCps: z.number().min(5).max(40).optional().describe("most characters a second (default 17)"),
  maxChars: z.number().int().min(10).max(80).optional().describe("most characters on a line (default 42)"),
  maxLines: z.number().int().min(1).max(4).optional().describe("most lines per caption (default 2)"),
};

export const checkCaptions = defineTool({
  name: "check_captions",
  group: "captions",
  description: "List caption problems: reading speed, too short or too long on screen, overlaps, too many lines, lines too wide. Changes nothing.",
  params: z.object(rulesShape),
  apply: (p, a) => {
    const layer = layerOf(p, a.layer);
    const cues = linesToCues(linesOfLayer(p, layer.id));
    const issues = checkCues(cues, rulesFrom(a));
    if (!issues.length) return { project: p, summary: `"${layer.name}": ${cues.length} captions, no problems` };
    const shown = issues.slice(0, 8).map((i) => `caption ${i.index + 1}: ${i.message}`).join("; ");
    return { project: p, summary: `"${layer.name}": ${issues.length} problem${issues.length === 1 ? "" : "s"} in ${new Set(issues.map((i) => i.index)).size} of ${cues.length} captions. ${shown}${issues.length > 8 ? "; ..." : ""}` };
  },
});

export const fixCaptions = defineTool({
  name: "fix_captions",
  group: "captions",
  description: "Fix caption problems: re-wrap lines evenly, split long captions at sentence ends, trim overlaps, give short or fast captions more time where there is room.",
  params: z.object(rulesShape),
  apply: (p, a) => {
    const layer = layerOf(p, a.layer);
    const rules = rulesFrom(a);
    const cues = linesToCues(linesOfLayer(p, layer.id));
    const before = checkCues(cues, rules).length;
    const r = fixCues(cues, rules);
    const after = checkCues(r.cues, rules).length;
    return { project: withLayerCues(p, layer.id, r.cues), summary: `"${layer.name}": ${before} problem${before === 1 ? "" : "s"} before, ${after} left; now ${r.cues.length} captions` };
  },
});

export const captionLook = defineTool({
  name: "caption_look",
  group: "captions",
  description: `Give a caption track a ready-made look (${CAPTION_PRESETS.map((x) => x.id).join(", ")}), sized to keep a full line inside the safe area.`,
  params: z.object({
    layer: z.string().optional(),
    look: z.enum(CAPTION_PRESETS.map((x) => x.id) as [string, ...string[]]),
    safe: z.enum(["action", "title", "wide"]).optional(),
    maxChars: z.number().int().min(10).max(80).optional(),
  }),
  apply: (p, a) => {
    const layer = layerOf(p, a.layer);
    const size = ASPECT_SIZES[p.aspect];
    const style = styleFor(presetById(a.look)!, { maxChars: a.maxChars ?? DEFAULT_RULES.maxChars }, size.w / size.h, (a.safe ?? "title") as SafeArea);
    return { project: { ...p, layers: p.layers.map((l) => (l.id === layer.id ? { ...l, style } : l)) }, summary: `"${layer.name}" set to the ${a.look} look` };
  },
});

export const removeFillers = defineTool({
  name: "remove_fillers",
  group: "captions",
  description: "Cut filler words (um, uh, you know...) and long pauses out of the video, the sound and every caption track, using the word timing of a caption track. Run a transcription first.",
  hint: "fillers = words to cut (default um, uh, er, ah, hmm, you know, I mean); pauses = also shorten silences longer than pauseMin seconds",
  params: z.object({
    layer: z.string().optional().describe("caption track holding the transcript (default: the first)"),
    fillers: z.array(z.string()).optional(),
    pauses: z.boolean().optional(),
    pauseMin: z.number().min(0.3).max(5).optional().describe("shortest pause to cut, seconds (default 0.8)"),
    pauseKeep: z.number().min(0).max(1).optional().describe("silence left behind, seconds (default 0.3)"),
  }),
  applyDoc: (doc, a) => {
    const view = docToView(doc);
    const layer = layerOf(view, a.layer);
    const words = flatWords(linesToCues(linesOfLayer(view, layer.id)));
    if (!words.length) throw new Error(`"${layer.name}" has no captions to work from; transcribe first`);
    const fill = findFillers(words, a.fillers?.length ? a.fillers : DEFAULT_FILLERS);
    const pauses = a.pauses ? findPauses(words, { min: a.pauseMin ?? 0.8, keep: a.pauseKeep ?? 0.3 }) : [];
    const ranges = planCuts(words, fill, pauses);
    if (!ranges.length) return { doc, summary: "no filler words or long pauses found" };
    return { doc: cutDoc(doc, ranges, { picture: true }), summary: `cut ${fill.length} filler word${fill.length === 1 ? "" : "s"}${a.pauses ? ` and ${pauses.length} pause${pauses.length === 1 ? "" : "s"}` : ""}, ${totalOf(ranges).toFixed(1)} s shorter` };
  },
});

export const captionTools = [checkCaptions, fixCaptions, captionLook, removeFillers];
