// Phase 27: keymap, command registry and search, key focus rules, pages and layouts, page switching keeps the project.
import { PROFILES, applyProfile, bind, comboFromEvent, conflicts, formatCombo, indexBindings, keymapFromJson, keymapToJson, normalizeCombo, resetBindings, resolveBindings, unbind } from "../src/lib/commands/keymap";
import { defaultBindings, register, score, search, runCommand, type Command } from "../src/lib/commands/registry";
import { blocked, commandFor, isPressable, isTyping } from "../src/lib/commands/focus";
import { DEFAULT_PAGE, LAYOUT_PRESETS, PAGES, compactLayouts, layoutFor, layoutsFromJson, layoutsToJson, pageById, sanitizeLayout, stepPage } from "../src/lib/workspace/pages";
import { useWorkspace, sectionOf } from "../src/store/workspace";
import { usePrefs } from "../src/store/prefs";
import { useProject } from "../src/store/project";
import { useTimelineUi } from "../src/timeline/ui";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const ev = (code: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });

/* ---------- combos ---------- */
check("letter by physical key", comboFromEvent(ev("KeyK")) === "K");
check("modifiers in a fixed order", comboFromEvent(ev("KeyK", { shiftKey: true, ctrlKey: true, altKey: true })) === "Ctrl+Alt+Shift+K");
check("Cmd counts as Ctrl", comboFromEvent(ev("KeyZ", { metaKey: true })) === "Ctrl+Z");
check("bare modifier is nothing", comboFromEvent(ev("ShiftLeft", { shiftKey: true })) === null);
check("digits, function keys, arrows, punctuation", comboFromEvent(ev("Digit3", { altKey: true })) === "Alt+3" && comboFromEvent(ev("F9")) === "F9" && comboFromEvent(ev("ArrowDown", { shiftKey: true })) === "Shift+Down" && comboFromEvent(ev("Slash", { ctrlKey: true })) === "Ctrl+/");
check("typed combos normalise", normalizeCombo("cmd + shift + k") === "Ctrl+Shift+K" && normalizeCombo("escape") === "Esc" && normalizeCombo("alt+x") === "Alt+X" && normalizeCombo("f11") === "F11");
check("bad combos are rejected", normalizeCombo("") === null && normalizeCombo("ctrl+") === null && normalizeCombo("a+b") === null && normalizeCombo("banana") === null);
check("display", formatCombo("Ctrl+Shift+K") === "Ctrl+Shift+K" && formatCombo("Ctrl+Alt+K", true) === "Cmd Option K");

/* ---------- binding ---------- */
const defs = { "tool.select": ["V", "A"], "tool.blade": ["B"], "snap.toggle": ["S", "N"], "edit.undo": ["Ctrl+Z"] };
check("no overrides: defaults", JSON.stringify(resolveBindings(defs, {})) === JSON.stringify(defs));
const r1 = bind(defs, {}, "tool.blade", "C");
check("add a key", resolveBindings(defs, r1.overrides)["tool.blade"].join() === "B,C" && r1.stolenFrom.length === 0);
const r2 = bind(defs, r1.overrides, "tool.blade", "V");
check("taking a key removes it from its owner", resolveBindings(defs, r2.overrides)["tool.select"].join() === "A" && r2.stolenFrom.join() === "tool.select");
check("no conflicts after rebinding", conflicts(resolveBindings(defs, r2.overrides)).length === 0);
check("conflicts are found", conflicts({ a: ["X"], b: ["X", "Y"], c: ["Y"] }).length === 2);
check("binding the same key twice changes nothing", Object.keys(bind(defs, {}, "tool.blade", "B").overrides).length === 0);
check("remove a key", resolveBindings(defs, unbind(defs, {}, "snap.toggle", "N"))["snap.toggle"].join() === "S");
check("an empty list means unbound", resolveBindings(defs, unbind(defs, unbind(defs, {}, "snap.toggle", "N"), "snap.toggle", "S"))["snap.toggle"].length === 0);
check("reset one and all", !("tool.blade" in resetBindings(r1.overrides, "tool.blade")) && Object.keys(resetBindings(r1.overrides)).length === 0);
check("index lists holders", indexBindings(defs).get("S")?.join() === "snap.toggle");

