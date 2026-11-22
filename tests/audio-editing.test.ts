// Phase 21 rest: clip gain and fade handles, voice-over takes, linked selection.
import { MAX_CLIP_GAIN, fadeFromPx, fadePath, fadeShape, fracToGain, gainLabel, gainToFrac } from "../src/lib/audio/clipEdit";
import { bestTake, newTakeGroup, nextTakeNumber, swapTake, tagClip, takesInGroup, type TakeItem } from "../src/lib/takes";
import * as E from "../src/timeline/engine";
import { viewToDoc } from "../src/model/convert";
import { defaultProject } from "../src/store/project";
import type { Clip, Timeline } from "../src/model/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) < e;

/* ---------- gain line ---------- */
check("gain 1 is the middle of the clip, 2 the top, 0 the bottom", near(gainToFrac(1), 0.5) && gainToFrac(2) === 0 && gainToFrac(0) === 1);
check("out of range gains are held inside the clip", gainToFrac(5) === 0 && gainToFrac(-1) === 1);
check("a pointer at the middle is unity", fracToGain(0.5) === 1);
check("near the middle it snaps to unity", fracToGain(0.51) === 1 && fracToGain(0.49) === 1);
check("elsewhere it moves in 0.01 steps", fracToGain(0.25) === 1.5 && fracToGain(0.75) === 0.5 && fracToGain(0.333) === 1.33);
check("dragging past the edges clamps", fracToGain(-2) === MAX_CLIP_GAIN && fracToGain(3) === 0);
check("the line and the pointer agree", [0.1, 0.4, 0.8, 1.3, 1.9].every((g) => near(fracToGain(gainToFrac(g)), g, 0.011)));
check("gain labels are in dB", gainLabel(1) === "+0.0 dB" && gainLabel(0.5) === "-6.0 dB" && gainLabel(2) === "+6.0 dB" && gainLabel(0) === "-inf dB");

/* ---------- fades ---------- */
check("a fade handle at 40 px of 80 px per second is half a second", fadeFromPx(40, 80, 4, 0) === 0.5);
check("a handle at the edge of the clip is no fade", fadeFromPx(0, 80, 4, 0) === 0 && fadeFromPx(1, 80, 4, 0) === 0);
check("the two fades never cross", fadeFromPx(400, 80, 4, 1.5) === 2.5 && fadeFromPx(400, 80, 4, 4) === 0);
check("a fade longer than the clip is held to the clip", fadeFromPx(1000, 80, 4, 0) === 4);
const shape = fadeShape(10);
check("a fade shape runs from silent to full, equal power", shape[0][1] === 1 && near(shape[10][1], 0) && near(shape[5][1], 1 - Math.sin(Math.PI / 4)) && shape.length === 11);
const pin = fadePath("in", 0, 100, 40);
const pout = fadePath("out", 200, 100, 40);
check("a fade in path starts at the bottom left and ends at the top right", pin.startsWith("M0.0,40.0") && pin.endsWith("100.0,0.0"), pin);
check("a fade out path covers its box from the silent bottom right to the full-level top left", pout.startsWith("M300.0,40.0") && pout.endsWith("200.0,0.0"), pout);

/* ---------- takes ---------- */
const items: (TakeItem & { name: string })[] = [
  { id: "a", name: "t1", duration: 3, take: { group: "g1", n: 1 } },
  { id: "b", name: "t2", duration: 4, take: { group: "g1", n: 2, rating: "good" } },
  { id: "c", name: "t3", duration: 5, take: { group: "g1", n: 3 } },
  { id: "x", name: "other", duration: 2, take: { group: "g2", n: 1 } },
  { id: "plain", name: "music" },
];
check("takes of a group, in order, and no others", takesInGroup(items, "g1").map((i) => i.id).join() === "a,b,c" && takesInGroup(items, "none").length === 0);
check("the next take number follows the highest", nextTakeNumber(items, "g1") === 4 && nextTakeNumber(items, "g2") === 2 && nextTakeNumber(items, "new") === 1);
check("the best take is the newest rated good", bestTake(items, "g1")?.id === "b");
check("without a rating the best is the newest", bestTake(items.map((i) => ({ ...i, take: i.take && { ...i.take, rating: undefined } })), "g1")?.id === "c");
check("group ids are unique", newTakeGroup() !== newTakeGroup());

