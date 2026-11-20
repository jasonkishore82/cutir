// Phase 16.5: kinetic chat / MCP tools (src/lib/tools/kinetic.ts) through applyCalls, as the chat and MCP use them.
import { applyCalls, buildSystemPrompt, registry, selectToolGroups } from "../src/lib/tools/index";
import { snapLinesToBeats } from "../src/lib/tools/kinetic";
import { paramsSchema } from "../src/lib/tools/registry";
import { defaultProject, layerIdOf, useProject, type LyricLine, type Project } from "../src/store/project";
import { activeTimeline, viewToDoc } from "../src/model/convert";
import type { Marker, ProjectDoc } from "../src/model/types";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}
const st = () => useProject.getState();
const P = () => st().project;
const run = async (tool: string, args: unknown) => (await applyCalls([{ tool, args }])).results[0];

const lines: LyricLine[] = [
  { id: "l1", text: "I will love you forever", start: 0.12, end: 1.9, layerId: "main" },
  { id: "l2", text: "burning fire, burning fire", start: 2.1, end: 3.95, layerId: "main" },
  { id: "l3", text: "we are fire tonight", start: 4.05, end: 6.1, layerId: "main" },
];
const base: Project = { ...defaultProject(), lines, audio: { name: "song.mp3", kind: "audio" } };

/** A doc with beat markers every 0.5 s (downbeat every 2 s) and a known song length. */
function withBeats(doc: ProjectDoc): ProjectDoc {
  const tl = activeTimeline(doc);
  const markers: Marker[] = Array.from({ length: 17 }, (_, i) => ({ id: `b${i}`, time: i * 0.5, name: "", color: "#f5a623", kind: "beat", downbeat: i % 4 === 0, strength: 1 }));
  return {
    ...doc,
    media: doc.media.map((m) => (m.kind === "audio" ? { ...m, duration: 8 } : m)),
    timelines: doc.timelines.map((t) => (t.id === tl.id ? { ...t, markers: [...t.markers, ...markers] } : t)),
  };
}

/* ---------- registry and MCP exposure ---------- */
const names = ["set_word_style", "emphasize_words", "auto_emphasis", "set_beat_reaction", "set_energy", "snap_to_beats", "detect_beats"];
check("every kinetic tool is registered in the kinetic group", names.every((n) => registry.get(n)?.group === "kinetic"));
// the MCP server and mcpBridge list registry.list() with paramsSchema, so this is what Claude sees
check("and offered over MCP with object schemas", names.every((n) => registry.list().some((t) => t.name === n && (paramsSchema(t) as { type?: string }).type === "object")));
check("beat requests bring in the kinetic tools", selectToolGroups("make the words pulse on the beat", base).includes("kinetic") && selectToolGroups("emphasise the key words", base).includes("kinetic"));
check("other requests do not", !selectToolGroups("make the text red", base).includes("kinetic"));

/* ---------- no beats yet ---------- */
st().loadDoc(viewToDoc(base));
const noBeats = await run("snap_to_beats", {});
check("snap_to_beats without beats says to detect them", !noBeats.ok && /detect_beats/.test(noBeats.summary), noBeats.summary);
check("the prompt says there are no beats", /BEATS: none yet/.test(buildSystemPrompt(P(), false, ["style", "kinetic"])));

/* ---------- words ---------- */
const before = st().past.length;
const w1 = await run("set_word_style", { line: 1, word: "love", colour: "pink", scale: "150%", x: 5, rotation: -10, in: "bounce" });
const o1 = P().lines[0].wordOverrides?.[2];
check("set_word_style finds the word by text and writes one override", w1.ok && o1?.style?.color === "#ff5fa2" && o1.transform?.scale === 1.5 && o1.transform?.x === 0.05 && o1.transform?.rotation === -10 && o1.style?.animation?.in?.name === "pop", { w1, o1 });
check("one call is one undo step", st().past.length === before + 1);
const w2 = await run("set_word_style", { index: 1, word: 5, emphasis: 2 });
check("set_word_style by 1-based word number keeps the other words", w2.ok && P().lines[0].wordOverrides?.[4]?.emphasis === 2 && P().lines[0].wordOverrides?.[2]?.style?.color === "#ff5fa2");
check("unknown words are reported with the line's words", !(await run("set_word_style", { index: 1, word: "nope", color: "red" })).ok);
const w3 = await run("set_word_style", { index: 1, word: "love", reset: true });
check("reset puts the word back to the line", w3.ok && P().lines[0].wordOverrides?.[2] === undefined && P().lines[0].wordOverrides?.[4]?.emphasis === 2);
check("the change survives the document round trip", activeTimeline(st().doc).clips.find((c) => c.id === "l1")?.text?.wordOverrides?.[4]?.emphasis === 2);

