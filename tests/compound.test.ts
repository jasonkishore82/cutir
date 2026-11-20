// Phases 23 and 24: compound clips, nesting, versions, reframing, subclips, multicam clips, sync placement, retimed edits.
import { viewToDoc, activeTimeline, docToView } from "../src/model/convert";
import { defaultProject } from "../src/store/project";
import * as E from "../src/timeline/engine";
import { applySync, commitMulticam, coverRatio, duplicateTimeline, flattenNested, makeCompound, makeMulticam, makeSubclip, offsetsFromLags, placeTimeline, placeable, reframeTimeline, reframeX, subclipSource, syncedStart, usesTimeline } from "../src/timeline/compound";
import { compositeVisuals, needsAt, sourceTime, visualMediaIds, visualPlan } from "../src/render/compositor";
import { mixInputs } from "../src/render/audio";
import { addCut } from "../src/lib/multicam";
import { rampIntegral } from "../src/lib/retime";
import type { Clip, ProjectDoc } from "../src/model/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

const clip = (o: Partial<Clip> & { id: string; trackId: string }): Clip => ({ start: 0, duration: 4, sourceIn: 0, sourceOut: 4, speed: 1, enabled: true, effects: [], keyframes: {}, ...o });

/** A document with two video tracks, an audio track and three media. */
function setup(): { doc: ProjectDoc; v1: string; v2: string; a1: string } {
  let doc = viewToDoc(defaultProject());
  let tl = activeTimeline(doc);
  const v1 = E.addTrack(tl, "video");
  tl = v1.tl;
  const v2 = E.addTrack(tl, "video");
  tl = v2.tl;
  const a1 = tl.tracks.find((t) => t.kind === "audio")?.id ?? E.addTrack(tl, "audio").id;
  if (!tl.tracks.some((t) => t.id === a1)) tl = E.addTrack(tl, "audio").tl;
  doc = { ...doc, timelines: doc.timelines.map((t) => (t.id === tl.id ? tl : t)), media: [{ id: "m1", name: "a.mp4", kind: "video", fileKey: "a", poolId: "1", duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }, { id: "m2", name: "b.mp4", kind: "video", fileKey: "b", poolId: "2", duration: 60, fps: 30, width: 1920, height: 1080 }, { id: "m3", name: "rec.wav", kind: "audio", fileKey: "c", poolId: "3", duration: 120 }] };
  return { doc, v1: v1.id, v2: v2.id, a1 };
}
const putClips = (doc: ProjectDoc, clips: Clip[]): ProjectDoc => E.onActive(doc, (t) => ({ ...t, clips: [...t.clips, ...clips] }));

