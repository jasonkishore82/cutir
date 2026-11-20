// Phase 17: effects, transitions and their timeline editing (src/lib/effects, src/timeline/effects.ts).
import { cleanParams, defaultParams, getEffect, keyedValue, listEffects, listTransitions, newEffect, paramsAt, transitionAt, transitionWindow, type Layer } from "../src/lib/effects";
import * as FX from "../src/timeline/effects";
import { needsAt, visualPlan } from "../src/render/compositor";
import { activeAudio, clipGain, mixInputs } from "../src/render/audio";
import { affectedRanges } from "../src/render/cache";
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

/* ---------- the registry ---------- */
const effects = listEffects();
const trs = listTransitions();
check(`at least 12 effects (${effects.length})`, effects.length >= 12);
check(`at least 8 transitions (${trs.length})`, trs.length >= 8);
check("the required effects are there", ["transform", "crop", "blur", "sharpen", "glow", "vignette", "drop-shadow", "mask", "chroma-key", "invert", "mirror", "noise", "pixelate"].every((id) => getEffect(id)));
check("the required transitions are there", ["cross-dissolve", "dip-to-colour", "wipe", "push", "slide", "zoom", "blur-dissolve", "spin"].every((id) => trs.some((t) => t.id === id)));
check("the lyric animations are an effect for any clip", !!getEffect("animate"));
check("every effect's defaults pass its own spec", effects.every((e) => JSON.stringify(cleanParams(e.params, defaultParams(e.params))) === JSON.stringify(defaultParams(e.params))));
check("some effects run on the GPU", effects.filter((e) => e.gpu).length >= 3);

/* ---------- params ---------- */
const blur = newEffect("blur", { radius: 999, junk: 1 });
check("new effects clamp params and drop unknown ones", blur.params.radius === 100 && !("junk" in blur.params));
check("bad colours and choices are ignored", JSON.stringify(cleanParams(getEffect("vignette")!.params, { color: "pink" })) === "{}" && JSON.stringify(cleanParams(getEffect("mirror")!.params, { axis: "sideways" })) === "{}");
const keys = [{ t: 0, v: 0 }, { t: 2, v: 10, easing: "linear" as const }, { t: 1, v: 4 }];
check("param keyframes interpolate (in time order)", near(keyedValue(keys, 0.5, 99), 2) && near(keyedValue(keys, 1.5, 99), 7));
check("param keyframes hold outside", keyedValue(keys, -1, 99) === 0 && keyedValue(keys, 5, 99) === 10);
check("no keyframes: the value", keyedValue(undefined, 1, 42) === 42);
check("paramsAt evaluates keyed params", paramsAt({ ...blur, keys: { radius: [{ t: 0, v: 0 }, { t: 1, v: 20 }] } }, 0.5).radius === 10);

/* ---------- every effect and transition runs (stand-in canvas) ---------- */
function fakeLayer(w = 64, h = 36): Layer & { ops: string[] } {
  const ops: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (o, k: string) => {
      if (k in o) return o[k];
      if (k === "getImageData" || k === "createImageData") return (..._a: number[]) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === "createRadialGradient" || k === "createLinearGradient") return () => ({ addColorStop: () => undefined });
      return (..._a: unknown[]) => void ops.push(k);
    },
    set: (o, k: string, v) => ((o[k] = v), true),
  });
  return { canvas: { width: w, height: h } as unknown as OffscreenCanvas, ctx: ctx as unknown as Layer["ctx"], w, h, ops };
}
const env = { w: 64, h: 36, time: 0.5, clipDuration: 3, scratch: () => fakeLayer() };
for (const e of effects) {
  const src = fakeLayer();
  const dst = fakeLayer();
  let ok = true;
  try {
    e.render(src, dst, defaultParams(e.params), env);
  } catch (err) {
    ok = false;
    console.log(err);
  }
  check(`effect ${e.id} renders`, ok && dst.ops.length > 0, dst.ops);
}
for (const t of trs) {
  const out = fakeLayer();
  let ok = true;
  try {
    for (const p of [0, 0.3, 0.7, 1]) t.render(out.ctx, fakeLayer(), fakeLayer(), p, defaultParams(t.params), { w: 64, h: 36, scratch: () => fakeLayer() });
    t.render(out.ctx, fakeLayer(), null, 0.5, defaultParams(t.params), { w: 64, h: 36, scratch: () => fakeLayer() });
    t.render(out.ctx, null, fakeLayer(), 0.5, defaultParams(t.params), { w: 64, h: 36, scratch: () => fakeLayer() });
  } catch (err) {
    ok = false;
    console.log(err);
  }
  check(`transition ${t.id} renders (also at clip edges)`, ok && out.ops.length > 0);
}

