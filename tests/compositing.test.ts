// Phase 22: node graph, tracking and stabilisation, mask paths, keyer erosion.
import { addNode, connect, disconnect, evaluateGraph, graphToStack, hasCycle, isLinear, removeNode, stackToGraph, validateGraph, type Graph } from "../src/lib/graph/graph";
import { PointTracker, matchPatch, patchAt, smoothPath, stabiliseOffset, stabiliseZoom, toGray, trackerAt, trackerOffset, type Gray, type Tracker } from "../src/lib/track/tracker";
import { DEFAULT_PATH, erodeAlpha, insidePolygon, nearestPoint, smoothSegments } from "../src/lib/masks";
import type { ClipEffect } from "../src/model/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/* ---------- graph ---------- */
const stack: ClipEffect[] = [
  { id: "a", type: "blur", enabled: true, params: { radius: 5 } },
  { id: "b", type: "glow", enabled: false, params: {} },
  { id: "c", type: "vignette", enabled: true, params: {} },
];
const g = stackToGraph(stack);
check("a stack becomes input, one node per effect, output", g.nodes.length === 5 && g.nodes[0].type === "input" && g.nodes[4].type === "output");
check("the chain is linear and valid", isLinear(g) && validateGraph(g).length === 0);
const back = graphToStack(g)!;
check("a linear graph turns back into the same stack", back.length === 3 && back.map((e) => e.type).join() === "blur,glow,vignette" && back[1].enabled === false && back[0].id === "a", back);
check("an empty stack is input to output", stackToGraph([]).nodes.length === 2 && graphToStack(stackToGraph([]))!.length === 0);

// evaluate with strings so the order is visible
const ops = { input: () => "src", effect: (n: { effect?: { type: string } }, s: string) => `${n.effect!.type}(${s})`, merge: (_n: unknown, bg: string | null, fg: string | null) => `merge(${bg},${fg})`, generator: () => "gen" };
check("evaluation runs the chain and skips bypassed nodes", evaluateGraph(g, ops) === "vignette(blur(src))", evaluateGraph(g, ops));
let br = addNode(g, { type: "generator", name: "Solid", generator: { type: "solid", color: "#f00" } });
const gen = br.nodes[br.nodes.length - 1];
const mergeNode = addNode(br, { type: "merge", name: "Merge", merge: { mode: "multiply", opacity: 1 } });
const m = mergeNode.nodes[mergeNode.nodes.length - 1];
let wired = connect(mergeNode, gen.id, m.id, 1)!;
check("connecting a generator into a merge works", !!wired && wired.nodes.find((n) => n.id === m.id)!.inputs[1] === gen.id);
check("the graph with a merge is no longer a plain stack", !isLinear(wired) && graphToStack(wired) === null);
check("merge evaluates both inputs", /^merge\(.*,gen\)$/.test(evaluateGraph(wired, ops) ?? ""), evaluateGraph(wired, ops));
check("a loop is refused", connect(g, "out", "fx-a", 0) === null && connect(g, "fx-c", "fx-a", 0) === null);
const loopy: Graph = { nodes: [{ id: "x", type: "effect", x: 0, y: 0, inputs: ["y"], effect: { type: "blur", params: {} } }, { id: "y", type: "effect", x: 0, y: 0, inputs: ["x"], effect: { type: "blur", params: {} } }, { id: "out", type: "output", x: 0, y: 0, inputs: ["x"] }] };
check("hasCycle sees a loop and evaluation gives up", hasCycle(loopy) && evaluateGraph(loopy, ops) === null && validateGraph(loopy).some((e) => /loop/.test(e)));
check("previewing a node shows that node", evaluateGraph({ ...g, preview: "fx-a" }, ops) === "blur(src)");
const cut = removeNode(g, "fx-b");
check("removing a node re-wires nothing but drops the link", cut.nodes.length === 4 && cut.nodes.find((n) => n.id === "fx-c")!.inputs[0] === null && evaluateGraph(cut, ops) === null);
check("input and output cannot be removed", removeNode(g, "in") === g && removeNode(g, "out") === g);
check("disconnect clears a slot", disconnect(g, "out", 0).nodes.find((n) => n.id === "out")!.inputs[0] === null);
let calls = 0;
const shared: Graph = { nodes: [{ id: "in", type: "input", x: 0, y: 0, inputs: [] }, { id: "e", type: "effect", x: 0, y: 0, inputs: ["in"], effect: { type: "blur", params: {} } }, { id: "mg", type: "merge", x: 0, y: 0, inputs: ["e", "e"], merge: { mode: "add", opacity: 1 } }, { id: "out", type: "output", x: 0, y: 0, inputs: ["mg"] }] };
evaluateGraph(shared, { ...ops, effect: (n: unknown, s: string) => (calls++, s) });
check("a node read twice runs once", calls === 1, calls);
check("a bypassed merge passes the background", evaluateGraph({ nodes: shared.nodes.map((n) => (n.id === "mg" ? { ...n, bypass: true } : n)) }, ops) === "blur(src)");

