// Phase 22 rest: mask keyframes point by point, mask editing on the viewer, and the new graph nodes (transform, mask, text, group).
import { evalLane, setKey, type Key } from "../src/lib/keyframes/engine";
import { paramsAt, getEffect } from "../src/lib/effects";
import { boxHandles, dragBox, hitHandle, insertPoint, movePoint, pathHandles, pathKeysAfterEdit, removePoint } from "../src/lib/maskEdit";
import { DEFAULT_TEXT, DEFAULT_TRANSFORM, INPUT_COUNT, addNode, connect, evaluateGraph, groupNodes, stackToGraph, ungroup, validateGraph, type Graph, type GraphNode, type GraphOps } from "../src/lib/graph/graph";
import type { ClipEffect } from "../src/model/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) < e;
type Pt = [number, number];

/* ---------- keyframes of a whole shape ---------- */
const square: Pt[] = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
const wide: Pt[] = [[0.1, 0.3], [0.9, 0.3], [0.9, 0.7], [0.1, 0.7]];
const keys: Key[] = [{ t: 0, v: square, mode: "linear" }, { t: 2, v: wide, mode: "linear" }];
const mid = evalLane(keys, 1, square, "path") as Pt[];
check("a path blends point by point between keys", mid.length === 4 && near(mid[0][0], 0.15) && near(mid[0][1], 0.25) && near(mid[2][0], 0.85) && near(mid[2][1], 0.75), mid);
check("before the first key and after the last the shape holds", JSON.stringify(evalLane(keys, -1, square, "path")) === JSON.stringify(square) && JSON.stringify(evalLane(keys, 5, square, "path")) === JSON.stringify(wide));
check("a quarter of the way is a quarter of the move", near((evalLane(keys, 0.5, square, "path") as Pt[])[1][0], 0.8 + 0.1 * 0.25));
const tri: Pt[] = [[0.5, 0.1], [0.9, 0.9], [0.1, 0.9]];
check("shapes with a different number of points hold the first until the next key", JSON.stringify(evalLane([{ t: 0, v: square, mode: "linear" }, { t: 2, v: tri, mode: "linear" }], 1, square, "path")) === JSON.stringify(square));
check("the kind is found from the value when not given", (evalLane(keys, 1, square) as Pt[]).length === 4);
check("a lane of points still works as before", JSON.stringify(evalLane([{ t: 0, v: { x: 0, y: 0 }, mode: "linear" }, { t: 2, v: { x: 1, y: 2 }, mode: "linear" }], 1, { x: 0, y: 0 })) === JSON.stringify({ x: 0.5, y: 1 }));
check("setKey takes a path", (setKey(undefined, 1, square) as Key[])[0].v === square);

// through the effect registry: the mask's path param is evaluated at the clip time
const mask: ClipEffect = { id: "m", type: "mask", enabled: true, params: { shape: "polygon", path: square }, keys: { path: [{ t: 0, v: square, mode: "linear" }, { t: 2, v: wide, mode: "linear" }] } };
const at1 = paramsAt(mask, 1).path as Pt[];
check("paramsAt animates the mask outline", near(at1[0][0], 0.15) && near(at1[3][1], 0.75), at1);
check("the path param is of the path kind", getEffect("mask")!.params.find((p) => p.key === "path")!.type === "path");
check("without keys the saved outline is used", JSON.stringify(paramsAt({ ...mask, keys: undefined }, 1).path) === JSON.stringify(square));

/* ---------- editing a shape on the viewer ---------- */
const off = { x: 0.1, y: -0.05 };
const handles = pathHandles(square, off);
check("a handle per point, shifted by the mask's offset", handles.length === 4 && near(handles[0].x, 0.3) && near(handles[0].y, 0.15) && handles[0].id === "p0");
const moved = movePoint(square, 1, { x: 0.7, y: 0.4 }, off);
check("dragging a handle moves the point (the offset is taken off again)", near(moved[1][0], 0.6) && near(moved[1][1], 0.45) && moved[0] === square[0], moved);
check("a point cannot be dragged far off the frame", movePoint(square, 0, { x: 9, y: -9 }, { x: 0, y: 0 })[0].join() === "1.5,-0.5");
const ins = insertPoint(square, { x: 0.5, y: 0.18 }, { x: 0, y: 0 });
check("a new point goes on the nearest edge", ins.points.length === 5 && ins.index === 1 && near(ins.points[1][0], 0.5), ins);
const ins2 = insertPoint(square, { x: 0.18, y: 0.5 }, { x: 0, y: 0 });
check("including the closing edge", ins2.index === 4 && ins2.points.length === 5, ins2);
check("a shape keeps at least three points", removePoint(tri, 0).length === 3 && removePoint(square, 0).length === 3 && removePoint(square, 3).length === 3);
check("hit testing picks the nearest handle in reach", hitHandle(handles, { x: 0.31, y: 0.16 }, 0.025)?.id === "p0" && hitHandle(handles, { x: 0.5, y: 0.5 }, 0.025) === null);