/* ---------- retimed edits ---------- */
{
  const { doc, v1 } = setup();
  const ramp = { ease: false, keys: [{ t: 0, speed: 1 }, { t: 4, speed: 3 }] };
  const c = clip({ id: "r", trackId: v1, mediaId: "m1", start: 0, duration: 4, sourceIn: 10, sourceOut: 10 + 8, ramp });
  check("a ramp clip's source range matches the integral", near(rampIntegral(ramp, 4), 8));
  const tl = E.blade(activeTimeline(putClips(doc, [c])), 2, ["r"]);
  const parts = tl.clips.filter((x) => x.trackId === v1).sort((a, b) => a.start - b.start);
  check("blading a ramp clip splits the source where the ramp had got to", parts.length === 2 && near(parts[0].sourceOut, 10 + 3) && near(parts[1].sourceIn, 13) && parts[1].ramp!.keys[0].speed === 2, parts.map((p) => [p.sourceIn, p.sourceOut]));
  check("both halves of a split ramp end where the whole did", near(parts[1].sourceOut, 18));
  const fwd = clip({ id: "f", trackId: v1, mediaId: "m1", start: 0, duration: 10, sourceIn: 0, sourceOut: 20, speed: 2 });
  const cut = E.blade(activeTimeline(putClips(doc, [fwd])), 5, ["f"]).clips.filter((x) => x.trackId === v1).sort((a, b) => a.start - b.start);
  check("constant speed still splits as before", near(cut[0].sourceOut, 10) && near(cut[1].sourceIn, 10));
  const rev = clip({ id: "v", trackId: v1, mediaId: "m1", start: 0, duration: 10, sourceIn: 0, sourceOut: 10, reverse: true });
  const rcut = E.blade(activeTimeline(putClips(doc, [rev])), 4, ["v"]).clips.filter((x) => x.trackId === v1).sort((a, b) => a.start - b.start);
  check("a reversed clip splits with the earlier part showing the later source", near(rcut[0].sourceIn, 6) && near(rcut[0].sourceOut, 10) && near(rcut[1].sourceIn, 0) && near(rcut[1].sourceOut, 6), rcut.map((p) => [p.sourceIn, p.sourceOut]));
  check("a reversed clip plays its source backwards", sourceTime(rev, 0) === 10 && sourceTime(rev, 10) === 0);
  const ctx = { fps: 30, mediaDuration: () => 60 };
  const trimmed = E.trimEdge(activeTimeline(putClips(doc, [clip({ id: "t", trackId: v1, mediaId: "m1", start: 5, duration: 4, sourceIn: 10, sourceOut: 18, speed: 2 })])), "t", "end", -1, false, ctx).clips.find((x) => x.id === "t")!;
  check("trimming the end of a fast clip moves its source by speed", near(trimmed.duration, 3) && near(trimmed.sourceOut, 16));
  const rtrim = E.trimEdge(activeTimeline(putClips(doc, [clip({ id: "u", trackId: v1, mediaId: "m1", start: 5, duration: 4, sourceIn: 10, sourceOut: 14, reverse: true })])), "u", "end", -1, false, ctx).clips.find((x) => x.id === "u")!;
  check("trimming the end of a reversed clip eats its earlier source", near(rtrim.sourceIn, 11) && near(rtrim.sourceOut, 14), [rtrim.sourceIn, rtrim.sourceOut]);
  const htrim = E.trimEdge(activeTimeline(putClips(doc, [clip({ id: "w", trackId: v1, mediaId: "m1", start: 5, duration: 4, sourceIn: 0, sourceOut: 8, ramp: { ease: false, keys: [{ t: 0, speed: 1 }, { t: 4, speed: 3 }] } })])), "w", "start", 1, false, ctx).clips.find((x) => x.id === "w")!;
  check("trimming the head of a ramp clip re-bases its ramp", near(htrim.sourceIn, rampIntegral({ ease: false, keys: [{ t: 0, speed: 1 }, { t: 4, speed: 3 }] }, 1)) && near(htrim.ramp!.keys[0].speed, 1.5) && htrim.duration === 3, htrim);
}

