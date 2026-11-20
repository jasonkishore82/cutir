// Phase 18: the general keyframe engine, clip lanes, copy/paste, viewer writes, render and audio, and the chat tools.
import { evalLane, evalNumber, mix, pasteKeys, setKey, shape, type Key } from "../src/lib/keyframes/engine";
import { clearLane, lanesOf, moveLaneKeys, pasteLanes, removeLaneKey, setLaneKey, shapeLaneKeys, writePlacement } from "../src/lib/keyframes/lanes";
import { copySelectedKeys, pasteOffset } from "../src/lib/keyframes/lanes";
import { focusClip } from "../src/lib/keyframes/ui";
import { transformOf } from "../src/render/compositor";
import { clipGain, mixInputs } from "../src/render/audio";
import { newEffect, paramsAt } from "../src/lib/effects";
import { applyCalls } from "../src/lib/tools/index";
import { defaultProject, useProject } from "../src/store/project";
import { activeTimeline, viewToDoc } from "../src/model/convert";
import * as E from "../src/timeline/engine";
import type { Clip, ProjectDoc, Timeline } from "../src/model/types";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
}
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

/* ---------- key shapes ---------- */
const lin: Key[] = [{ t: 0, v: 0, mode: "linear" }, { t: 2, v: 10 }];
check("linear", near(evalNumber(lin, 1, 0), 5));
check("before the first key and after the last: hold", evalNumber(lin, -1, 99) === 0 && evalNumber(lin, 9, 99) === 10);
check("empty lane: the fallback", evalNumber([], 1, 42) === 42 && evalNumber(undefined, 1, 7) === 7);
check("hold keeps the value until the next key", evalNumber([{ t: 0, v: 0, mode: "hold" }, { t: 2, v: 10 }], 1.99, 0) === 0 && evalNumber([{ t: 0, v: 0, mode: "hold" }, { t: 2, v: 10 }], 2, 0) === 10);
const easeIn = evalNumber([{ t: 0, v: 0, mode: "ease", easing: "ease-in" }, { t: 1, v: 1 }], 0.5, 0);
const easeOut = evalNumber([{ t: 0, v: 0, mode: "ease", easing: "ease-out" }, { t: 1, v: 1 }], 0.5, 0);
check("ease-in is slow first, ease-out fast first", easeIn < 0.5 && easeOut > 0.5, [easeIn, easeOut]);
const curve = (easing: Key["easing"]) => Array.from({ length: 51 }, (_, i) => shape({ t: 0, v: 0, mode: "ease", easing }, undefined, i / 50));
const back = curve("back");
const elastic = curve("elastic");
const bounce = curve("bounce");
check("back overshoots then settles at 1", back.some((v) => v > 1) && near(back[50], 1), back.slice(30, 40));
check("elastic overshoots 1 and settles", elastic.some((v) => v > 1) && near(elastic[50], 1), elastic.slice(0, 10));
check("bounce stays in 0..1 and ends at 1", bounce.every((v) => v >= -1e-6 && v <= 1 + 1e-6) && near(shape({ t: 0, v: 0, mode: "ease", easing: "bounce" }, undefined, 1), 1));
const bz = (o: [number, number], i: [number, number], f: number) => shape({ t: 0, v: 0, mode: "bezier", out: o }, { t: 1, v: 1, in: i }, f);
check("bezier with straight handles is about linear", near(bz([1 / 3, 1 / 3], [1 / 3, 1 / 3], 0.5), 0.5, 1e-3), bz([1 / 3, 1 / 3], [1 / 3, 1 / 3], 0.5));
check("bezier ease-in handles start slow", bz([0.6, 0], [0.1, 0], 0.3) < 0.15, bz([0.6, 0], [0.1, 0], 0.3));
check("bezier ends at the keys", near(bz([0.5, 2], [0.5, -1], 0), 0) && near(bz([0.5, 2], [0.5, -1], 1), 1, 1e-4));

/* ---------- value kinds ---------- */
check("colours mix in linear light (midpoint brighter than sRGB average)", (() => {
  const m = mix("#000000", "#ffffff", 0.5, "color") as string;
  return parseInt(m.slice(1, 3), 16) > 160;
})(), mix("#000000", "#ffffff", 0.5, "color"));
check("colour ends exact", mix("#ff0000", "#0000ff", 0, "color") === "#ff0000" && mix("#ff0000", "#0000ff", 1, "color") === "#0000ff");
check("points mix per axis", JSON.stringify(mix({ x: 0, y: 10 }, { x: 10, y: 0 }, 0.25, "point")) === JSON.stringify({ x: 2.5, y: 7.5 }));
check("angles take the short way round", near(mix(350, 10, 0.5, "angle") as number, 360) && near(mix(10, 350, 0.5, "angle") as number, 0));
check("plain numbers do not wrap", near(mix(350, 10, 0.5, "number") as number, 180));
check("colour lanes evaluate", evalLane([{ t: 0, v: "#000000", mode: "linear" }, { t: 1, v: "#ffffff" }], 1, "#123456", "color") === "#ffffff");
check("point lanes evaluate", JSON.stringify(evalLane([{ t: 0, v: { x: 0, y: 0 }, mode: "linear" }, { t: 2, v: { x: 4, y: 2 } }], 1, { x: 9, y: 9 }, "point")) === JSON.stringify({ x: 2, y: 1 }));