const base = viewToDoc(defaultProject());
let tl: Timeline = base.timelines[0];
const aTrack = E.addTrack(tl, "audio");
tl = aTrack.tl;
const clip = (id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({ id, trackId: aTrack.id, mediaId: "pm-a", start, duration, sourceIn: 1, sourceOut: 1 + duration, speed: 1, enabled: true, effects: [], keyframes: {}, ...extra });
tl = { ...tl, clips: [...tl.clips, clip("v1", 10, 3, { volume: 0.8, fadeIn: 0.2 }), clip("after", 20, 2)] };

const s1 = swapTake(tl, "v1", { mediaId: "pm-b", duration: 4, group: "g1" });
const c1 = s1.clips.find((c) => c.id === "v1")!;
check("a longer take plays in full when there is room", c1.mediaId === "pm-b" && c1.duration === 4 && c1.sourceIn === 0 && c1.sourceOut === 4 && c1.start === 10 && c1.takeGroup === "g1", c1);
check("the clip keeps its gain and fade", c1.volume === 0.8 && c1.fadeIn === 0.2);
const s2 = swapTake(tl, "v1", { mediaId: "pm-long", duration: 30 });
check("a take never runs over the next clip", s2.clips.find((c) => c.id === "v1")!.duration === 10, s2.clips.find((c) => c.id === "v1"));
check("a shorter take shortens the clip", swapTake(tl, "v1", { mediaId: "pm-s", duration: 1.5 }).clips.find((c) => c.id === "v1")!.duration === 1.5);
check("swapping resets speed and reverse", (() => {
  const k = swapTake({ ...tl, clips: tl.clips.map((c) => (c.id === "v1" ? { ...c, speed: 2, reverse: true } : c)) }, "v1", { mediaId: "pm-b", duration: 2 }).clips.find((c) => c.id === "v1")!;
  return k.speed === 1 && !k.reverse;
})());
check("an unknown clip or a zero length changes nothing", swapTake(tl, "nope", { mediaId: "m", duration: 2 }) === tl && swapTake(tl, "v1", { mediaId: "m", duration: 0 }) === tl);
check("tagging adds the group and nothing else", (() => {
  const t = tagClip(tl, "v1", "g9");
  const k = t.clips.find((c) => c.id === "v1")!;
  return k.takeGroup === "g9" && k.volume === 0.8 && t.clips.length === tl.clips.length;
})());

/* ---------- linked selection ---------- */
const vTrack = E.addTrack(tl, "video");
let lt: Timeline = vTrack.tl;
const vclip: Clip = { id: "pic", trackId: vTrack.id, mediaId: "pm-v", start: 0, duration: 5, sourceIn: 0, sourceOut: 5, speed: 1, enabled: true, effects: [], keyframes: {} };
const sclip: Clip = { id: "snd", trackId: aTrack.id, mediaId: "pm-v", start: 0, duration: 5, sourceIn: 0, sourceOut: 5, speed: 1, enabled: true, effects: [], keyframes: {} };
lt = { ...lt, clips: [...lt.clips.filter((c) => c.id !== "v1" && c.id !== "after"), vclip, sclip] };
const linked = E.linkClips(lt, ["pic", "snd"]);
const lid = linked.clips.find((c) => c.id === "pic")!.linkId;
check("linking gives both clips one group", !!lid && linked.clips.find((c) => c.id === "snd")!.linkId === lid);
check("linking one clip does nothing", E.linkClips(lt, ["pic"]) === lt);
check("by default selecting one brings the other", E.linkedEditing() && E.withLinked(linked, ["pic"]).sort().join() === "pic,snd");
E.setLinkedEditing(false);
check("with linked selection off each clip is on its own", E.withLinked(linked, ["pic"]).join() === "pic");
check("the links are kept while it is off", linked.clips.find((c) => c.id === "pic")!.linkId === lid);
E.setLinkedEditing(true);
check("turned on again, they go together", E.withLinked(linked, ["snd"]).sort().join() === "pic,snd");
const unl = E.unlinkClips(linked, ["pic"]);
check("unlinking takes the whole group apart", unl.clips.every((c) => !c.linkId) && E.unlinkClips(lt, ["pic"]) === lt);
const relinked = E.linkClips({ ...linked, clips: [...linked.clips, { ...sclip, id: "extra", start: 6 }] }, ["pic", "extra"]);
check("moving a clip to a new group leaves no single-clip group behind", relinked.clips.find((c) => c.id === "snd")!.linkId === undefined && relinked.clips.find((c) => c.id === "pic")!.linkId === relinked.clips.find((c) => c.id === "extra")!.linkId);

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
