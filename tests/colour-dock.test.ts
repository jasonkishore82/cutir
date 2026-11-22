// Phase 20 rest: stills kept with the project, and the colour dock in the page layout.
import { MAX_STILLS, MAX_STILL_CHARS, loadStills, saveStills, stillsKey, type Still } from "../src/lib/stills";
import { LAYOUT_PRESETS, PAGES, compactLayouts, layoutFor, layoutsFromJson, layoutsToJson, pageById, sanitizeLayout } from "../src/lib/workspace/pages";
import { getCommand } from "../src/lib/commands/registry";
import "../src/lib/commands/builtin";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
};

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const still = (i: number, size = 100): Still => ({ id: `s${i}`, name: `Still ${i}`, url: `data:image/jpeg;base64,${"A".repeat(size)}`, grade: [{ id: `e${i}`, type: "grade", enabled: true, params: { contrast: i } }] });

/* ---------- stills with the project ---------- */
const store = memory();
check("a project with no stills loads none", loadStills("p1", store).length === 0);
saveStills("p1", [still(1), still(2)], store);
check("stills are saved under the project's own key", store.m.has(stillsKey("p1")) && !store.m.has(stillsKey("p2")));
const back = loadStills("p1", store);
check("stills come back with their image, name and grade", back.length === 2 && back[1].name === "Still 2" && (back[1].grade[0].params as { contrast: number }).contrast === 2 && back[0].url.startsWith("data:image/jpeg"));
check("another project does not see them", loadStills("p2", store).length === 0);
saveStills("p1", [], store);
check("saving none removes the key", !store.m.has(stillsKey("p1")));

const many = Array.from({ length: MAX_STILLS + 6 }, (_, i) => still(i));
const kept = saveStills("p3", many, store);
check(`at most ${MAX_STILLS} are kept, the newest`, kept.length === MAX_STILLS && kept[0].id === "s6" && kept[kept.length - 1].id === `s${MAX_STILLS + 5}`);
const big = Array.from({ length: 6 }, (_, i) => still(i, Math.floor(MAX_STILL_CHARS / 4)));
const keptBig = saveStills("p4", big, store);
check("old stills are dropped to stay under the size limit", keptBig.length < 6 && keptBig.reduce((n, s) => n + s.url.length, 0) <= MAX_STILL_CHARS && keptBig[keptBig.length - 1].id === "s5", keptBig.length);
check("a single huge still is still kept", saveStills("p5", [still(1, MAX_STILL_CHARS * 2)], store).length === 1);

store.setItem(stillsKey("bad"), "{not json");
check("damaged data loads as no stills", loadStills("bad", store).length === 0);
store.setItem(stillsKey("junk"), JSON.stringify([{ id: 1 }, null, still(9), { id: "x", name: "n", url: "http://evil/x.png", grade: [] }]));
check("entries that are not images from the app are ignored", loadStills("junk", store).map((s) => s.id).join() === "s9");
const full = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
check("a full storage does not throw", saveStills("p6", [still(1)], full).length === 1);

/* ---------- the colour dock in the layout ---------- */
const color = pageById("color");
check("the Color page opens with the dock", color.layout.dock === true && color.layout.dockW >= 260);
check("other pages open without it", PAGES.filter((p) => p.id !== "color").every((p) => p.layout.dock === false));
check("dock width is kept inside its limits", sanitizeLayout({ dockW: 99999 }, color.layout).dockW === 560 && sanitizeLayout({ dockW: 5 }, color.layout).dockW === 260);
check("a layout without dock fields takes the page's", (() => { const l = sanitizeLayout({ leftW: 300 }, color.layout); return l.dock === true && l.dockW === color.layout.dockW; })());
check("a wrong type for dock is ignored", sanitizeLayout({ dock: "yes" }, color.layout).dock === true);
const edit = pageById("edit").layout;
const withDock = LAYOUT_PRESETS.find((p) => p.id === "colour-dock")!.apply(edit);
check("the layout preset turns the dock on for any page", withDock.dock === true && withDock.leftW === edit.leftW);
check("the viewer-only preset hides the dock", LAYOUT_PRESETS.find((p) => p.id === "minimal")!.apply(color.layout).dock === false);
check("hiding the dock on the Color page is a saved change", Object.keys(compactLayouts({ color: { ...color.layout, dock: false } })).join() === "color" && Object.keys(compactLayouts({ color: color.layout })).length === 0);
const json = layoutsToJson({ color: { ...color.layout, dock: false, dockW: 420 } });
const imported = layoutsFromJson(json);
check("dock choices survive export and import", imported?.color?.dock === false && imported?.color?.dockW === 420 && layoutFor("color", imported!).dock === false);
check("the dock command is in the palette", getCommand("view.colourDock")?.category === "View");

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