/* ---------- compound and nested ---------- */
{
  const { doc, v1, v2, a1 } = setup();
  const d1 = putClips(doc, [clip({ id: "c1", trackId: v1, mediaId: "m1", start: 2, duration: 4 }), clip({ id: "c2", trackId: v2, mediaId: "m2", start: 3, duration: 5 }), clip({ id: "s1", trackId: a1, mediaId: "m3", start: 2, duration: 6 }), clip({ id: "keep", trackId: v1, mediaId: "m2", start: 20, duration: 2 })]);
  const made = makeCompound(d1, ["c1", "c2", "s1"], "Intro")!;
  const tl = activeTimeline(made.doc);
  const nested = made.doc.timelines.find((t) => t.id === made.timelineId)!;
  check("the selection moves into a new timeline, shifted to start at 0", nested.clips.length === 3 && Math.min(...nested.clips.map((c) => c.start)) === 0 && nested.name === "Intro" && nested.tracks.length === 3, nested.clips.map((c) => c.start));
  check("the original clips are replaced by one compound clip", !tl.clips.some((c) => ["c1", "c2", "s1"].includes(c.id)) && tl.clips.some((c) => c.id === made.clipId && c.timelineId === made.timelineId && c.start === 2 && near(c.duration, 6)) && tl.clips.some((c) => c.id === "keep"));
  check("nested tracks are copies with new ids", nested.tracks.every((t) => !tl.tracks.some((x) => x.id === t.id)) && nested.clips.every((c) => nested.tracks.some((t) => t.id === c.trackId)));
  check("locked tracks are refused", makeCompound(E.onActive(d1, (t) => E.setTrack(t, v1, { locked: true })), ["c1"]) === null);
  check("nothing selected makes nothing", makeCompound(d1, ["zzz"]) === null);

  // the compound is a picture at its time, and what is inside plays through it
  const plan = visualPlan(tl, made.doc, 4);
  check("the compound clip is one nested visual", plan.some((p) => p.type === "clip" && p.v.kind === "nested" && p.v.nested?.id === made.timelineId && near(p.v.st, 2)), plan.map((p) => p.type === "clip" ? p.v.kind : p.type));
  const needs = needsAt(made.doc, 4);
  check("export decodes what is inside the compound, at nested time", needs.some((n) => n.mediaId === "m1" && near(n.sourceTime, 2)) && needs.some((n) => n.mediaId === "m2" && near(n.sourceTime, 1)), needs);
  const ins = mixInputs(made.doc, undefined, 30, (id) => `blob:${id}`);
  check("its sound is mixed at the compound's place", ins.some((i) => i.url === "blob:m3" && near(i.start, 2) && near(i.duration, 6)), ins.map((i) => [i.url, i.start, i.duration]));

  // editing inside updates the use
  const inner = nested.clips.find((c) => c.mediaId === "m1")!;
  const edited = { ...made.doc, timelines: made.doc.timelines.map((t) => (t.id === nested.id ? { ...t, clips: t.clips.map((c) => (c.id === inner.id ? { ...c, mediaId: "m2" } : c)) } : t)) };
  check("changing a clip inside changes what the compound shows", needsAt(edited, 2.5).some((n) => n.mediaId === "m2") && !needsAt(edited, 2.5).some((n) => n.mediaId === "m1"));
  check("every use of a timeline follows (placed twice)", (() => { const p1 = placeTimeline(edited, nested.id, 30, v2)!; const p2 = placeTimeline(p1.doc, nested.id, 50, v2)!; return needsAt(p2.doc, 31).some((n) => n.mediaId === "m2") && needsAt(p2.doc, 51).some((n) => n.mediaId === "m2"); })());
  check("the media of nested clips stays open", visualMediaIds(made.doc).has("m1"));

  // a speed change on the compound clip retimes what is inside
  const faster = { ...made.doc, timelines: made.doc.timelines.map((t) => (t.id === tl.id ? { ...t, clips: t.clips.map((c) => (c.id === made.clipId ? { ...c, speed: 2, duration: 3 } : c)) } : t)) };
  check("a nested clip at double speed shows nested time twice as fast", visualPlan(activeTimeline(faster), faster, 3).some((p) => p.type === "clip" && p.v.kind === "nested" && near(p.v.st, 2)));

  // flatten
  const flat = flattenNested(made.doc, made.clipId)!;
  const ftl = activeTimeline(flat);
  check("flatten puts the clips back, at their old times", ftl.clips.some((c) => c.mediaId === "m1" && near(c.start, 2) && near(c.duration, 4)) && ftl.clips.some((c) => c.mediaId === "m2" && near(c.start, 3)) && ftl.clips.some((c) => c.mediaId === "m3" && near(c.start, 2)) && !ftl.clips.some((c) => c.timelineId), ftl.clips.map((c) => [c.mediaId, c.start]));
  check("an unused nested timeline is dropped", !flat.timelines.some((t) => t.id === made.timelineId));
  check("flatten keeps a nested timeline that is used elsewhere", (() => { const p = placeTimeline(made.doc, nested.id, 40, v2)!; return flattenNested(p.doc, made.clipId)!.timelines.some((t) => t.id === nested.id); })());
  const fastFlat = flattenNested(faster, made.clipId)!;
  check("flatten applies the compound's speed to its parts", activeTimeline(fastFlat).clips.some((c) => c.mediaId === "m1" && c.speed === 2 && near(c.duration, 2)), activeTimeline(fastFlat).clips.map((c) => [c.mediaId, c.speed, c.duration]));

  // loops
  check("a timeline cannot be placed inside itself", placeTimeline(made.doc, tl.id, 0) === null);
  const inNested = { ...made.doc, activeTimelineId: nested.id };
  check("a timeline that shows the host is not placeable", placeTimeline(inNested, tl.id, 0) === null && !placeable(inNested, nested.id).some((t) => t.id === tl.id) && usesTimeline(made.doc, tl.id, nested.id));
  check("the host is placeable on a timeline that does not contain it", placeable(made.doc, tl.id).some((t) => t.id === nested.id));
}

