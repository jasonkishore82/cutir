import { z } from "zod";
import { defineTool } from "./registry";
import { color, num, seconds } from "./schema";
import { activeTimeline } from "../../model/convert";
import type { ProjectDoc, Timeline, TitleSpec } from "../../model/types";
import * as E from "../../timeline/engine";
import { TITLE_TEMPLATES, addGeneratorClips, buildTemplate, updateGenerator } from "../titleTemplates";
import { ANIMATOR_PRESETS, titleOf } from "../titles";
import { LYRIC_PACKS, lyricsToTitles, packById } from "../lyricPack";

/** Title tools (phase 19): add titles and template titles, and edit the text and look of a title clip. */

const on = (doc: ProjectDoc, fn: (tl: Timeline) => Timeline) => E.onActive(doc, fn);
const presetIds = ANIMATOR_PRESETS.map((p) => p.id) as [string, ...string[]];

const look = {
  font: z.string().min(1).optional(),
  color: color.optional(),
  size: num(1, 40).optional().describe("text size, % of the frame height"),
  weight: num(100, 900).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  across: num(0, 100).optional().describe("horizontal position, % from the left"),
  down: num(0, 100).optional().describe("vertical position, % from the top"),
  outline: num(0, 40).optional().describe("outline width in 1/1000 of the frame height"),
  outlineColor: color.optional(),
  shadow: z.boolean().optional(),
  glow: num(0, 80).optional().describe("glow in 1/1000 of the frame height; 0 = none"),
  box: z.boolean().optional().describe("dark box behind the text"),
  animation: z.enum(presetIds).optional().describe("per-character animation preset"),
  by: z.enum(["letter", "word", "line"]).optional().describe("what the animation moves"),
  animationSeconds: num(0.2, 30).optional(),
  fadeOut: num(0, 10).optional().describe("seconds to fade out at the end"),
};

type Look = { [K in keyof typeof look]?: z.output<(typeof look)[K]> };

function applyLook(t: TitleSpec, a: Look): TitleSpec {
  const n: TitleSpec = { ...t };
  if (a.font) n.font = a.font;
  if (a.color) n.color = a.color;
  if (a.size !== undefined) n.size = a.size / 100;
  if (a.weight !== undefined) n.weight = a.weight;
  if (a.align) n.align = a.align;
  if (a.across !== undefined) n.x = a.across / 100;
  if (a.down !== undefined) n.y = a.down / 100;
  if (a.outline !== undefined) n.strokeWidth = a.outline / 1000;
  if (a.outlineColor) n.stroke = a.outlineColor;
  if (a.shadow !== undefined) n.shadow = a.shadow;
  if (a.glow !== undefined) n.glow = a.glow / 1000;
  if (a.box !== undefined) n.box = a.box ? (t.box ?? { color: "#101018", padding: 0.025, radius: 0.01, opacity: 0.85 }) : null;
  if (a.animation || a.by || a.animationSeconds !== undefined || a.fadeOut !== undefined) {
    const p = a.animation ? ANIMATOR_PRESETS.find((x) => x.id === a.animation) : undefined;
    n.animator = {
      ...t.animator,
      ...(p ? { preset: p.id, unit: p.unit, duration: p.duration } : {}),
      ...(a.by ? { unit: a.by === "letter" ? "char" : a.by } : {}),
      ...(a.animationSeconds !== undefined ? { duration: a.animationSeconds } : {}),
      ...(a.fadeOut !== undefined ? { outDuration: a.fadeOut } : {}),
    };
  }
  return n;
}

export const addTitle = defineTool({
  name: "add_title",
  group: "timeline",
  description: "Add a text title as a clip on a free video track (works anywhere, not only for lyrics). Look fields are optional.",
  hint: "text; at/duration in seconds; animation = " + presetIds.join("|"),
  params: z.object({ text: z.string().min(1), at: seconds.optional(), duration: num(0.1, 3600).default(5), ...look }),
  applyDoc: (doc, a) => {
    const spec = applyLook(titleOf({ text: a.text }), a);
    let id = "";
    const next = on(doc, (t) => {
      const r = addGeneratorClips(t, [{ name: "Title", generator: { type: "title", title: spec }, duration: a.duration }], a.at ?? 0);
      id = r.ids[0];
      return r.tl;
    });
    return { doc: next, summary: `added title "${a.text.slice(0, 40)}" (clip ${id})` };
  },
});

