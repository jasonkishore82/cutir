// Phase 19: titles, per-character animators, shapes and generators, templates, generator clips on the timeline.
import { ANIMATOR_PRESETS, DEFAULT_ANIMATOR, drawTitle, graphemes, isRtlText, layoutTitle, rollDuration, titleOf, unitFx, unitsOf, type Measure } from "../src/lib/titles";
import { GENERATOR_KINDS, arrowPoints, countdownAt, drawGenerator, newGenerator, noiseBytes, polygonPoints, shapeOf, timecode } from "../src/lib/generators";
import { TITLE_TEMPLATES, addGeneratorClips, buildTemplate, updateGenerator } from "../src/lib/titleTemplates";
import { activeVisuals, compositeVisuals, needsAt, visualPlan } from "../src/render/compositor";
import { newEffect } from "../src/lib/effects";
import { defaultProject } from "../src/store/project";
import { activeTimeline, docToView, viewToDoc } from "../src/model/convert";
import type { Clip, ProjectDoc, Timeline, Track } from "../src/model/types";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

/** A stand-in font: every letter is half the font size wide, except that "AV" kerns 20% tighter. */
const sizeOf = (font: string) => parseFloat(/(\d+(\.\d+)?)px/.exec(font)![1]);
const measure: Measure = (text, font) => {
  const px = sizeOf(font);
  let w = 0;
  for (let i = 0; i < text.length; i++) w += px * 0.5 * (text[i] === "V" && text[i - 1] === "A" ? 0.6 : 1);
  return w;
};
const W = 1920;
const H = 1080;

/* ---------- layout ---------- */
const one = layoutTitle(measure, titleOf({ text: "Hello", size: 0.1, width: 0.9 }), W, H);
check("one word, one line, centred on the box", one.glyphs.length === 5 && one.lines.length === 1 && near((one.lines[0].x0 + one.lines[0].x1) / 2, 0), one.lines);
check("letters run left to right", one.glyphs.every((g, i, a) => !i || g.x > a[i - 1].x));
check("the line is as wide as its letters", near(one.width, 5 * 0.5 * 108, 1e-3), one.width);
const wrap = layoutTitle(measure, titleOf({ text: "one two three four five six", size: 0.1, width: 0.3, autoFit: false }), W, H);
check("long text wraps inside the box", wrap.lines.length > 1 && wrap.lines.every((l) => l.x1 - l.x0 <= 0.3 * W + 1), wrap.lines.map((l) => l.x1 - l.x0));
check("a new line is a new line", layoutTitle(measure, titleOf({ text: "a\nb\nc" }), W, H).lines.length === 3);
const al = (align: "left" | "center" | "right") => layoutTitle(measure, titleOf({ text: "hi", align, width: 0.5, size: 0.1 }), W, H).lines[0];
check("left, centre and right alignment", near(al("left").x0, -0.25 * W) && near((al("center").x0 + al("center").x1) / 2, 0) && near(al("right").x1, 0.25 * W), [al("left"), al("right")]);
const big = titleOf({ text: "a very long headline that cannot possibly fit on a single short line of the box", size: 0.3, width: 0.5 });
const fit = layoutTitle(measure, big, W, H);
check("auto fit shrinks text that is too big", fit.scale < 0.7 && fit.height <= H * 0.92 + 1 && fit.width <= 0.5 * W * 1.01, [fit.scale, fit.height, fit.width]);
check("without auto fit it keeps its size", layoutTitle(measure, { ...big, autoFit: false }, W, H).scale === 1);
const l1 = layoutTitle(measure, titleOf({ text: "a\nb", lineHeight: 1 }), W, H);
const l2 = layoutTitle(measure, titleOf({ text: "a\nb", lineHeight: 2 }), W, H);
check("a bigger line spacing spreads the lines", l2.lines[1].y - l2.lines[0].y > (l1.lines[1].y - l1.lines[0].y) * 1.5, [l1.lines, l2.lines]);
const spaced = layoutTitle(measure, titleOf({ text: "abc", letterSpacing: 0.2, size: 0.1 }), W, H);
const plain = layoutTitle(measure, titleOf({ text: "abc", size: 0.1 }), W, H);
check("letter spacing opens the gaps", near(spaced.glyphs[1].x - spaced.glyphs[0].x - (plain.glyphs[1].x - plain.glyphs[0].x), 0.2 * 108, 1e-6), [spaced.glyphs.map((g) => g.x), plain.glyphs.map((g) => g.x)]);

