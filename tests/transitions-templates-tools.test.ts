// Phase 10 checks: tool calls (as a model would send them), routing, transitions and templates.
import { registry, selectToolGroups } from "../src/lib/tools/index";
import { handoverAt } from "../src/lib/renderer";
import { BUILTIN_TEMPLATES, applyTemplateTo } from "../src/lib/templates";
import { defaultProject, resolveStyle, type Project } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
}

const base = (): Project => ({
  ...defaultProject(),
  lines: [1, 2, 3, 4].map((n) => ({ id: `l${n}`, text: `line ${n} words here`, start: (n - 1) * 3, end: (n - 1) * 3 + 2.8, layerId: "main" })),
});

/** What applyCalls does, minus the store: normalize, validate, apply. */
function call(p: Project, tool: string, args: unknown): Project {
  const def = registry.get(tool);
  if (!def) throw new Error(`no tool ${tool}`);
  const a = def.normalize ? def.normalize(args) : args;
  const parsed = def.params.safeParse(a);
  if (!parsed.success) throw new Error(`${tool}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return def.apply(p, parsed.data).project;
}
const tryCall = (p: Project, tool: string, args: unknown) => {
  try {
    return call(p, tool, args);
  } catch (e) {
    return (e as Error).message;
  }
};

// routing
const groups = (t: string) => selectToolGroups(t, base());
check("'Move line 3 to the top left' offers transform", groups("Move line 3 to the top left").includes("transform"));
check("'make line 2 spin in' offers style (animation slots)", groups("make line 2 spin in").includes("style"));
check("'crossfade between all lines' offers motion", groups("crossfade between all lines").includes("motion"));
check("plain colour request offers neither extra group", !groups("make the text pink").some((g) => g === "transform" || g === "motion"), groups("make the text pink"));
check("set_animation is not offered but still callable", !registry.list().some((t) => t.name === "set_animation") && !!registry.get("set_animation"));

// "Move line 3 to the top left" in the shapes models send
for (const args of [{ index: 3, place: "top-left" }, { line: "3", position: "top left" }, { index: 3, location: "upper left corner" }]) {
  const p = tryCall(base(), "move_text", args);
  const s = typeof p === "string" ? null : resolveStyle(p, p.lines[2]).transform;
  check(`move_text ${JSON.stringify(args)}`, !!s && s.x === 0.25 && s.y === 0.15, p);
}
const moved = call(base(), "move_text", { index: 3, place: "top-left" });
check("move_text touches only line 3", resolveStyle(moved, moved.lines[1]).transform.x === undefined);

// "make line 2 spin in"
for (const args of [{ index: 2, effect: "rotate" }, { line: 2, name: "spin" }, { index: "2", animation: "Spin", durationMs: "600" }]) {
  const p = tryCall(base(), "set_animation_in", args);
  const a = typeof p === "string" ? null : resolveStyle(p, p.lines[1]).animation.in;
  check(`set_animation_in ${JSON.stringify(args)}`, a?.name === "rotate", p);
}
const spun = call(base(), "set_animation_in", { index: 2, effect: "spin" });
check("spin in leaves line 1 alone", resolveStyle(spun, spun.lines[0]).animation.in.name === "fade");
check("word-highlight cannot be an exit", typeof tryCall(base(), "set_animation_out", { effect: "word-highlight" }) === "string");

// "crossfade between all lines"
for (const args of [{ type: "crossfade" }, { type: "cross fade", gap_index: "all" }, { transition: "dissolve", duration: 600 }]) {
  const p = tryCall(base(), "set_transition", args);
  check(`set_transition ${JSON.stringify(args)}`, typeof p !== "string" && p.transition.type === "crossfade", p);
}
const one = call(base(), "set_transition", { gap_index: 2, type: "zoom-through", ms: 500 });
check("set_transition on one gap", one.lines[1].transition?.type === "zoom-through" && one.transition.type === "none");
check("set_transition on a gap that does not exist fails", typeof tryCall(base(), "set_transition", { gap_index: 4, type: "crossfade" }) === "string");

// keyframes and placement tools
const kf = call(base(), "add_keyframe", { index: 1, time: 1, x: 10, opacity: 0.5 });
check("add_keyframe with flat props", kf.lines[0].keyframes?.[0].props.x === 0.1 && kf.lines[0].keyframes?.[0].props.opacity === 0.5, kf.lines[0].keyframes);
check("clear_keyframes", !call(kf, "clear_keyframes", { index: 1 }).lines[0].keyframes);
const sc = call(base(), "scale_text", { index: 1, scale: 150 });
check("scale_text 150 means 1.5", resolveStyle(sc, sc.lines[0]).transform.scale === 1.5);
check("rotate_text", call(base(), "rotate_text", { degrees: -10 }).style.transform.rotation === -10);

// transitions: window centred on the gap, both lines involved
const tp = { ...base(), transition: { type: "crossfade" as const, ms: 400 } };
const L = tp.lines; // gap between l1 (ends 2.8) and l2 (starts 3.0), mid 2.9, window 2.7..3.1
check("no handover before the window", handoverAt(tp, L, 2.6) === null);
const h = handoverAt(tp, L, 2.9);
check("handover in the middle of the gap", !!h && h.from.id === "l1" && h.to.id === "l2" && Math.abs(h.p - 0.5) < 1e-6, h);
check("no handover after the window", handoverAt(tp, L, 3.15) === null);
check("lines too far apart just cut", handoverAt({ ...tp, transition: { type: "crossfade", ms: 100 } }, L, 2.9) === null);
check("a line's own transition wins", handoverAt({ ...tp, lines: [{ ...L[0], transition: { type: "none", ms: 400 } }, ...L.slice(1)] }, tp.lines, 2.9) !== null);
check("a line's own 'none' cuts", handoverAt(tp, [{ ...L[0], transition: { type: "none", ms: 400 } }, ...L.slice(1)], 2.9) === null);

// templates
for (const t of BUILTIN_TEMPLATES) {
  const p = applyTemplateTo(base(), { scope: "project" }, t);
  check(`template ${t.name} applies`, p.style.fontFamily === t.style.fontFamily && p.style.animation.in.name === t.style.animation?.in?.name);
}
const kar = applyTemplateTo(base(), { scope: "line", ids: ["l2"] }, BUILTIN_TEMPLATES[0]);
check("template on one line only", resolveStyle(kar, kar.lines[1]).highlight.tint && !resolveStyle(kar, kar.lines[0]).highlight.tint);
check("apply_template unknown name fails at validation-free apply", typeof tryCall(base(), "apply_template", { name: "Nope" }) === "string");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