/* ---------- tracker ---------- */
const W = 160, H = 120;
/** A noisy background with a bright textured square at (cx, cy). */
function frameWith(cx: number, cy: number, shift = 0): Gray {
  const data = new Uint8Array(W * H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < data.length; i++) data[i] = 40 + Math.floor(rnd() * 20);
  for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) data[(Math.round(cy) + y) * W + Math.round(cx) + x] = 150 + ((x * 7 + y * 13 + shift) & 63);
  return { w: W, h: H, data };
}
const f0 = frameWith(60, 50);
const f1 = frameWith(64, 53);
const tpl = patchAt(f0, 60, 50, 10);
const mm = matchPatch(tpl, 10, f1, 60, 50, 12);
check("block matching finds the patch after it moved", near(mm.x, 64, 0.6) && near(mm.y, 53, 0.6) && mm.c > 0.8, mm);
const tracker = new PointTracker(f0, 60, 50, { radius: 10, search: 10 });
let pos = { x: 60, y: 50 };
let lost = false;
for (let i = 1; i <= 6; i++) {
  const r = tracker.next(frameWith(60 + i * 4, 50 + i * 2));
  if (!r) { lost = true; break; }
  pos = r;
}
check("the tracker follows a steady drift over several frames", !lost && near(pos.x, 84, 1) && near(pos.y, 62, 1), pos);
const blank: Gray = { w: W, h: H, data: new Uint8Array(W * H).fill(0) };
check("the tracker reports a lost match on an unrelated frame", new PointTracker(f0, 60, 50, { radius: 10, search: 10, minConfidence: 0.6 }).next(blank) === null);
check("toGray weights the channels", toGray(new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]), 2, 1).data[0] >= 254 && toGray(new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]), 2, 1).data[1] < 70);

const tr: Tracker = { id: "t", name: "P", x: 0.5, y: 0.5, t0: 0, samples: [{ t: 0, x: 0.5, y: 0.5, c: 1 }, { t: 1, x: 0.6, y: 0.4, c: 1 }, { t: 2, x: 0.7, y: 0.5, c: 1 }] };
check("trackerAt interpolates and holds", near(trackerAt(tr, 0.5).x, 0.55, 1e-9) && trackerAt(tr, 9).x === 0.7 && trackerAt(tr, -1).x === 0.5);
check("trackerOffset is the move since the start", near(trackerOffset(tr, 1).x, 0.1, 1e-9) && near(trackerOffset(tr, 1).y, -0.1, 1e-9) && trackerOffset(tr, 0).x === 0);
check("an empty tracker stays at its start", trackerAt({ ...tr, samples: [] }, 1).x === 0.5);

// a jittery path around a slow pan
const jitter: Tracker = { ...tr, samples: Array.from({ length: 61 }, (_, i) => ({ t: i / 30, x: 0.5 + i * 0.002 + (i % 2 ? 0.01 : -0.01), y: 0.5 + (i % 3 ? 0.006 : -0.006), c: 1 })) };
const sm = smoothPath(jitter.samples, 0.5);
const roughness = (a: { x: number }[]) => a.slice(1).reduce((s, v, i) => s + Math.abs(v.x - a[i].x), 0);
check("smoothing lowers the jitter", roughness(sm) < roughness(jitter.samples) * 0.4, [roughness(sm), roughness(jitter.samples)]);
check("no smoothing leaves the path", smoothPath(jitter.samples, 0).every((p, i) => p.x === jitter.samples[i].x));
const so = stabiliseOffset(jitter, 20 / 30, 0.5);
const real = trackerAt(jitter, 20 / 30);
check("stabilising moves the picture toward the smooth path", near(real.x + so.x, sm[20].x, 1e-6) && Math.abs(so.x) > 0.001, so);
check("zero smoothing needs no shift", stabiliseOffset(jitter, 0.5, 0).x === 0);
check("the stabilising zoom covers the shift", stabiliseZoom(jitter, 0.5) > 1 && stabiliseZoom(jitter, 0.5) < 1.1 && stabiliseZoom(jitter, 0.5, 5) > stabiliseZoom(jitter, 0.5));