const box = { center: { x: 0.5, y: 0.5 }, width: 40, height: 20 };
const bh = boxHandles(box, { x: 0, y: 0 });
check("a box has a centre and four edge handles", bh.length === 5 && near(bh.find((h) => h.id === "right")!.x, 0.7) && near(bh.find((h) => h.id === "top")!.y, 0.4));
check("dragging the centre moves the centre", dragBox("centre", { x: 0.6, y: 0.45 }, box, { x: 0.1, y: 0 }).center?.x === 0.5 && dragBox("centre", { x: 0.6, y: 0.45 }, box, { x: 0.1, y: 0 }).center?.y === 0.45);
check("dragging an edge sets the width or height in percent", dragBox("right", { x: 0.8, y: 0.5 }, box, { x: 0, y: 0 }).width === 60 && dragBox("bottom", { x: 0.5, y: 0.7 }, box, { x: 0, y: 0 }).height === 40 && dragBox("left", { x: 0.3, y: 0.5 }, box, { x: 0, y: 0 }).width === 40);
check("a box cannot shrink to nothing or grow past the limits", dragBox("right", { x: 0.5, y: 0.5 }, box, { x: 0, y: 0 }).width === 1 && dragBox("right", { x: 9, y: 0.5 }, box, { x: 0, y: 0 }).width === 200);

check("an edit of a keyed shape writes a key at the playhead", (() => { const k = pathKeysAfterEdit(keys, 1, tri.length === 3 ? square : square, false); return k.length === 3 && k.some((x) => Math.abs(x.t - 1) < 1e-9); })());
check("editing at an existing key replaces it", pathKeysAfterEdit(keys, 2, square, false).length === 2);
check("adding a point drops the keys that cannot blend with it", (() => { const k = pathKeysAfterEdit(keys, 1, ins.points, true); return k.length === 1 && (k[0].v as Pt[]).length === 5; })());

/* ---------- graph nodes ---------- */
const textOps: GraphOps<string> = {
  input: () => "IN",
  effect: (n, s) => `${n.effect!.type}(${s})`,
  merge: (_n, bg, fg) => `merge(${bg ?? "-"},${fg ?? "-"})`,
  generator: () => "GEN",
  transform: (n, s) => `tf[${n.transform!.scale}](${s})`,
  mask: (_n, s, m) => (m ? `matte(${s},${m})` : `mask(${s})`),
  text: (n) => `text:${n.text!.text}`,
};
const base = stackToGraph([]);
check("the new node types have their connections", INPUT_COUNT.transform === 1 && INPUT_COUNT.mask === 2 && INPUT_COUNT.text === 0 && INPUT_COUNT.group === 1);
let g: Graph = addNode(base, { type: "transform", name: "Move", transform: { ...DEFAULT_TRANSFORM, scale: 2 } });
g = addNode(g, { type: "mask", name: "Mask", mask: { params: { shape: "ellipse" } } });
check("transform then mask evaluate in order", evaluateGraph(g, textOps) === "mask(tf[2](IN))", evaluateGraph(g, textOps));
const maskId = g.nodes.find((n) => n.type === "mask")!.id;
let g2 = addNode(g, { type: "text", name: "Label", text: { ...DEFAULT_TEXT, text: "Hi" } });
const textId = g2.nodes.find((n) => n.type === "text")!.id;
check("a text node has no input to connect", connect(g2, "in", textId, 0) === null);
g2 = connect(connect(g2, textId, maskId, 1)!, maskId, "out", 0)!; // the new node was put on the wire into the output: put the mask back there
check("a text node can be the matte of a mask node", !!g2 && evaluateGraph(g2, textOps) === "matte(tf[2](IN),text:Hi)", evaluateGraph(g2, textOps));
check("a bypassed mask node passes the picture", evaluateGraph({ ...g2, nodes: g2.nodes.map((n) => (n.id === maskId ? { ...n, bypass: true } : n)) }, textOps) === "tf[2](IN)");
check("a bypassed text node gives nothing, so the mask has no matte", evaluateGraph({ ...g2, nodes: g2.nodes.map((n) => (n.id === textId ? { ...n, bypass: true } : n)) }, textOps) === "mask(tf[2](IN))");
check("without the new ops the nodes pass the picture through", evaluateGraph(g, { input: () => "IN", effect: (_n, s) => s, merge: (_n, b) => b, generator: () => null }) === "IN");
check("a graph with the new nodes is valid", validateGraph(g2).length === 0);