/* kerning: a letter's place comes from the width of the text before it, so pairs keep their kerning */
const kern = layoutTitle(measure, titleOf({ text: "AVA", size: 0.1, autoFit: false }), W, H);
check("kerning pairs survive per-letter positions", near(kern.glyphs[2].x - kern.glyphs[0].x, measure("AV", "10px x") * 0 + (0.5 + 0.3) * 108, 1e-6) && kern.glyphs[1].x - kern.glyphs[0].x === 0.5 * 108, kern.glyphs.map((g) => g.x));

/* rich text */
const rich = layoutTitle(measure, titleOf({ text: "Big small", size: 0.1, runs: [{ start: 4, end: 9, size: 0.05, color: "#f00", weight: 400 }], autoFit: false }), W, H);
check("a run changes size, colour and weight of its letters only", rich.glyphs[0].px === 108 && rich.glyphs[5].px === 54 && rich.glyphs[5].run?.color === "#f00" && !rich.glyphs[0].run && rich.glyphs[5].font.includes("400"), rich.glyphs.map((g) => g.px));
check("letters after a smaller run still line up", rich.glyphs[6].x > rich.glyphs[5].x);
check("runs count letters from the start of the text", rich.glyphs.find((g) => g.index === 4) !== undefined);

/* right to left */
check("Hebrew and Arabic are detected as right to left", isRtlText("שלום עולם") && isRtlText("مرحبا بالعالم") && !isRtlText("Hello") && isRtlText("שלום hello"));
const rtl = layoutTitle(measure, titleOf({ text: "שלום עולם", size: 0.1 }), W, H);
check("right to left words are kept whole", rtl.rtl && rtl.glyphs.length === 2 && rtl.glyphs.every((g) => g.rtl && g.ch.length === 4), rtl.glyphs.map((g) => g.ch));
check("the first word of a right to left line is on the right", rtl.glyphs.find((g) => g.word === 0)!.x > rtl.glyphs.find((g) => g.word === 1)!.x, rtl.glyphs.map((g) => [g.word, g.x]));
check("right to left animates by word even when asked by letter", unitsOf(rtl, "char").length === 2);
check("left to right text animates by letter, word, line as asked", unitsOf(layoutTitle(measure, titleOf({ text: "ab cd\nef" }), W, H), "char").length === 6 && unitsOf(layoutTitle(measure, titleOf({ text: "ab cd\nef" }), W, H), "word").length === 3 && unitsOf(layoutTitle(measure, titleOf({ text: "ab cd\nef" }), W, H), "line").length === 2);
check("an accented or emoji letter is one piece", graphemes("é\u{1F1EF}\u{1F1F5}a").length === 3);