/* ---------- masks and keyer ---------- */
const seg = smoothSegments(DEFAULT_PATH, true)!;
check("a closed smooth path has one segment per point and ends where it began", seg.segs.length === 4 && seg.segs[3].to[0] === DEFAULT_PATH[0][0]);
check("an open path has one fewer segment", smoothSegments(DEFAULT_PATH, false)!.segs.length === 3 && smoothSegments([[0, 0]], true) === null);
const calls2: string[] = [];
const rec = { moveTo: () => calls2.push("m"), lineTo: () => calls2.push("l"), bezierCurveTo: () => calls2.push("b"), closePath: () => calls2.push("z") };
const { tracePath } = await import("../src/lib/masks");
check("a polygon mask traces lines and a smooth one curves", tracePath(rec, DEFAULT_PATH, false, 100, 100) && calls2.join("") === "mllllz" || calls2.join("") === "mlllz", calls2.join(""));
calls2.length = 0;
tracePath(rec, DEFAULT_PATH, true, 100, 100);
check("smooth tracing uses curves", calls2.filter((c) => c === "b").length === 4);
check("fewer than three points draws nothing", tracePath(rec, [[0, 0], [1, 1]], false, 10, 10) === false);
check("point in polygon", insidePolygon(DEFAULT_PATH, 0.5, 0.5) && !insidePolygon(DEFAULT_PATH, 0.9, 0.9));
check("nearest point within a radius", nearestPoint(DEFAULT_PATH, 0.31, 0.29, 0.05) === 0 && nearestPoint(DEFAULT_PATH, 0.5, 0.5, 0.05) === -1);
const a = new Uint8ClampedArray(7 * 7).fill(0);
for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) a[y * 7 + x] = 255;
const e = erodeAlpha(a, 7, 7, 1);
check("eroding a 3x3 block by 1 leaves its centre", e[3 * 7 + 3] === 255 && e[2 * 7 + 2] === 0 && e[3 * 7 + 2] === 0, Array.from(e));
check("zero erosion leaves the matte", erodeAlpha(a, 7, 7, 0) === a);

/* ---------- clip transform with a tracker and stabilisation ---------- */
{
  const { transformOf } = await import("../src/render/compositor");
  const { viewToDoc, activeTimeline } = await import("../src/model/convert");
  const { defaultProject } = await import("../src/store/project");
  const tl = activeTimeline(viewToDoc(defaultProject()));
  const base = { trackId: "v", start: 10, duration: 4, sourceIn: 0, sourceOut: 4, speed: 1, enabled: true, effects: [], keyframes: {} };
  const footage = { ...base, id: "f", trackers: [tr] };
  const title = { ...base, id: "ti", transform: { x: 0.3, y: 0.3 }, follow: { clipId: "f", trackerId: "t" } };
  const t2 = { ...tl, clips: [footage, title] };
  const moved = transformOf(title, 11, t2);
  check("a pinned clip moves with the tracked point", near(moved.x, 0.4, 1e-9) && near(moved.y, 0.2, 1e-9), moved);
  check("without the timeline it stays put", transformOf(title, 11).x === 0.3);
  const still = transformOf(title, 10, t2);
  check("at the tracker start the offset is zero", near(still.x, 0.3, 1e-9));
  const shaky = { ...base, id: "s", trackers: [jitter], stabilize: { trackerId: "t", smoothing: 0.5, zoom: 2 } };
  const st = transformOf(shaky, 10 + 20 / 30, { ...tl, clips: [shaky] });
  check("a stabilised clip is shifted and zoomed", Math.abs(st.x - 0.5) > 0.001 && st.scale > 1.02, st);
}

/* ---------- the keyer on the CPU ---------- */
{
  const { chromaKey } = await import("../src/lib/effects/builtins/chromaKey");
  const w = 9, h = 9;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    const subject = x >= 2 && x <= 6 && y >= 2 && y <= 6;
    data.set(subject ? [200, 60, 60, 255] : [0, 255, 0, 255], i * 4);
  }
  const run = (p: Record<string, unknown>) => {
    let out: { data: Uint8ClampedArray } | null = null;
    const src = { w, h, canvas: {}, ctx: { getImageData: () => ({ data: Uint8ClampedArray.from(data), width: w, height: h }) } };
    const dst = { w, h, canvas: {}, ctx: { putImageData: (i: { data: Uint8ClampedArray }) => (out = i) } };
    chromaKey.render(src as never, dst as never, { key: "#00ff00", tolerance: 35, softness: 5, spill: 0, shrink: 0, matte: false, ...p }, { w, h, time: 0, clipDuration: 1, scratch: () => src as never });
    return out!.data;
  };
  const plain = run({});
  check("the keyer removes the green and keeps the subject", plain[3] === 0 && plain[(4 * w + 4) * 4 + 3] === 255);
  const shrunk = run({ shrink: 1 });
  check("edge shrink eats the subject's rim", plain[(2 * w + 2) * 4 + 3] === 255 && shrunk[(2 * w + 2) * 4 + 3] === 0 && shrunk[(4 * w + 4) * 4 + 3] === 255);
  const view = run({ matte: true });
  check("the matte view is white on the subject and black elsewhere", view[(4 * w + 4) * 4] === 255 && view[0] === 0 && view[3] === 255);
  const spilled = run({ key: "#0000ff", spill: 100 });
  void spilled;
}

if (fails) process.exit(1);
console.log("all passed");