// groups
let gg: Graph = addNode(stackToGraph([]), { type: "effect", name: "Blur", effect: { type: "blur", params: {} } });
gg = addNode(gg, { type: "transform", name: "Move", transform: { ...DEFAULT_TRANSFORM, scale: 3 } });
gg = addNode(gg, { type: "effect", name: "Glow", effect: { type: "glow", params: {} } });
const idOf = (t: string, name?: string) => gg.nodes.find((n) => n.type === t && (!name || n.name === name))!.id;
const before = evaluateGraph(gg, textOps);
check("a chain before grouping", before === "glow(tf[3](blur(IN)))", before);
const grouped = groupNodes(gg, [idOf("effect", "Blur"), idOf("transform")]);
check("two chained nodes can be grouped", "graph" in grouped);
const gr = (grouped as { graph: Graph }).graph;
const gnode = gr.nodes.find((n) => n.type === "group") as GraphNode;
check("the group replaces them and reads what they read", !!gnode && gr.nodes.length === gg.nodes.length - 2 + 1 && gnode.inputs[0] === "in" && gnode.group!.nodes.length === 4, gr.nodes.map((n) => n.type));
check("the group gives the same picture as the nodes did", evaluateGraph(gr, textOps) === before, evaluateGraph(gr, textOps));
check("a group is a valid graph", validateGraph(gr).length === 0);
check("what read the last node inside now reads the group", gr.nodes.find((n) => n.name === "Glow")!.inputs[0] === gnode.id);
check("a bypassed group passes its picture through", evaluateGraph({ ...gr, nodes: gr.nodes.map((n) => (n.id === gnode.id ? { ...n, bypass: true } : n)) }, textOps) === "glow(IN)");
const open = ungroup(gr, gnode.id);
check("ungrouping brings the nodes back, same result", open.nodes.length === gg.nodes.length && evaluateGraph(open, textOps) === before && validateGraph(open).length === 0, open.nodes.map((n) => n.id));
check("ungrouped nodes keep unique ids", new Set(open.nodes.map((n) => n.id)).size === open.nodes.length);
const gtwice = groupNodes(open, open.nodes.filter((n) => n.type === "effect" || n.type === "transform").map((n) => n.id));
check("all three can be grouped too", "graph" in gtwice && evaluateGraph((gtwice as { graph: Graph }).graph, textOps) === before);
// a group inside a group
const nested = groupNodes((gtwice as { graph: Graph }).graph, []) as { error: string };
check("nothing selected is an error in words", /Select the nodes/.test(nested.error));
check("the input and output cannot be grouped", /cannot go into a group/.test((groupNodes(gg, ["in", idOf("transform")]) as { error: string }).error));
// two outputs used outside
const branchy = addNode(addNode(base, { type: "effect", name: "A", effect: { type: "blur", params: {} } }), { type: "effect", name: "B", effect: { type: "glow", params: {} } });
const aId = branchy.nodes.find((n) => n.name === "A")!.id;
const bId = branchy.nodes.find((n) => n.name === "B")!.id;
const merged = addNode(branchy, { type: "merge", name: "M", merge: { mode: "normal", opacity: 1 } });
const mId = merged.nodes.find((n) => n.type === "merge")!.id;
const wired = connect(connect(merged, aId, mId, 0)!, bId, mId, 1)!;
const two = groupNodes(wired, [aId, bId]) as { error: string };
check("a group with two outputs used outside is refused with the reason", /one output/.test(two.error ?? ""), two);
const noOut = groupNodes(base, []) as { error: string };
check("an empty selection is refused", !!noOut.error);
// a group with an empty inside
check("a group without an inside is reported", validateGraph({ ...gr, nodes: gr.nodes.map((n) => (n.id === gnode.id ? { ...n, group: undefined } : n)) }).some((e) => /empty group/.test(e)));
check("problems inside a group are reported with its name", validateGraph({ ...gr, nodes: gr.nodes.map((n) => (n.id === gnode.id ? { ...n, group: { nodes: [] } } : n)) }).some((e) => /^In /.test(e)));

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
