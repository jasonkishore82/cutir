// Phase 19 (rest): new animator presets, the custom animator, saved title presets, per-range fonts, title chat tools.
import { ANIMATOR_PRESETS, DEFAULT_ANIMATOR, DEFAULT_FROM, layoutTitle, titleOf, unitFx, type Measure } from "../src/lib/titles";
import { deletePreset, loadPresets, savePreset, titleFromPreset } from "../src/lib/titlePresets";
import { applyCalls } from "../src/lib/tools/index";
import { useProject, defaultProject } from "../src/store/project";
import { activeTimeline, viewToDoc } from "../src/model/convert";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
const anim = (preset: string, extra = {}) => ({ ...DEFAULT_ANIMATOR, preset: preset as never, duration: 1, ...extra });

/* ---------- presets that drive rotation, position and colour ---------- */
const at = (preset: string, t: number, i = 0, n = 1, extra = {}) => unitFx(anim(preset, extra), i, n, t, 10);
check("spin in: starts turned and small, ends upright at full size", at("spin-in", 0.001).rotation !== 0 && at("spin-in", 0.001).scale < 0.5 && near(at("spin-in", 1.6).rotation, 0) && near(at("spin-in", 1.6).scale, 1), [at("spin-in", 0.001), at("spin-in", 1.6)]);
check("slide in: starts left of its place and settles at 0", at("slide-in", 0.001).dx < -1 && near(at("slide-in", 1.6).dx, 0), at("slide-in", 0.001));
check("drop in: starts above and tilted, ends at rest", at("drop-in", 0.001).dy < -0.5 && at("drop-in", 0.001).rotation !== 0 && near(at("drop-in", 1.6).dy, 0, 1e-3) && near(at("drop-in", 1.6).rotation, 0, 1e-3));
const flash = [0.001, 0.25, 0.5, 0.75, 1.6].map((t) => at("colour-flash", t).tint);
check("colour flash mixes the second colour in while a piece arrives, then returns to the base", Math.max(...flash) > 0.5 && near(flash[flash.length - 1], 0), flash);
check("every preset in the list has a working id", ANIMATOR_PRESETS.every((p) => typeof unitFx(anim(p.id), 0, 3, 0.5, 5).opacity === "number"));

/* ---------- the custom animator ---------- */
const from = { opacity: 0.2, dx: 2, dy: -1, scale: 3, rotation: 90, blur: 0.5, tint: 1 };
const c0 = unitFx(anim("custom", { from }), 0, 1, 0.0001, 10);
const c1 = unitFx(anim("custom", { from }), 0, 1, 5, 10);
check("custom starts at the from look", near(c0.opacity, 0.2, 1e-2) && near(c0.dx, 2, 1e-2) && near(c0.dy, -1, 1e-2) && near(c0.scale, 3, 1e-2) && near(c0.rotation, 90, 0.5) && near(c0.blur, 0.5, 1e-2) && near(c0.tint, 1, 1e-2), c0);
check("custom ends at rest", near(c1.opacity, 1) && near(c1.dx, 0) && near(c1.dy, 0) && near(c1.scale, 1) && near(c1.rotation, 0) && near(c1.blur, 0) && near(c1.tint, 0), c1);
check("custom without a from uses the default look", unitFx(anim("custom"), 0, 1, 0.0001, 10).dy > DEFAULT_FROM.dy * 0.9);
check("the range selector still limits a custom animation", (() => {
  const a = anim("custom", { from, rangeStart: 50, rangeEnd: 100 });
  return near(unitFx(a, 0, 4, 0.0001, 10).opacity, 1) && unitFx(a, 3, 4, 0.0001, 10).opacity < 0.5;
})());