export const addTitleTemplate = defineTool({
  name: "add_title_template",
  group: "timeline",
  description: `Add a title template (${TITLE_TEMPLATES.map((t) => t.id).join(", ")}). fields fills its words, for example {"name":"Ana Ruiz","role":"Editor"}.`,
  hint: "template; fields = object of the template's fields; at = seconds",
  params: z.object({ template: z.string().min(1), fields: z.record(z.string(), z.coerce.string()).default({}), at: seconds.optional() }),
  applyDoc: (doc, a) => {
    const known = TITLE_TEMPLATES.find((t) => t.id === a.template.toLowerCase().replace(/\s+/g, "-"));
    if (!known) throw new Error(`no title template "${a.template}". Templates: ${TITLE_TEMPLATES.map((t) => `${t.id} (fields: ${t.fields.map((f) => f.key).join(", ")})`).join("; ")}`);
    const bad = Object.keys(a.fields).filter((k) => !known.fields.some((f) => f.key === k));
    if (bad.length) throw new Error(`${known.id} has no field ${bad.join(", ")}. Fields: ${known.fields.map((f) => f.key).join(", ")}`);
    let count = 0;
    const next = on(doc, (t) => {
      const r = addGeneratorClips(t, buildTemplate(known.id, a.fields), a.at ?? 0);
      count = r.ids.length;
      return r.tl;
    });
    return { doc: next, summary: `added the ${known.name.toLowerCase()} template (${count} clips)` };
  },
});

export const updateTitle = defineTool({
  name: "update_title",
  group: "timeline",
  description: "Change the words or look of an existing title clip (a clip made by add_title or a template). Only the fields you give change.",
  hint: "clip = clip id from the project summary; text; look fields as in add_title",
  params: z.object({ clip: z.string().min(1), text: z.string().optional(), ...look }),
  applyDoc: (doc, a) => {
    const c = activeTimeline(doc).clips.find((x) => x.id === a.clip);
    if (!c) throw new Error(`no clip ${a.clip} on the timeline (clip ids are in the project summary)`);
    if (c.generator?.type !== "title") throw new Error(`clip ${a.clip} is not a title`);
    const next = on(doc, (t) =>
      updateGenerator(t, a.clip, (g) => {
        if (g.type !== "title") return g;
        const spec = applyLook(g.title, a);
        // the styled ranges refer to letter positions: drop them when the words change
        return { ...g, title: a.text !== undefined && a.text !== g.title.text ? { ...spec, text: a.text, runs: [] } : spec };
      })
    );
    return { doc: next, summary: `updated title ${a.clip}` };
  },
});

export const lyricsToTitlesTool = defineTool({
  name: "lyrics_to_titles",
  group: "timeline",
  description: `Show the lyrics (the lines of a subtitle track) as animated titles using a lyric pack (${LYRIC_PACKS.map((p) => p.id).join(", ")}). The subtitle lines stay as the timing source. Run it again after retiming to refresh the titles.`,
  hint: "pack; track = subtitle track name or id (default: the first subtitle track with lines)",
  params: z.object({ pack: z.string().min(1), track: z.string().optional() }),
  applyDoc: (doc, a) => {
    const pack = packById(a.pack.toLowerCase().replace(/\s+/g, "-"));
    if (!pack) throw new Error(`no lyric pack "${a.pack}". Packs: ${LYRIC_PACKS.map((p) => p.id).join(", ")}`);
    let created = 0;
    const next = on(doc, (tl) => {
      const subs = tl.tracks.filter((t) => t.kind === "subtitle");
      const src = a.track ? subs.find((t) => t.id === a.track || t.name.toLowerCase() === a.track!.toLowerCase()) : subs.find((t) => tl.clips.some((c) => c.trackId === t.id && c.text?.text?.trim()));
      if (!src) throw new Error(a.track ? `no subtitle track "${a.track}"` : "there is no subtitle track with lyrics");
      const r = lyricsToTitles(tl, src.id, pack);
      created = r.created;
      return r.tl;
    });
    return { doc: next, summary: `${created} lyric lines shown with the ${pack.name} pack` };
  },
});

export const titleTools = [addTitle, addTitleTemplate, updateTitle, lyricsToTitlesTool];