/* ---------- animators ---------- */
const A = (preset: (typeof ANIMATOR_PRESETS)[number]["id"], extra = {}) => ({ ...DEFAULT_ANIMATOR, preset, duration: 1, ...extra });
const vis = (a: ReturnType<typeof A>, i: number, n: number, t: number) => unitFx(a, i, n, t, 5);
check("no animator leaves everything at rest", JSON.stringify(vis(A("none"), 0, 4, 0)) === JSON.stringify({ opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0, fill: 0, tint: 0 }));
check("typewriter: nothing at 0, everything at the end, in order", [0, 1, 2, 3].every((i) => vis(A("typewriter"), i, 4, 0).opacity === 0) && [0, 1, 2, 3].every((i) => vis(A("typewriter"), i, 4, 1).opacity === 1) && vis(A("typewriter"), 0, 4, 0.4).opacity === 1 && vis(A("typewriter"), 3, 4, 0.4).opacity === 0);
check("typewriter reveals one letter after the other", (() => { let last = -1; for (let t = 0; t <= 1; t += 0.05) { const shown = [0, 1, 2, 3, 4, 5].filter((i) => vis(A("typewriter"), i, 6, t).opacity === 1).length; if (shown < last) return false; last = shown; } return last === 6; })());
check("word pop grows from small to full size", vis(A("word-pop"), 0, 3, 0).scale < 0.5 && near(vis(A("word-pop"), 0, 3, 1).scale, 1, 1e-6));
check("line slide rises into place", vis(A("line-slide"), 0, 2, 0).dy > 0.5 && vis(A("line-slide"), 0, 2, 1).dy === 0);
check("blur in sharpens", vis(A("blur-in"), 0, 3, 0).blur > 0.2 && vis(A("blur-in"), 0, 3, 1).blur === 0);
check("wave moves letters up and down by their place", vis(A("wave"), 0, 6, 0.3).dy !== vis(A("wave"), 3, 6, 0.3).dy);
check("karaoke fill sweeps from the first to the last", vis(A("karaoke-fill"), 0, 4, 0.5).fill > vis(A("karaoke-fill"), 3, 4, 0.5).fill && vis(A("karaoke-fill"), 3, 4, 1).fill === 1);
check("the range selector limits the animation to part of the text", vis(A("typewriter", { rangeStart: 50, rangeEnd: 100 }), 0, 4, 0).opacity === 1 && vis(A("typewriter", { rangeStart: 50, rangeEnd: 100 }), 3, 4, 0).opacity === 0);
check("the offset shifts the selected part along the text", vis(A("typewriter", { offset: 50 }), 0, 4, 0).opacity === 1 && vis(A("typewriter", { offset: 50 }), 3, 4, 0).opacity === 0);
check("fading out at the end", vis(A("none", { outDuration: 1 }), 0, 1, 4.5).opacity < 0.6 && vis(A("none", { outDuration: 1 }), 0, 1, 2).opacity === 1);
check("every preset has a name, a unit and a duration", ANIMATOR_PRESETS.every((p) => p.name && p.unit && p.duration > 0) && ANIMATOR_PRESETS.length >= 7);