/* ---------- saved presets ---------- */
const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
check("nothing saved yet", loadPresets(store).length === 0);
const styled = titleOf({ text: "Original", runs: [{ start: 0, end: 3, color: "#f00" }], font: "Anton", color: "#ff0000", glow: 0.02, animator: anim("spin-in") });
const list = savePreset("Neon", styled, store);
check("a preset is saved and reloads", list.length === 1 && loadPresets(store)[0].name === "Neon");
check("the saved look has no words or styled ranges", !("text" in list[0].look) && !("runs" in list[0].look), Object.keys(list[0].look));
const again = titleFromPreset(loadPresets(store)[0], "New words");
check("adding a preset uses the new words and keeps the look", again.text === "New words" && again.font === "Anton" && again.color === "#ff0000" && again.glow === 0.02 && again.animator.preset === "spin-in" && again.runs.length === 0, again);
check("saving the same name replaces it", savePreset("neon", titleOf({ font: "Lobster" }), store).length === 1 && loadPresets(store)[0].look.font === "Lobster");
check("an empty name is refused", (() => { try { savePreset("  ", styled, store); return false; } catch { return true; } })());
check("a preset can be deleted", deletePreset(loadPresets(store)[0].id, store).length === 0 && loadPresets(store).length === 0);
mem.set("cutir.titlePresets.v1", "not json");
check("a broken store reads as empty", loadPresets(store).length === 0);
check("no storage at all is fine", loadPresets(null).length === 0);

/* ---------- a font on part of the text ---------- */
{
  const m: Measure = (text) => text.length * 10;
  const l = layoutTitle(m, titleOf({ text: "ab", runs: [{ start: 1, end: 2, font: "Lobster" }] }), 1920, 1080);
  check("a run's font is used for its letters only", l.glyphs[0].font.includes("Inter") && l.glyphs[1].font.includes("Lobster"), l.glyphs.map((g) => g.font));
}

/* ---------- chat tools ---------- */
const st = () => useProject.getState();
const tl = () => activeTimeline(st().doc);
const run = async (tool: string, args: unknown) => (await applyCalls([{ tool, args }])).results[0];
st().loadDoc(viewToDoc({ ...defaultProject(), lines: [{ id: "l1", text: "hi", start: 0, end: 2, layerId: "main" }] }));

const t1 = await run("add_title", { text: "Summer 2026", at: 3, duration: 4, color: "yellow", size: 12, animation: "spin-in", glow: 20 });
const clip = tl().clips.find((c) => c.generator?.type === "title" && c.start === 3);
const g1 = clip?.generator?.type === "title" ? clip.generator.title : undefined;
check("add_title puts a title clip at the time", t1.ok && !!clip && clip.duration === 4, t1);
check("and applies the look", g1?.text === "Summer 2026" && g1.color === "#ffd84a" && near(g1.size, 0.12) && g1.animator.preset === "spin-in" && g1.animator.unit === "char" && near(g1.glow, 0.02), g1);
const t2 = await run("update_title", { clip: clip!.id, text: "Winter", font: "Anton", animation: "word-pop", by: "line" });
const g2 = (() => { const c = tl().clips.find((x) => x.id === clip!.id); return c?.generator?.type === "title" ? c.generator.title : undefined; })();
check("update_title changes words and look, keeping the rest", t2.ok && g2?.text === "Winter" && g2.font === "Anton" && g2.animator.preset === "word-pop" && g2.animator.unit === "line" && g2.color === "#ffd84a", g2);
check("update_title on a missing clip explains", !(await run("update_title", { clip: "nope", text: "x" })).ok);
const plain = tl().clips.find((c) => !c.generator);
check("update_title refuses a clip that is not a title", !plain || !(await run("update_title", { clip: plain.id, text: "x" })).ok);
const before = tl().clips.length;
const t3 = await run("add_title_template", { template: "lower-third", fields: { name: "Ana Ruiz", role: "Editor" }, at: 10 });
check("add_title_template adds the recipe's clips", t3.ok && tl().clips.length > before, t3);
check("with the fields filled in", tl().clips.some((c) => c.generator?.type === "title" && c.generator.title.text.startsWith("Ana Ruiz")));
const bad = await run("add_title_template", { template: "nope" });
check("an unknown template lists the known ones", !bad.ok && /lower-third/.test(bad.summary), bad);
check("an unknown field is reported", !(await run("add_title_template", { template: "lower-third", fields: { colour: "x" } })).ok);

if (fails) process.exit(1);
console.log("all passed");