const e1 = await run("emphasize_words", { index: 2, words: "burning, fire", level: 3 });
check("emphasize_words sets the first match of each word", e1.ok && P().lines[1].wordOverrides?.[0]?.emphasis === 3 && P().lines[1].wordOverrides?.[1]?.emphasis === 3 && !P().lines[1].wordOverrides?.[2], P().lines[1].wordOverrides);
const e2 = await run("emphasize_words", { index: 2, words: [1, "fire"], level: 0 });
check("level 0 clears", e2.ok && P().lines[1].wordOverrides === undefined, P().lines[1].wordOverrides);

const a1 = await run("auto_emphasis", { lines: [3] });
check("auto_emphasis on one line only", a1.ok && Object.values(P().lines[2].wordOverrides ?? {}).some((o) => o.emphasis) && P().lines[1].wordOverrides === undefined, P().lines);
check("the prompt lists emphasised words", /EMPHASIS \(line: word=level\): .*3: /.test(buildSystemPrompt(P(), false, ["kinetic"])));

/* ---------- beat reaction and energy ---------- */
const b1 = await run("set_beat_reaction", { effect: "thump", strength: 150, downbeats_only: "true" });
check("set_beat_reaction on the project (with repairs)", b1.ok && JSON.stringify(P().style.animation.beat) === JSON.stringify({ name: "pulse", strength: 1.5, downbeatsOnly: true }), P().style.animation.beat);
const b2 = await run("set_beat_reaction", { effect: "color swap", lines: "2,3" });
check("set_beat_reaction on lines keeps the strength they read", b2.ok && P().lines[1].styleOverride?.animation?.beat?.name === "colour-swap" && P().lines[2].styleOverride?.animation?.beat?.strength === 1.5 && !P().lines[0].styleOverride, P().lines[1].styleOverride);
const b3 = await run("set_beat_reaction", { effect: "flash", layer: "Lyrics" });
check("set_beat_reaction on a layer", b3.ok && P().layers[0].style?.animation?.beat?.name === "flash");
check("unknown layers are reported", !(await run("set_beat_reaction", { effect: "flash", layer: "nope" })).ok);
const n1 = await run("set_energy", { amount: 70 });
check("set_energy as a percent", n1.ok && P().style.energy === 0.7);
check("set_energy on a line", (await run("set_energy", { amount: 0.2, lines: 1 })).ok && P().lines[0].styleOverride?.energy === 0.2);

/* ---------- snapping ---------- */
st().loadDoc(withBeats(viewToDoc(base)));
check("beats reach the lyric view", P().beats?.length === 17);
check("the prompt gives the beat count", /BEATS: 17 beats/.test(buildSystemPrompt(P(), false, ["kinetic"])));
const s1 = await run("snap_to_beats", { edges: "both" });
const L = P().lines;
check("snap_to_beats moves both edges to beats", s1.ok && L[0].start === 0 && L[0].end === 2 && L[1].start === 2 && L[1].end === 4 && L[2].start === 4 && L[2].end === 6, L.map((l) => [l.start, l.end]));
const ordered = [...L].filter((l) => layerIdOf(P(), l) === "main").sort((a, b) => a.start - b.start);
check("no overlaps and every line at least 0.1 s", ordered.every((l, i) => l.end - l.start >= 0.1 - 1e-9 && (i === 0 || l.start >= ordered[i - 1].end - 1e-9)));

st().loadDoc(withBeats(viewToDoc(base)));
check("downbeats only", (await run("snap_to_beats", { lines: [2], edges: "start", downbeatsOnly: true })).ok && P().lines[1].start === 2 && P().lines[0].start === 0.12);

// pure: a short line whose edges would both land on the same beat keeps its own times; neighbours never overlap
const tight: Project = {
  ...defaultProject(),
  lines: [
    { id: "a", text: "a", start: 0.9, end: 1.05, layerId: "main" },
    { id: "b", text: "b", start: 1.1, end: 1.6, layerId: "main" },
    { id: "c", text: "c", start: 1.62, end: 3, layerId: "main" },
  ],
};
const snapped = snapLinesToBeats(tight, null, "both", [0, 1, 2, 3]).project.lines;
check("a line never shrinks below 0.1 s", snapped.every((l) => l.end - l.start >= 0.1 - 1e-9), snapped);
check("and lines on a layer never overlap", snapped.every((l, i) => i === 0 || l.start >= snapped[i - 1].end - 1e-9), snapped);

/* ---------- detect_beats by hand ---------- */
{
  const doc = viewToDoc(base);
  st().loadDoc({ ...doc, media: doc.media.map((m) => (m.kind === "audio" ? { ...m, duration: 8 } : m)) });
}
const d0 = await run("detect_beats", { bpm: 120, offset: 0.5 });
const d1 = d0.ok ? P().beats : undefined;
check("detect_beats with a tempo puts a steady grid on the timeline", d0.ok && /beats at 120 BPM/.test(d0.summary) && !!d1?.length && Math.abs(d1[1].time - d1[0].time - 0.5) < 1e-6, { d0, n: d1?.length });
check("and is one undo step", d0.ok && (st().undo(), !P().beats?.length));

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