/* ---------- versions and reframing ---------- */
{
  const { doc, v1, a1 } = setup();
  const tracked = { id: "tk", name: "P", x: 0.8, y: 0.5, t0: 0, samples: [{ t: 0, x: 0.8, y: 0.5, c: 1 }, { t: 2, x: 0.3, y: 0.5, c: 1 }, { t: 4, x: 0.3, y: 0.5, c: 1 }] };
  const d1 = putClips(doc, [clip({ id: "c1", trackId: v1, mediaId: "m1", start: 0, duration: 4, trackers: [tracked], matte: { clipId: "c2", mode: "alpha" } }), clip({ id: "c2", trackId: v1, mediaId: "m2", start: 4, duration: 4 }), clip({ id: "s", trackId: a1, mediaId: "m3", start: 0, duration: 8, linkId: "L" })]);
  const dup = duplicateTimeline(d1, d1.activeTimelineId, "9:16")!;
  const copy = dup.doc.timelines.find((t) => t.id === dup.timelineId)!;
  const orig = activeTimeline(d1);
  check("a duplicate has new ids but the same shape", copy.clips.length === orig.clips.length && copy.clips.every((c) => !orig.clips.some((o) => o.id === c.id)) && copy.tracks.every((t) => !orig.tracks.some((o) => o.id === t.id)) && copy.name === "9:16");
  check("references inside the copy point at the copy", (() => { const c1 = copy.clips.find((c) => c.mediaId === "m1")!; const c2 = copy.clips.find((c) => c.mediaId === "m2")!; return c1.matte!.clipId === c2.id; })());
  check("editing the copy leaves the original", (() => { const c = copy.clips.find((x) => x.mediaId === "m1")!; return c !== orig.clips.find((x) => x.mediaId === "m1"); })());
  check("a duplicate's tracks are not marked as the insert target", copy.tracks.every((t) => !t.target));

  check("a 16:9 picture in 9:16 is about 3.16 frames wide", near(coverRatio(16 / 9, 9 / 16), (16 / 9) / (9 / 16), 1e-9) && coverRatio(9 / 16, 16 / 9) === 1);
  const r = coverRatio(16 / 9, 9 / 16);
  check("reframing centres a point and never shows an edge", near(reframeX(0.5, r), 0.5) && reframeX(0.8, r) < 0.5 && reframeX(0.8, r) >= 0.5 - (r - 1) / 2 && reframeX(0.0, r) <= 0.5 + (r - 1) / 2 && reframeX(0.2, 1) === 0.5);
  const ref = reframeTimeline(dup.doc, dup.timelineId, "9:16")!;
  const rt = ref.timelines.find((t) => t.id === dup.timelineId)!;
  const c1 = rt.clips.find((c) => c.mediaId === "m1")!;
  check("the version has its own frame shape and the original keeps its own", rt.aspect === "9:16" && activeTimeline(ref).aspect === undefined);
  check("picture clips fill the new frame", c1.transform?.fit === "cover" && rt.clips.filter((c) => c.mediaId === "m1" || c.mediaId === "m2").every((c) => c.transform?.fit === "cover"));
  check("a tracked clip follows its point with position keys", (c1.anim?.x?.length ?? 0) > 10 && near(c1.anim!.x![0].v as number, reframeX(0.8, r), 1e-3) && (c1.anim!.x![c1.anim!.x!.length - 1].v as number) > reframeX(0.8, r), c1.anim?.x?.slice(0, 3));
  check("an untracked clip is simply centred", rt.clips.find((c) => c.mediaId === "m2")!.transform?.x === 0.5 && !rt.clips.find((c) => c.mediaId === "m2")!.anim);
  check("the sound is left alone", rt.clips.find((c) => c.mediaId === "m3")!.transform === undefined);
  const view = docToView({ ...ref, activeTimelineId: dup.timelineId });
  check("opening the version shows the 9:16 shape", view.aspect === "9:16" && docToView(ref).aspect === "16:9");
  const back = viewToDoc({ ...view, aspect: "1:1" }, { ...ref, activeTimelineId: dup.timelineId });
  check("changing the shape of a version changes only the version", back.timelines.find((t) => t.id === dup.timelineId)!.aspect === "1:1" && back.settings.aspect === "16:9");
}