/* ---------- transitions on a timeline ---------- */
function doc(): ProjectDoc {
  let d = viewToDoc({ ...defaultProject() });
  d = E.onActive(d, (t) => {
    const v = E.addTrack(t, "video", "V");
    const a = E.addTrack(v.tl, "audio", "A");
    const clip = (id: string, trackId: string, start: number, extra: Partial<Clip> = {}): Clip => ({ id, trackId, mediaId: "m", start, duration: 4, sourceIn: 10, sourceOut: 14, speed: 1, enabled: true, effects: [], keyframes: {}, ...extra });
    return { ...a.tl, clips: [...a.tl.clips, clip("A", v.id, 0, { linkId: "L1" }), clip("B", v.id, 4, { linkId: "L2" }), clip("C", v.id, 10), clip("sa", a.id, 0, { linkId: "L1", mediaId: "s" }), clip("sb", a.id, 4, { linkId: "L2", mediaId: "s" })] };
  });
  return { ...d, media: [...d.media, { id: "m", name: "v.mp4", kind: "video", fileKey: "m/1", duration: 30 }, { id: "s", name: "s.wav", kind: "audio", fileKey: "m/2", duration: 30 }] };
}
const d0 = doc();
const t0 = activeTimeline(d0);
const vTrack = t0.tracks.find((t) => t.name === "V")!.id;
const t1 = FX.addTransition(t0, { trackId: vTrack, from: "A", to: "B", type: "cross-dissolve", duration: 1 });
const clipMap = new Map(t1.clips.map((c) => [c.id, c]));
const tr = t1.cutTransitions!.find((x) => x.trackId === vTrack)!;
check("centred on the cut", JSON.stringify(transitionWindow(tr, clipMap)) === JSON.stringify([3.5, 4.5]));
check("ending at the cut", JSON.stringify(transitionWindow({ ...tr, align: "end" }, clipMap)) === JSON.stringify([3, 4]));
check("starting at the cut", JSON.stringify(transitionWindow({ ...tr, align: "start" }, clipMap)) === JSON.stringify([4, 5]));
check("at a clip's end only", JSON.stringify(transitionWindow({ ...tr, to: undefined }, clipMap)) === JSON.stringify([3, 4]));
check("at a clip's start only", JSON.stringify(transitionWindow({ ...tr, from: undefined }, clipMap)) === JSON.stringify([4, 5]));
check("clips pulled apart: no transition", transitionWindow({ ...tr, to: "C" }, clipMap) === null);
const at = transitionAt(t1, vTrack, 4)!;
check("progress is eased (ease-in-out at the middle = 0.5)", at && near(at.p, 0.5));
check("linked sound gets a crossfade", t1.cutTransitions!.some((x) => x.type === "crossfade" && x.from === "sa" && x.to === "sb"));
check("adding again replaces, never duplicates", FX.addTransition(t1, { trackId: vTrack, from: "A", to: "B", type: "wipe" }).cutTransitions!.filter((x) => x.trackId === vTrack).length === 1);

const d1 = E.onActive(d0, () => t1);
const plan = visualPlan(activeTimeline(d1), d1, 4.25);
const item = plan.find((p) => p.type === "transition");
check("during a transition both clips are drawn", !!item && item.type === "transition" && item.a?.clip.id === "A" && item.b?.clip.id === "B");
check("the outgoing clip continues past its out point (handle frames)", !!item && item.type === "transition" && near(item.a!.st, 14.25) && near(item.b!.st, 10.25));
check("export decodes both sides", needsAt(d1, 4.25).length === 2);
check("outside the window: plain clips", visualPlan(activeTimeline(d1), d1, 2).every((p) => p.type === "clip"));