/* ---------- drawing (recorded) ---------- */
type Op = [string, ...unknown[]];
function recorder(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy({}, {
    get: (_t, k: string) => {
      if (k in state) return state[k];
      if (k === "measureText") return (text: string) => ({ width: measure(text, String(state.font ?? "10px x")) });
      if (k === "createLinearGradient" || k === "createRadialGradient") return () => ({ addColorStop: () => undefined });
      if (k === "createImageData") return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      return (...a: unknown[]) => ops.push([k, ...a]);
    },
    set: (_t, k: string, v) => ((state[k] = v), ops.push([`set ${k}`, v]), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}
const texts = (ops: Op[]) => ops.filter((o) => o[0] === "fillText").map((o) => o[1]);
{
  const r = recorder();
  drawTitle(r.ctx, titleOf({ text: "Hi there" }), 1, 5, W, H);
  check("a title paints its letters", texts(r.ops).join("") === "Hithere", texts(r.ops));
}
{
  const r = recorder();
  drawTitle(r.ctx, titleOf({ text: "Hi", animator: A("typewriter", { duration: 2 }) }), 0, 5, W, H);
  check("a typewriter title shows nothing at its first frame", texts(r.ops).length === 0);
}
{
  const r = recorder();
  drawTitle(r.ctx, titleOf({ text: "Hi", box: { color: "#000", padding: 0.02, radius: 0.01, opacity: 0.8 }, strokeWidth: 0.004, shadow: true, glow: 0.01, bevel: true, underline: true }), 1, 5, W, H);
  const names = r.ops.map((o) => o[0]);
  check("box, stroke, shadow, glow, bevel and underline are all painted", names.includes("arcTo") && names.includes("strokeText") && r.ops.some((o) => o[0] === "set shadowBlur" && (o[1] as number) > 0) && names.filter((n) => n === "fillRect").length >= 2, names.slice(0, 40));
}
{
  const r = recorder();
  drawTitle(r.ctx, titleOf({ text: "Hi", gradient: true }), 1, 5, W, H);
  check("a gradient fill paints with a gradient object", r.ops.some((o) => o[0] === "set fillStyle" && typeof o[1] === "object"), r.ops.filter((o) => o[0] === "set fillStyle"));
}
{
  const spec = titleOf({ text: "A\nB", roll: 0.1, autoFit: false });
  const layout = layoutTitle(measure, spec, W, H);
  const dur = rollDuration(spec, layout, H);
  const at = (t: number) => { const r = recorder(); drawTitle(r.ctx, spec, t, dur, W, H); return r.ops.find((o) => o[0] === "translate")![2] as number; };
  check("a credits roll starts below the frame and ends above it", at(0) > H && at(dur) < 0 && at(dur / 2) < at(0), [at(0), at(dur / 2), at(dur)]);
  check("the roll duration matches its speed", rollDuration({ ...spec, roll: 0.2 }, layout, H) < dur && dur > 5);
}

/* ---------- generators ---------- */
check("timecode counts frames", timecode(0, 30) === "00:00:00:00" && timecode(1.5, 30) === "00:00:01:15" && timecode(3661, 25) === "01:01:01:00");
check("timecode does not drop a frame to rounding", timecode(1 / 30, 30) === "00:00:00:01" && timecode(29 / 30, 30) === "00:00:00:29");
check("countdown counts down and holds at 1", countdownAt(5, 0) === 5 && countdownAt(5, 0.99) === 5 && countdownAt(5, 1.01) === 4 && countdownAt(5, 4.5) === 1 && countdownAt(5, 99) === 1);
const hex = polygonPoints(6, 0, 0, 100, 100);
check("a polygon has the corners asked for, first one straight up", hex.length === 6 && near(hex[0][0], 0, 1e-9) && near(hex[0][1], -100, 1e-9) && polygonPoints(2, 0, 0, 1, 1).length === 3 && polygonPoints(40, 0, 0, 1, 1).length === 12);
check("an arrow points right", (() => { const a = arrowPoints(400, 100); return Math.max(...a.map((p) => p[0])) === 200 && a.some((p) => p[0] === 200 && p[1] === 0); })());
check("noise is the same for the same time and different for another", (() => { const a = noiseBytes(8, 8, 3, 100, true, [255, 255, 255]); const b = noiseBytes(8, 8, 3, 100, true, [255, 255, 255]); const c = noiseBytes(8, 8, 4, 100, true, [255, 255, 255]); return a.every((v, i) => v === b[i]) && a.some((v, i) => v !== c[i]); })());
check("mono noise has equal channels", (() => { const a = noiseBytes(4, 4, 1, 100, true, [255, 255, 255]); return a[0] === a[1] && a[1] === a[2]; })());
check("every generator kind but title has a default", GENERATOR_KINDS.filter((g) => g.id !== "title").every((g) => newGenerator(g.id).type === g.id));
{
  const shapes = ["rectangle", "ellipse", "line", "polygon", "arrow"] as const;
  const painted = shapes.map((k) => { const r = recorder(); drawGenerator(r.ctx, { type: "shape", shape: shapeOf(k) }, 0, 5, W, H); return r.ops.map((o) => o[0]); });
  check("every shape paints a path", painted.every((p) => p.includes("beginPath") && (p.includes("fill") || p.includes("stroke"))), painted);
  check("a rectangle has round corners, an ellipse an ellipse", painted[0].includes("arcTo") && painted[1].includes("ellipse"));
  const r = recorder();
  drawGenerator(r.ctx, { type: "solid", color: "#123456" }, 0, 1, W, H);
  check("solid fills the frame", r.ops.some((o) => o[0] === "fillRect" && o[3] === W && o[4] === H) && r.ops.some((o) => o[0] === "set fillStyle" && o[1] === "#123456"));
  const c = recorder();
  drawGenerator(c.ctx, newGenerator("countdown", { from: 3 }), 0.2, 5, W, H);
  check("the countdown shows the number", texts(c.ops).join() === "3");
  const tc = recorder();
  drawGenerator(tc.ctx, newGenerator("timecode"), 2, 5, W, H);
  check("the timecode shows the time", texts(tc.ops).join() === "00:00:02:00");
}

/* ---------- on the timeline and in the compositor ---------- */
class FakeCanvas {
  ctx = recorder();
  constructor(public width: number, public height: number) {}
  getContext() {
    return this.ctx.ctx;
  }
}
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeCanvas;

const track = (id: string, kind: Track["kind"], extra: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, locked: false, solo: false, height: 44, hidden: false, ...extra });
const base: Clip = { id: "x", trackId: "", start: 0, duration: 5, sourceIn: 0, sourceOut: 5, speed: 1, enabled: true, effects: [], keyframes: {} };
function doc(): ProjectDoc {
  const tl: Timeline = {
    id: "t", name: "t", markers: [], textStyle: defaultProject().style, transition: { type: "none", ms: 400 },
    tracks: [track("v-bg", "video"), track("V1", "video"), track("V2", "video"), track("S", "subtitle"), track("a-song", "audio")],
    clips: [{ ...base, id: "c-bg", trackId: "v-bg", duration: 0, fill: true, generator: { type: "gradient", colors: ["#000", "#fff"], angle: 0, noise: false } }],
  };
  return { schemaVersion: 2, settings: { aspect: "16:9", width: 1920, height: 1080, fps: 30, colorSpace: "rec709", sampleRate: 48000 }, media: [], bins: [], activeTimelineId: "t", timelines: [tl] };
}

{
  const lt = buildTemplate("lower-third");
  check("every template builds with its default text", TITLE_TEMPLATES.every((t) => buildTemplate(t.id).length >= 1 && buildTemplate(t.id).every((p) => p.duration > 0 && p.generator)));
  check("a lower third is a bar and a text box", lt.length === 2 && lt[0].generator.type === "shape" && lt[1].generator.type === "title");
  const typed = buildTemplate("lower-third", { name: "Ada Lovelace", role: "Mathematician" });
  const t = (typed[1].generator as { title: { text: string; runs: { start: number; end: number }[] } }).title;
  check("template fields fill the text, and the role run follows the name", t.text === "Ada Lovelace\nMathematician" && t.runs[0].start === 13 && t.runs[0].end === 26, t);
  check("the accent colour field reaches the bar", (buildTemplate("lower-third", { color: "#ff0000" })[0].generator as { shape: { fill: string } }).shape.fill === "#ff0000");
  check("a bad accent colour falls back to the default", (buildTemplate("lower-third", { color: "red" })[0].generator as { shape: { fill: string } }).shape.fill === "#ffd84a");
  const roll = buildTemplate("credits-roll");
  check("a credits roll is as long as its scroll needs", roll[0].duration > 5 && (roll[0].generator as { title: { roll: number } }).title.roll > 0, roll[0].duration);
  check("a slower roll takes longer", buildTemplate("credits-roll", { speed: "0.05" })[0].duration > buildTemplate("credits-roll", { speed: "0.2" })[0].duration);
  const sb = buildTemplate("scoreboard", { home: "TIG", away: "LIO", homeScore: "12", awayScore: "9" });
  check("the scoreboard puts the score in the middle", (sb[0].generator as { title: { text: string } }).title.text === "TIG  12 - 9  LIO");
  let threw = "";
  try { buildTemplate("nope"); } catch (e) { threw = (e as Error).message; }
  check("an unknown template says which exist", /lower-third/.test(threw), threw);
}

{
  const d = doc();
  const r = addGeneratorClips(activeTimeline(d), buildTemplate("lower-third"), 2);
  const clips = r.tl.clips.filter((c) => r.ids.includes(c.id));
  check("a template adds its clips at the playhead", clips.length === 2 && clips.every((c) => c.start === 2 && c.duration === 4), clips);
  check("the bar and the text sit on different tracks, text above", clips[0].trackId !== clips[1].trackId && r.tl.tracks.findIndex((t) => t.id === clips[1].trackId) > r.tl.tracks.findIndex((t) => t.id === clips[0].trackId));
  check("the lyric background track is never used", clips.every((c) => c.trackId !== "v-bg"));
  check("free video tracks are used before new ones are made", r.tl.tracks.filter((t) => t.kind === "video").length === 3, r.tl.tracks.map((t) => t.id));
  const again = addGeneratorClips(r.tl, buildTemplate("lower-third"), 3);
  check("a busy time gets new tracks on top", again.tl.tracks.filter((t) => t.kind === "video").length === 5);
  const locked = { ...activeTimeline(d), tracks: activeTimeline(d).tracks.map((t) => (t.id === "V1" ? { ...t, locked: true } : t)) };
  check("locked tracks are skipped", addGeneratorClips(locked, buildTemplate("centred-title"), 0).tl.clips.at(-1)!.trackId !== "V1");
}

{
  const d = doc();
  const { tl, ids } = addGeneratorClips(activeTimeline(d), [{ name: "Box", generator: { type: "shape", shape: shapeOf("rectangle") }, duration: 3 }, { name: "T", generator: { type: "title", title: titleOf({ text: "Hi" }) }, duration: 3 }], 1);
  const d2: ProjectDoc = { ...d, timelines: [tl] };
  check("generator clips are visuals; the fill background is not", activeVisuals(tl, d2, 2).map((x) => x.clip.name).join() === "Box,T" && activeVisuals(tl, d2, 2).every((x) => x.kind === "generator"));
  check("they are not there before they start or after they end", activeVisuals(tl, d2, 0.5).length === 0 && activeVisuals(tl, d2, 4.5).length === 0);
  check("export does not try to decode them", needsAt(d2, 2).length === 0);
  check("the plan holds them bottom track first", visualPlan(tl, d2, 2).map((i) => (i.type === "clip" ? i.v.clip.name : "")).join() === "Box,T");
  const off = { ...tl, clips: tl.clips.map((c) => (c.id === ids[0] ? { ...c, enabled: false } : c)) };
  check("a disabled generator clip is skipped", activeVisuals(off, d2, 2).length === 1);
  const r = recorder();
  const missing = compositeVisuals(r.ctx, d2, 2, 1920, 1080, { picture: () => null });
  const imgs = r.ops.filter((o) => o[0] === "drawImage");
  check("the compositor draws each generator through its transform", missing === 0 && imgs.length === 2, r.ops.map((o) => o[0]));
  const fx = { ...tl, clips: tl.clips.map((c) => (c.id === ids[0] ? { ...c, effects: [newEffect("invert")] } : c)) };
  const r2 = recorder();
  compositeVisuals(r2.ctx, { ...d2, timelines: [fx] }, 2, 1920, 1080, { picture: () => null });
  check("effects run on generator clips", r2.ops.filter((o) => o[0] === "drawImage").length >= 2);
  check("editing a generator changes only its fields", (() => { const t2 = updateGenerator(tl, ids[0], (g) => (g.type === "shape" ? { ...g, shape: { ...g.shape, fill: "#f00" } } : g)); const c = t2.clips.find((x) => x.id === ids[0])!.generator as { shape: { fill: string } }; return c.shape.fill === "#f00" && t2.clips.find((x) => x.id === ids[1]) === tl.clips.find((x) => x.id === ids[1]); })());
}

/* lyric projects keep their look */
{
  const p = defaultProject();
  const d = viewToDoc({ ...p, lines: [{ id: "l1", text: "hello", start: 0, end: 2 }] }, undefined);
  const withTitle: ProjectDoc = { ...d, timelines: [addGeneratorClips(activeTimeline(d), buildTemplate("centred-title"), 0).tl] };
  const view = docToView(withTitle);
  check("a title on the timeline does not change the lyric view", JSON.stringify(view.lines) === JSON.stringify(docToView(d).lines) && JSON.stringify(view.style) === JSON.stringify(docToView(d).style) && JSON.stringify(view.background) === JSON.stringify(docToView(d).background));
  const back = viewToDoc(view, withTitle);
  check("and the title clip survives a trip through the lyric editor", activeTimeline(back).clips.some((c) => c.generator?.type === "title"));
}

if (fails) process.exit(1);
console.log("all passed");