/* ---------- profiles and files ---------- */
const real = { "tool.select": ["V", "A"], "tool.blade": ["B"], "tool.trim": ["T"], "edit.bladeAtPlayhead": ["Ctrl+B"], "snap.toggle": ["S", "N"], "marker.add": ["M"] };
const prem = applyProfile(real, PROFILES.find((p) => p.id === "premiere")!);
const pb = resolveBindings(real, prem);
check("premiere profile: C blades, V selects, no clashes", pb["tool.blade"].join() === "C" && pb["tool.select"].join() === "V" && pb["edit.bladeAtPlayhead"].join() === "Ctrl+K" && conflicts(pb).length === 0, pb);
check("default profile changes nothing", Object.keys(applyProfile(real, PROFILES[0])).length === 0);
const file = keymapToJson(r1.overrides);
const back = keymapFromJson(file, new Set(Object.keys(defs)));
check("keymap round trip", !!back && back.overrides["tool.blade"].join() === "B,C" && back.skipped === 0);
const dirty = keymapFromJson(JSON.stringify({ bindings: { "tool.blade": ["ctrl+j", "nonsense key"], ghost: ["X"] } }), new Set(Object.keys(defs)));
check("import skips unknown commands and bad combos", !!dirty && dirty.overrides["tool.blade"].join() === "Ctrl+J" && dirty.skipped === 2, dirty);
check("import rejects junk", keymapFromJson("nope", new Set()) === null && keymapFromJson("[1]", new Set()) === null);

/* ---------- registry and search ---------- */
const ran: string[] = [];
const cmd = (id: string, title: string, o: Partial<Command> = {}): Command => ({ id, title, category: "Edit", run: () => void ran.push(id), ...o });
register(cmd("t.blade", "Blade tool", { keys: ["B"], keywords: "razor cut" }), cmd("t.snap", "Toggle snapping", { keys: ["S"] }), cmd("t.off", "Hidden one", { enabled: () => false }), cmd("t.decline", "Declines", { run: () => false }));
const all = [...["t.blade", "t.snap", "t.off", "t.decline"].map((id) => ({ id }))].length;
check("default bindings come from the registry", defaultBindings()["t.blade"]?.join() === "B" && !("t.off" in defaultBindings()) && all === 4);
check("score: exact > prefix > inside > letters in order > none", score("blade", "Blade") > score("bla", "Blade tool") && score("bla", "Blade tool") > score("lad", "Blade tool") && score("lad", "Blade tool") > score("bde", "Blade tool") && score("xyz", "Blade tool") === 0);
const list = [cmd("a", "Toggle snapping"), cmd("b", "Blade tool", { keywords: "razor" }), cmd("c", "Go to the Color page"), cmd("d", "Hidden", { enabled: () => false })];
check("search finds by title, keyword and letters", search("snap", list)[0].id === "a" && search("razor", list)[0].id === "b" && search("tgl snp", list)[0]?.id === "a");
check("disabled commands are hidden", !search("", list).some((c) => c.id === "d"));
check("empty query keeps order, recent first", search("", list).map((c) => c.id).join() === "a,b,c" && search("", list, ["c"])[0].id === "c");
check("category is searchable", search("edit blade", list).some((c) => c.id === "b"));

/* ---------- key focus rules ---------- */
const field = { tag: "INPUT", type: "text", editable: false };
const button = { tag: "BUTTON", editable: false };
const range = { tag: "INPUT", type: "range", editable: false };
const body = { tag: "BODY", editable: false };
const off = { sync: false, overlay: false };
check("typing fields are detected", isTyping(field) && isTyping({ tag: "TEXTAREA", editable: false }) && isTyping({ tag: "DIV", editable: true }) && !isTyping(range) && !isTyping(button) && !isTyping(body));
check("pressable controls", isPressable(button) && isPressable({ tag: "DIV", editable: false, role: "tab" }) && !isPressable(body));
check("plain keys are left to text fields", blocked(field, {}, "B", off) && !blocked(body, {}, "B", off));
check("global commands work while typing", !blocked(field, { global: true }, "Ctrl+K", off));
check("Space on a button presses it, unless the command asks", blocked(button, {}, "Space", off) && !blocked(button, { fromButtons: true }, "Space", off) && !blocked(button, {}, "B", off));
check("Space works on a range slider", !blocked(range, {}, "Space", off));
check("tap-sync owns the keyboard", blocked(body, {}, "Space", { sync: true, overlay: false }) && !blocked(body, { inSync: true }, "Space", { sync: true, overlay: false }));
check("an open dialog owns the keyboard", blocked(body, {}, "B", { sync: false, overlay: true }) && !blocked(body, { global: true }, "Ctrl+K", { sync: false, overlay: true }));
const bnd = { "t.blade": ["B"], "t.other": ["B"], "t.snap": ["S"] };
check("first enabled holder wins", commandFor("B", bnd, () => true) === "t.blade" && commandFor("B", bnd, (id) => id !== "t.blade") === "t.other" && commandFor("Q", bnd, () => true) === undefined);

/* ---------- running ---------- */
await runCommand("t.blade");
check("runCommand runs", ran.includes("t.blade"));
check("disabled and unknown commands do not run", !(await runCommand("t.off")) && !(await runCommand("nope")) && !ran.includes("t.off"));
check("a command that declines reports it", (await runCommand("t.decline")) === false);