/* ---------- audio crossfade ---------- */
const tl1 = activeTimeline(d1);
const sa = tl1.clips.find((c) => c.id === "sa")!;
const sb = tl1.clips.find((c) => c.id === "sb")!;
check("the outgoing sound keeps playing into the crossfade", activeAudio(tl1, 4.25).some((c) => c.id === "sa") && activeAudio(tl1, 3.75).some((c) => c.id === "sb"));
check("equal-power crossfade at the middle", near(clipGain(tl1, sa, 4), Math.SQRT1_2) && near(clipGain(tl1, sb, 4), Math.SQRT1_2));
check("full volume outside the crossfade", clipGain(tl1, sa, 1) === 1);
const mix = mixInputs(d1, undefined, 20, () => "blob:s");
const ma = mix.find((m) => m.start === 0)!;
const mb = mix.find((m) => near(m.start, 3.5))!;
check("export: the clips overlap through the crossfade with ramps", ma && near(ma.duration, 4.5) && ma.fades?.[0].dir === "out" && mb && near(mb.sourceIn, 9.5) && mb.fades?.[0].dir === "in");

/* ---------- stacks ---------- */
let tl: Timeline = t0;
const all = FX.effectTargets(tl, d0, ["A", "sa", "nope"]);
check("only video/image clips take picture effects", JSON.stringify(all) === JSON.stringify(["A"]));
tl = FX.addEffect(tl, ["A"], "blur");
tl = FX.addEffect(tl, ["A"], "glow");
const [e1, e2] = tl.clips.find((c) => c.id === "A")!.effects;
tl = FX.moveEffect(tl, "A", e2.id, -1);
check("reorder the stack", tl.clips.find((c) => c.id === "A")!.effects[0].type === "glow");
tl = FX.updateEffect(tl, "A", e1.id, { params: { radius: 500 } });
check("updates are clamped", tl.clips.find((c) => c.id === "A")!.effects.find((e) => e.id === e1.id)!.params.radius === 100);
tl = FX.resetEffect(tl, "A", e1.id);
check("reset", tl.clips.find((c) => c.id === "A")!.effects.find((e) => e.id === e1.id)!.params.radius === 8);
const pasted = FX.applyStackTo(tl, ["B"], tl.clips.find((c) => c.id === "A")!.effects);
const sb2 = pasted.clips.find((c) => c.id === "B")!.effects;
check("paste copies the stack with new ids", sb2.length === 2 && sb2[0].id !== tl.clips.find((c) => c.id === "A")!.effects[0].id);
const locked = E.setTrack(tl, vTrack, { locked: true });
check("locked tracks keep their effects and transitions", FX.addEffect(locked, ["A"], "invert") === locked && FX.addTransition(locked, { trackId: vTrack, from: "B", type: "zoom" }) === locked);
check("drop finds the cut between touching clips", JSON.stringify(FX.placeAt(t0, vTrack, 4.05, 0.2)) === JSON.stringify({ from: "A", to: "B" }));
check("drop finds a clip edge", JSON.stringify(FX.placeAt(t0, vTrack, 10.1, 0.2)) === JSON.stringify({ to: "C" }));
check("drop far from any edge: nothing", FX.placeAt(t0, vTrack, 7, 0.2) === null);

/* ---------- render cache ---------- */
check("adding a transition clears only its window", JSON.stringify(affectedRanges(d0, d1)) === JSON.stringify([[3.5, 4.5]]), affectedRanges(d0, d1));

/* ---------- tools ---------- */
useProject.getState().loadDoc(d0);
const r1 = (await applyCalls([{ tool: "add_effect", args: { clips: "A", effect: "drop shadow", params: { distance: 30 } } }])).results[0];
check("add_effect by everyday name", r1.ok && activeTimeline(useProject.getState().doc).clips.find((c) => c.id === "A")!.effects[0].params.distance === 30, r1);
const r2 = (await applyCalls([{ tool: "add_transition", args: { type: "cross dissolve", from: "A", all_cuts: true } }])).results[0];
check("add_transition at every cut", r2.ok && (activeTimeline(useProject.getState().doc).cutTransitions ?? []).some((x) => x.type === "cross-dissolve"), r2);
const r3 = (await applyCalls([{ tool: "add_effect", args: { clips: "A", effect: "sparkles" } }])).results[0];
check("unknown effects list what exists", !r3.ok && r3.summary.includes("chroma-key"));
const r4 = (await applyCalls([{ tool: "set_effect", args: { clip: "A", effect: "drop-shadow", enabled: false } }])).results[0];
check("set_effect by type", r4.ok && !activeTimeline(useProject.getState().doc).clips.find((c) => c.id === "A")!.effects[0].enabled);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