/* ---------- editing ---------- */
let ks = setKey(undefined, 1, 5);
ks = setKey(ks, 0, 0);
ks = setKey(ks, 1.01, 6); // within SAME_T: replaces
check("setKey sorts and replaces close keys", ks.length === 2 && ks[0].t === 0 && ks[1].v === 6);
check("pasteKeys offsets and drops keys past the clip", pasteKeys([], [{ t: 0, v: 1 }, { t: 3, v: 2 }], 2, 0.5).map((k) => k.t).join() === "0.5");

/* ---------- a timeline with clips ---------- */
function doc(): ProjectDoc {
  let d = viewToDoc({ ...defaultProject() });
  d = E.onActive(d, (t) => {
    const v = E.addTrack(t, "video", "V");
    const a = E.addTrack(v.tl, "audio", "A");
    const clip = (id: string, trackId: string, start: number, extra: Partial<Clip> = {}): Clip => ({ id, trackId, mediaId: "m", start, duration: 4, sourceIn: 0, sourceOut: 4, speed: 1, enabled: true, effects: [], keyframes: {}, ...extra });
    return {
      ...a.tl,
      clips: [...a.tl.clips, clip("A", v.id, 0, { linkId: "L1", effects: [newEffect("blur", { radius: 2 })] }), clip("B", v.id, 10, { effects: [newEffect("blur")] }), clip("sa", a.id, 0, { linkId: "L1", mediaId: "s" })],
    };
  });
  return { ...d, media: [...d.media, { id: "m", name: "v.mp4", kind: "video", fileKey: "m/1", duration: 30, width: 1920, height: 1080 }, { id: "s", name: "s.wav", kind: "audio", fileKey: "m/2", duration: 30 }] };
}
const d0 = doc();
const tl0 = activeTimeline(d0);
const A = () => (t: Timeline) => t.clips.find((c) => c.id === "A")!;
const getA = (t: Timeline) => A()(t);
const lanesA = lanesOf(getA(tl0), d0);
check("picture clips can animate placement and effect params", ["clip:x", "clip:y", "clip:scale", "clip:rotation", "clip:opacity"].every((k) => lanesA.some((l) => l.key === k)) && lanesA.some((l) => l.id.kind === "effect" && l.id.param === "radius"));
check("audio clips can animate volume", lanesOf(tl0.clips.find((c) => c.id === "sa")!, d0).map((l) => l.key).join() === "clip:volume");
check("focus: a picture clip with its linked sound selected is the picture", focusClip(tl0, ["sa", "A"])?.id === "A" && focusClip(tl0, ["A", "B"]) === undefined && focusClip(tl0, ["B"])?.id === "B");

const X = { kind: "clip", name: "x" } as const;
const S = { kind: "clip", name: "scale" } as const;
const R = { kind: "clip", name: "rotation" } as const;
let tl = setLaneKey(tl0, "A", X, 0, 0.2);
tl = setLaneKey(tl, "A", X, 2, 0.8);
tl = shapeLaneKeys(tl, "A", X, [], "linear");
check("render follows the keys (clip time, not timeline time)", near(transformOf(getA(tl), 1).x, 0.5) && near(transformOf(getA(tl), 0).x, 0.2));
check("without a time the plain transform is used", transformOf(getA(tl)).x === 0.5);
const tlB = E.moveClips(tl, ["A"], 5);
check("keys move with the clip", near(transformOf(getA(tlB), 6).x, 0.5));
tl = setLaneKey(tl, "A", R, 0, 350);
tl = setLaneKey(tl, "A", R, 2, 10);
tl = shapeLaneKeys(tl, "A", R, [], "linear");
check("rotation wraps the short way", near(((transformOf(getA(tl), 1).rotation % 360) + 360) % 360, 0));
check("moveLaneKeys retimes chosen keys", getA(moveLaneKeys(tl, "A", X, [2], 1)).anim!.x!.map((k) => k.t).join() === "0,3");
check("removeLaneKey and clearLane", getA(removeLaneKey(tl, "A", X, 2)).anim!.x!.length === 1 && !getA(clearLane(tl, "A", X)).anim?.x?.length);
check("shapes: hold", near(transformOf(getA(shapeLaneKeys(tl, "A", X, [0], "hold")), 1.9).x, 0.2));