/* ---------- subclips ---------- */
{
  const { doc, v1, a1 } = setup();
  const d1 = makeSubclip(doc, "Intro line", "m1", 12, 18.5)!;
  check("a subclip is a named range of a media file", d1.subclips!.length === 1 && d1.subclips![0].in === 12 && d1.subclips![0].out === 18.5);
  check("too short or unknown media makes none", makeSubclip(doc, "x", "m1", 3, 3.01) === null && makeSubclip(doc, "x", "nope", 0, 5) === null);
  const src = subclipSource(d1, d1.subclips![0])!;
  check("a subclip stands for a range of its media with sound", src.in === 12 && src.out === 18.5 && src.withAudio === true && src.kind === "video");
  const placed = E.overwriteEdit(activeTimeline(d1), src, 3, { video: v1, audio: a1 });
  check("placing a subclip makes the video and its sound", placed.ids.length === 2 && placed.tl.clips.filter((c) => c.sourceIn === 12 && near(c.duration, 6.5)).length === 2);
}

/* ---------- multicam ---------- */
{
  const { doc, v1, a1 } = setup();
  const made = makeMulticam(doc, [{ mediaId: "m1", name: "Wide", offset: 0 }, { mediaId: "m2", name: "Close", offset: 2.5 }], 5, 20, v1, { mediaId: "m3", offset: -1 })!;
  const mc = activeTimeline(made.doc).clips.find((c) => c.id === made.clipId)!;
  check("a multicam clip carries its angles", mc.multicam!.angles.length === 2 && mc.multicam!.angles[1].offset === 2.5 && mc.duration === 20 && mc.mediaId === "m1");
  check("fewer than two angles is refused", makeMulticam(doc, [{ mediaId: "m1", name: "x", offset: 0 }], 0, 5, v1) === null);
  let spec = addCut(mc.multicam!, 6, "ang2");
  spec = addCut(spec, 12, "ang1");
  const cutDoc = { ...made.doc, timelines: made.doc.timelines.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === made.clipId ? { ...c, multicam: spec } : c)) })) };
  const at = (t: number) => visualPlan(activeTimeline(cutDoc), cutDoc, t).filter((p) => p.type === "clip").map((p) => (p as { v: { mediaId?: string; st: number; clip: Clip } }).v);
  // cuts are in the multicam clip's own time: the clip starts at 5 s, so the cut at 6 is at 11 s on the timeline
  check("the angle on at a time is drawn at its own offset", at(13)[0].mediaId === "m2" && near(at(13)[0].st, 8 + 2.5) && at(19)[0].mediaId === "m1" && near(at(19)[0].st, 14) && at(7)[0].mediaId === "m1", at(13));
  check("decoding follows the cuts", needsAt(cutDoc, 13).length === 1 && needsAt(cutDoc, 13)[0].mediaId === "m2" && near(needsAt(cutDoc, 13)[0].sourceTime, 10.5));
  check("every angle's media stays open", visualMediaIds(cutDoc).has("m2") && visualMediaIds(cutDoc).has("m1"));
  const ins = mixInputs(cutDoc, undefined, 60, (id) => `blob:${id}`);
  check("with a separate recorder the sound is one stretch from it, skipping the second before it started", ins.length === 1 && ins[0].url === "blob:m3" && near(ins[0].start, 6) && near(ins[0].duration, 19) && near(ins[0].sourceIn, 0), ins.map((i) => [i.url, i.start, i.duration, i.sourceIn]));
  const noRec = { ...cutDoc, timelines: cutDoc.timelines.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === made.clipId ? { ...c, multicam: { ...spec, audioMediaId: undefined } } : c)) })) };
  const ins2 = mixInputs(noRec, undefined, 60, (id) => `blob:${id}`);
  check("without one the sound follows the angle on", ins2.length === 3 && ins2[1].url === "blob:m2" && near(ins2[1].start, 11) && near(ins2[1].sourceIn, 8.5), ins2.map((i) => [i.url, i.start, i.sourceIn]));

  const done = commitMulticam(noRec, made.clipId)!;
  const dtl = activeTimeline(done);
  const vids = dtl.clips.filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start);
  check("committing makes ordinary clips, one per stretch", !dtl.clips.some((c) => c.multicam) && vids.length === 3 && vids[0].mediaId === "m1" && vids[1].mediaId === "m2" && near(vids[1].start, 11) && near(vids[1].duration, 6) && near(vids[1].sourceIn, 8.5) && vids[2].mediaId === "m1", vids.map((c) => [c.mediaId, c.start, c.duration, c.sourceIn]));
  check("the stretches are contiguous", near(vids[0].start + vids[0].duration, vids[1].start) && near(vids[1].start + vids[1].duration, vids[2].start));
  check("their sound goes on the audio track", dtl.clips.filter((c) => c.trackId === a1).length === 3);
  const lag = syncedStart(clip({ id: "a", trackId: v1, start: 10, sourceIn: 0 }), clip({ id: "b", trackId: a1, start: 0, sourceIn: 0 }), 3.25);
  check("a recorder that starts 3.25 s into the camera audio is placed 3.25 s later", near(lag, 13.25));
  check("trimmed clips keep the sync", near(syncedStart(clip({ id: "a", trackId: v1, start: 10, sourceIn: 5 }), clip({ id: "b", trackId: a1, sourceIn: 2 }), 7), 10 + 2 + 2));
  const base = putClips(doc, [clip({ id: "cam", trackId: v1, mediaId: "m1", start: 10 }), clip({ id: "ext", trackId: a1, mediaId: "m3", start: 0 })]);
  const synced = applySync(activeTimeline(base), "cam", [{ clipId: "ext", lag: 3.25 }]);
  const ext = synced.clips.find((c) => c.id === "ext")!;
  const cam = synced.clips.find((c) => c.id === "cam")!;
  check("sync moves the recorder and links the pair", near(ext.start, 13.25) && !!ext.linkId && ext.linkId === cam.linkId);
  check("a negative lag never goes before zero", applySync(activeTimeline(base), "cam", [{ clipId: "ext", lag: -50 }]).clips.find((c) => c.id === "ext")!.start === 0);
  check("angle offsets are the negated lags", offsetsFromLags([0, 3.25, -1]).join() === "0,-3.25,1");
}

/* ---------- nothing drawn needs a canvas to be planned ---------- */
check("compositeVisuals is exported for the viewer", typeof compositeVisuals === "function");

if (fails) process.exit(1);
console.log("all passed");
