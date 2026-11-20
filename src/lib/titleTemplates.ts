import type { Clip, Generator, Timeline } from "../model/types";
import { addTrack, clipEnd, newId } from "../timeline/engine";
import { DEFAULT_ANIMATOR, layoutTitle, rollDuration, titleOf } from "./titles";
import { newGenerator, shapeOf } from "./generators";

/**
 * Title templates and generator clips (phase 19). A template is a recipe with a few named fields (the text people
 * fill in); `buildTemplate` turns the field values into one or more generator clips, `addGeneratorClips` drops them
 * on the timeline on the first free video tracks.
 */

export type TemplateField = { key: string; label: string; default: string; multiline?: boolean };

export type ClipPlan = { name: string; generator: Generator; duration: number; /** Delay after the template's start, seconds. */ delay?: number };

export type TitleTemplate = {
  id: string;
  name: string;
  description: string;
  fields: TemplateField[];
  /** Clips from the bottom layer to the top. */
  build: (v: Record<string, string>) => ClipPlan[];
};

const accentOf = (v: Record<string, string>, d: string) => (/^#[0-9a-f]{6}$/i.test(v.color ?? "") ? v.color : d);
const COLOR: TemplateField = { key: "color", label: "Accent colour", default: "#ffd84a" };

/** A measure for estimating a roll's length without a canvas (an average letter is about half the font size wide). */
const roughMeasure = (text: string, font: string) => text.length * (parseFloat(/(\d+(\.\d+)?)px/.exec(font)?.[1] ?? "20") * 0.52);

export const TITLE_TEMPLATES: TitleTemplate[] = [
  {
    id: "lower-third",
    name: "Lower third",
    description: "Name and role in a bar at the bottom left, sliding in",
    fields: [{ key: "name", label: "Name", default: "Alex Morgan" }, { key: "role", label: "Role", default: "Director" }, COLOR],
    build: (v) => {
      const name = v.name ?? "Alex Morgan";
      const role = v.role ?? "Director";
      const accent = accentOf(v, "#ffd84a");
      return [
        { name: "Lower third bar", duration: 4, generator: { type: "shape", shape: shapeOf("rectangle", { x: 0.255, y: 0.835, width: 0.012, height: 0.13, radius: 0, fill: accent }) } },
        {
          name: "Lower third text",
          duration: 4,
          generator: {
            type: "title",
            title: titleOf({
              text: `${name}\n${role}`,
              size: 0.058,
              x: 0.4,
              y: 0.835,
              width: 0.28,
              align: "left",
              autoFit: true,
              box: { color: "#101018", padding: 0.025, radius: 0, opacity: 0.85 },
              runs: [{ start: name.length + 1, end: name.length + 1 + role.length, size: 0.034, weight: 400, color: accent }],
              animator: { ...DEFAULT_ANIMATOR, preset: "line-slide", unit: "line", duration: 0.7, outDuration: 0.4 },
            }),
          },
        },
      ];
    },
  },
  {
    id: "centred-title",
    name: "Centred title",
    description: "A big title in the middle that blurs in letter by letter",
    fields: [{ key: "title", label: "Title", default: "Summer Nights" }, { key: "subtitle", label: "Subtitle", default: "" }, COLOR],
    build: (v) => {
      const title = v.title ?? "Summer Nights";
      const sub = v.subtitle ?? "";
      return [
        {
          name: "Centred title",
          duration: 5,
          generator: {
            type: "title",
            title: titleOf({
              text: sub ? `${title}\n${sub}` : title,
              size: 0.12,
              glow: 0.02,
              glowColor: accentOf(v, "#ffd84a"),
              runs: sub ? [{ start: title.length + 1, end: title.length + 1 + sub.length, size: 0.04, weight: 400 }] : [],
              animator: { ...DEFAULT_ANIMATOR, preset: "blur-in", unit: "char", duration: 1.6, outDuration: 0.6 },
            }),
          },
        },
      ];
    },
  },
  {
    id: "quote",
    name: "Quote",
    description: "A quotation with the author underneath",
    fields: [{ key: "quote", label: "Quote", default: "The best way out is always through.", multiline: true }, { key: "author", label: "Author", default: "Robert Frost" }, COLOR],
    build: (v) => {
      const q = `“${v.quote ?? "The best way out is always through."}”`;
      const a = `— ${v.author ?? "Robert Frost"}`;
      return [
        {
          name: "Quote",
          duration: 6,
          generator: {
            type: "title",
            title: titleOf({
              text: `${q}\n${a}`,
              size: 0.07,
              italic: true,
              weight: 500,
              width: 0.7,
              lineHeight: 1.3,
              runs: [{ start: q.length + 1, end: q.length + 1 + a.length, size: 0.036, italic: false, weight: 700, color: accentOf(v, "#ffd84a") }],
              animator: { ...DEFAULT_ANIMATOR, preset: "word-pop", unit: "word", duration: 1.8, outDuration: 0.5 },
            }),
          },
        },
      ];
    },
  },
  {
    id: "credits-roll",
    name: "Credits roll",
    description: "Roles and names scrolling up the screen",
    fields: [
      { key: "credits", label: "Credits (role, then names; blank line between groups)", default: "Directed by\nAlex Morgan\n\nProduced by\nSam Rivera\n\nMusic by\nJordan Lee", multiline: true },
      { key: "speed", label: "Speed (screens per second)", default: "0.09" },
    ],
    build: (v) => {
      const speed = Math.min(0.5, Math.max(0.02, parseFloat(v.speed ?? "0.09") || 0.09));
      const spec = titleOf({ text: v.credits ?? "", size: 0.045, lineHeight: 1.5, weight: 500, width: 0.6, autoFit: false, roll: speed, y: 0.5, animator: { ...DEFAULT_ANIMATOR, preset: "roll" } });
      const layout = layoutTitle(roughMeasure, spec, 1920, 1080);
      return [{ name: "Credits roll", duration: Math.max(2, Math.round(rollDuration(spec, layout, 1080) * 10) / 10), generator: { type: "title", title: spec } }];
    },
  },
  {
    id: "scoreboard",
    name: "Scoreboard",
    description: "Two names and a score in a bar at the top",
    fields: [{ key: "home", label: "Home", default: "HOME" }, { key: "away", label: "Away", default: "AWAY" }, { key: "homeScore", label: "Home score", default: "0" }, { key: "awayScore", label: "Away score", default: "0" }, COLOR],
    build: (v) => {
      const home = v.home ?? "HOME";
      const away = v.away ?? "AWAY";
      const hs = v.homeScore ?? "0";
      const as = v.awayScore ?? "0";
      const text = `${home}  ${hs} - ${as}  ${away}`;
      const at = home.length + 2;
      return [
        {
          name: "Scoreboard",
          duration: 6,
          generator: {
            type: "title",
            title: titleOf({
              text,
              size: 0.06,
              x: 0.5,
              y: 0.1,
              width: 0.6,
              box: { color: "#101018", padding: 0.02, radius: 0.02, opacity: 0.9 },
              runs: [{ start: at, end: at + hs.length + 3 + as.length, color: accentOf(v, "#ffd84a") }],
              animator: { ...DEFAULT_ANIMATOR, preset: "line-slide", unit: "line", duration: 0.5 },
            }),
          },
        },
      ];
    },
  },
];

export const templateById = (id: string) => TITLE_TEMPLATES.find((t) => t.id === id);

/** The recipe's clips for these field values (missing fields use their defaults). */
export function buildTemplate(id: string, values: Record<string, string> = {}): ClipPlan[] {
  const t = templateById(id);
  if (!t) throw new Error(`no title template "${id}". Templates: ${TITLE_TEMPLATES.map((x) => x.id).join(", ")}`);
  const v = Object.fromEntries(t.fields.map((f) => [f.key, values[f.key] ?? f.default]));
  return t.build(v);
}

const EPS = 1e-6;

/**
 * Put generator clips on the timeline at `at`, bottom layer first, each on the first unlocked video track (from the
 * lowest that is empty at that time) or a new one on top. Plans in one call end up on different tracks, stacked in
 * order. Returns the new clip ids.
 */
export function addGeneratorClips(tl: Timeline, plans: ClipPlan[], at: number): { tl: Timeline; ids: string[] } {
  let cur = tl;
  const ids: string[] = [];
  let minTrack = -1;
  for (const plan of plans) {
    const start = at + (plan.delay ?? 0);
    const videos = () => cur.tracks.map((t, i) => ({ t, i })).filter((x) => x.t.kind === "video");
    const free = videos().find(({ t, i }) => i > minTrack && !t.locked && !cur.clips.some((c) => c.trackId === t.id && !c.fill && c.start < start + plan.duration - EPS && clipEnd(c) > start + EPS) && !cur.clips.some((c) => c.trackId === t.id && c.fill));
    let trackId = free?.t.id;
    if (!trackId) {
      const r = addTrack(cur, "video");
      cur = r.tl;
      trackId = r.id;
    }
    minTrack = cur.tracks.findIndex((t) => t.id === trackId);
    const clip: Clip = { id: newId("c"), trackId, name: plan.name, start, duration: plan.duration, sourceIn: 0, sourceOut: plan.duration, speed: 1, enabled: true, effects: [], keyframes: {}, generator: plan.generator };
    cur = { ...cur, clips: [...cur.clips, clip] };
    ids.push(clip.id);
  }
  return { tl: cur, ids };
}

/** Update a generator clip's generator (merging a patch for the object fields). */
export function updateGenerator(tl: Timeline, clipId: string, patch: Partial<Generator> | ((g: Generator) => Generator)): Timeline {
  return { ...tl, clips: tl.clips.map((c) => (c.id === clipId && c.generator ? { ...c, generator: typeof patch === "function" ? patch(c.generator) : ({ ...c.generator, ...patch } as Generator) } : c)) };
}

export { newGenerator };