/* ---------- pages and layouts ---------- */
check("eight pages in order", PAGES.map((p) => p.id).join() === "media,cut,edit,motion,color,audio,lyrics,deliver");
check("page ids and shapes are valid", PAGES.every((p) => JSON.stringify(sanitizeLayout(p.layout, p.layout)) === JSON.stringify(p.layout)));
check("unknown page falls back", pageById("nope").id === DEFAULT_PAGE);
check("sanitize clamps and fills", (() => { const l = sanitizeLayout({ leftW: 9999, timelineH: -5, left: "x" }, pageById("edit").layout); return l.leftW === 480 && l.timelineH === 120 && l.left === true; })());
check("page switching wraps", stepPage("deliver", 1) === "media" && stepPage("media", -1) === "deliver");
check("only changes are saved", Object.keys(compactLayouts({ edit: pageById("edit").layout })).length === 0 && Object.keys(compactLayouts({ edit: { ...pageById("edit").layout, leftW: 400 } })).length === 1);
check("layout file round trip", (() => { const j = layoutsToJson({ color: { ...pageById("color").layout, timeline: false } }); return layoutsFromJson(j)?.color?.timeline === false && layoutsFromJson("bad") === null; })());
check("presets give valid layouts", LAYOUT_PRESETS.every((p) => { const l = p.apply(pageById("edit").layout); return JSON.stringify(sanitizeLayout(l, l)) === JSON.stringify(l); }));
check("saved layout wins over the page's", layoutFor("edit", { edit: { ...pageById("edit").layout, leftW: 333 } }).leftW === 333 && layoutFor("edit", {}).leftW === pageById("edit").layout.leftW);

/* ---------- store: switching pages leaves the project alone ---------- */
const ws = useWorkspace.getState();
ws.resetAll();
useProject.getState().update((p) => ({ ...p, fps: 60 }));
useTimelineUi.setState({ selected: ["clip-1"] });
const before = { doc: useProject.getState().doc, past: useProject.getState().past.length, sel: useTimelineUi.getState().selected };
for (const p of PAGES) useWorkspace.getState().setPage(p.id);
useWorkspace.getState().setPage("cut");
const after = { doc: useProject.getState().doc, past: useProject.getState().past.length, sel: useTimelineUi.getState().selected };
check("switching pages keeps document, undo history and selection", before.doc === after.doc && before.past === after.past && before.sel === after.sel);
check("page opens on its own section until the user picks one", sectionOf(useWorkspace.getState()) === pageById("cut").section);
useWorkspace.getState().setSection("captions");
useWorkspace.getState().setPage("edit");
useWorkspace.getState().setPage("cut");
check("the section chosen on a page is remembered there", sectionOf(useWorkspace.getState()) === "captions");
useWorkspace.getState().setLayout({ leftW: 400 });
check("layout edits belong to the open page", useWorkspace.getState().layout().leftW === 400 && (useWorkspace.getState().setPage("edit"), useWorkspace.getState().layout().leftW === pageById("edit").layout.leftW));
useWorkspace.getState().setPage("cut");
useWorkspace.getState().applyPreset("minimal");
check("layout preset applies to the page", !useWorkspace.getState().layout().left && !useWorkspace.getState().layout().timeline);
useWorkspace.getState().resetPage();
check("reset page restores its layout", JSON.stringify(useWorkspace.getState().layout()) === JSON.stringify(pageById("cut").layout));
check("layouts export and import through the store", (() => { const w = useWorkspace.getState(); w.setLayout({ timelineH: 500 }); const t = w.exportLayouts(); w.resetAll(); return w.importLayouts(t) && useWorkspace.getState().layout().timelineH === 500 && !w.importLayouts("x"); })());

/* ---------- store: preferences ---------- */
const prefs = usePrefs.getState();
prefs.resetKeys();
const stolen = usePrefs.getState().addKey("t.snap", "B");
check("prefs: rebinding steals and reports", stolen.includes("t.blade") && usePrefs.getState().bindings()["t.snap"].includes("B") && !usePrefs.getState().bindings()["t.blade"].includes("B"), stolen);
usePrefs.getState().resetKeys("t.snap");
usePrefs.getState().resetKeys("t.blade");
check("prefs: reset one command puts the key back", usePrefs.getState().bindings()["t.snap"].join() === "S");
usePrefs.getState().importKeymap(JSON.stringify({ bindings: { "t.blade": ["Ctrl+J"] } }));
check("prefs: import applies", usePrefs.getState().bindings()["t.blade"].join() === "Ctrl+J" && !usePrefs.getState().importKeymap("junk").ok);
usePrefs.getState().resetKeys();
usePrefs.getState().noteRun("a");
usePrefs.getState().noteRun("b");
usePrefs.getState().noteRun("a");
check("prefs: recent commands, newest first, no repeats", usePrefs.getState().recent.join() === "a,b");
usePrefs.getState().setContrast("high");
usePrefs.getState().setTextScale(1.3);
usePrefs.getState().setMotion("reduce");
check("prefs: accessibility options are stored", usePrefs.getState().contrast === "high" && usePrefs.getState().textScale === 1.3 && usePrefs.getState().motion === "reduce");

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