/* viewer writes */
check("viewer drag without keys or auto-key sets the plain value", getA(writePlacement(tl0, "A", "scale", 1.5, 1, false)).transform?.scale === 1.5 && !getA(writePlacement(tl0, "A", "scale", 1.5, 1, false)).anim?.scale);
check("viewer drag with auto-key writes a key at the playhead", getA(writePlacement(tl0, "A", "scale", 1.5, 1, true)).anim!.scale![0].t === 1);
check("viewer drag on a keyed value writes a key even without auto-key", getA(writePlacement(setLaneKey(tl0, "A", S, 0, 1), "A", "scale", 2, 3, false)).anim!.scale!.length === 2);
check("auto-key outside the clip does nothing", writePlacement(tl0, "A", "scale", 2, 9, true) === tl0);

/* effect params */
const fxA = getA(tl0).effects[0];
let tlF = setLaneKey(tl0, "A", { kind: "effect", fxId: fxA.id, param: "radius" }, 0, 0);
tlF = setLaneKey(tlF, "A", { kind: "effect", fxId: fxA.id, param: "radius" }, 2, 20);
tlF = shapeLaneKeys(tlF, "A", { kind: "effect", fxId: fxA.id, param: "radius" }, [], "linear");
check("effect params animate", near(paramsAt(getA(tlF).effects[0], 1).radius as number, 10));

/* copy and paste between clips: times stay relative to each clip's start */
const dK = E.onActive(d0, () => tl);
const copied = copySelectedKeys(dK, [{ clipId: "A", laneKey: "clip:x", t: 0 }, { clipId: "A", laneKey: "clip:x", t: 2 }]);
check("copy takes the selected keys, relative to the first", !!copied && copied.t0 === 0 && copied.lanes["clip:x"].map((k) => k.t).join() === "0,2");
const B0 = tl.clips.find((c) => c.id === "B")!;
const pasted = pasteLanes(tl, "B", copied!.lanes, getA(tl), pasteOffset(B0, copied!.t0, 50));
const Bp = pasted.clips.find((c) => c.id === "B")!;
check("paste keeps the offset into the clip when the playhead is elsewhere", Bp.anim!.x!.map((k) => k.t).join() === "0,2" && near(transformOf(Bp, 11).x, 0.5));
check("paste at the playhead when it is inside the clip", pasteOffset(B0, 0, 11.5) === 1.5);
const copiedFx = copySelectedKeys(E.onActive(d0, () => tlF), [{ clipId: "A", laneKey: `fx:${fxA.id}:radius`, t: 0 }, { clipId: "A", laneKey: `fx:${fxA.id}:radius`, t: 2 }])!;
const Bfx = pasteLanes(tlF, "B", copiedFx.lanes, getA(tlF), 0).clips.find((c) => c.id === "B")!;
check("effect keys paste onto the same effect type of another clip", (Bfx.effects[0].keys?.radius?.length ?? 0) === 2);

/* audio */
const V = { kind: "clip", name: "volume" } as const;
let tlV = setLaneKey(tl0, "sa", V, 0, 0);
tlV = setLaneKey(tlV, "sa", V, 2, 1);
tlV = shapeLaneKeys(tlV, "sa", V, [], "linear");
const sa = tlV.clips.find((c) => c.id === "sa")!;
check("volume keys change the gain", near(clipGain(tlV, sa, 1), 0.5, 0.02) && near(clipGain(tlV, sa, 0), 0, 0.02), [clipGain(tlV, sa, 1)]);
const inputs = mixInputs(E.onActive(d0, () => tlV), undefined, 10, () => "blob:x");
const inp = inputs.find((i) => i.gainCurve);
check("export mixdown gets the volume curve", !!inp && inp.gainCurve!.length > 10 && near(inp.gainCurve!.at(-1)!.v, 1, 0.02));

/* ---------- chat / MCP tools ---------- */
useProject.getState().loadDoc(d0);
const r1 = (await applyCalls([{ tool: "key_clip", args: { clip: "A", value: "scale", keys: [{ t: 0, v: 1 }, { t: 4, v: 1.3, ease: "ease-out" }] } }])).results[0];
const a1 = getA(activeTimeline(useProject.getState().doc));
check("key_clip adds keys", r1.ok && a1.anim!.scale!.length === 2 && a1.anim!.scale![1].easing === "ease-out", r1);
const r2 = (await applyCalls([{ tool: "key_clip", args: { clip: "A", value: "blur.radius", keys: [{ t: 0, v: 0 }, { t: 2, v: 30 }] } }])).results[0];
check("key_clip on an effect param by type", r2.ok && getA(activeTimeline(useProject.getState().doc)).effects[0].keys!.radius!.length === 2, r2);
const r3 = (await applyCalls([{ tool: "key_clip", args: { clip: "A", value: "warp", keys: [{ t: 0, v: 0 }] } }])).results[0];
check("key_clip names what can be animated on a bad value", !r3.ok && /can animate/.test(String(r3.error ?? r3.summary ?? "")), r3);
const r4 = (await applyCalls([{ tool: "clear_clip_keys", args: { clip: "A" } }])).results[0];
const a4 = getA(activeTimeline(useProject.getState().doc));
check("clear_clip_keys clears every value", r4.ok && !a4.anim?.scale?.length && !a4.effects[0].keys?.radius?.length, r4);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
