// Phases 13 and 14: the multi-track editing engine (src/timeline/engine.ts).
import * as E from "../src/timeline/engine";
import type { Clip, Timeline, Track } from "../src/model/types";
import { DEFAULT_STYLE } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 500)}`}`);
}
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-6;

const ctx: E.EditCtx = { fps: 25, mediaDuration: (id) => ({ long: 100, short: 6, a: 30, b: 30 })[id] };
const track = (id: string, kind: Track["kind"], extra: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, locked: false, solo: false, height: 44, hidden: false, ...extra });
const clip = (id: string, trackId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id, trackId, start, duration, sourceIn: 10, sourceOut: 10 + duration, speed: 1, enabled: true, effects: [], keyframes: {}, mediaId: "long", ...extra,
});
/** V2 (top), V1, A1, A2, S1; V1 clips a,b,c touching; A1 linked to a; a locked track L. */
function seq(): Timeline {
  return {
    id: "t", name: "t", markers: [], textStyle: DEFAULT_STYLE, transition: { type: "none", ms: 400 },
    tracks: [track("S1", "subtitle"), track("V1", "video"), track("V2", "video"), track("A1", "audio"), track("A2", "audio"), track("L", "video", { locked: true })],
    clips: [
      clip("a", "V1", 0, 4, { linkId: "la" }),
      clip("b", "V1", 4, 3),
      clip("c", "V1", 7, 5),
      clip("aa", "A1", 0, 4, { linkId: "la" }),
      clip("x", "A2", 2, 4),
      clip("lk", "L", 0, 20),
      { ...clip("song", "A1", 0, 0), fill: true },
    ],
  };
}
const get = (tl: Timeline, id: string) => tl.clips.find((c) => c.id === id)!;
const on = (tl: Timeline, tr: string) => E.clipsOn(tl, tr).map((c) => `${c.id}@${+c.start.toFixed(3)}+${+c.duration.toFixed(3)}`).join(" ");
const lockedSame = (a: Timeline, b: Timeline) => JSON.stringify(get(a, "lk")) === JSON.stringify(get(b, "lk"));

/* ---------- tracks ---------- */
{
  const r = E.addTrack(seq(), "video");
  check("add a video track: goes on top of the video tracks", r.tl.tracks.filter((t) => t.kind === "video").map((t) => t.id).join() === "V1,V2,L," + r.id || r.tl.tracks.filter((t) => t.kind === "video").pop()!.id === r.id);
  check("display order: subtitle, video top-down, audio", E.displayOrder(seq()).map((t) => t.id).join() === "S1,L,V2,V1,A1,A2");
  check("remove a track removes its clips", !E.removeTrack(seq(), "V1").clips.some((c) => c.trackId === "V1"));
  check("the last subtitle track stays", E.removeTrack(seq(), "S1").tracks.some((t) => t.id === "S1"));
  check("a locked track cannot be removed", E.removeTrack(seq(), "L").tracks.some((t) => t.id === "L"));
  check("reorder tracks within a kind", E.moveTrack(seq(), "V2", 0).tracks.filter((t) => t.kind === "video").map((t) => t.id).join() === "V2,V1,L");
  const tg = E.setTarget(E.setTarget(seq(), "V2"), "A2");
  check("one target per kind", E.targetTrack(tg, "video")?.id === "V2" && E.targetTrack(tg, "audio")?.id === "A2" && tg.tracks.filter((t) => t.target).length === 2);
}

/* ---------- selection, snapping, windowing ---------- */
{
  const tl = seq();
  check("linked selection brings the sound", E.withLinked(tl, ["a"]).sort().join() === "a,aa");
  check("marquee selects clips touching the range", E.clipsInRange(tl, 3, 5, ["V1", "A2"]).sort().join() === "a,b,x");
  check("marquee skips locked tracks", E.clipsInRange(tl, 0, 1, ["L"]).length === 0);
  const pts = E.snapPoints(tl, { playhead: 9.5 }, ["b"]);
  check("snap points: playhead and other clips' edges, not the dragged clip", pts.includes(9.5) && pts.includes(7) && !pts.includes(4.0001));
  check("snap a time within the threshold", E.snapTime(9.42, pts, 0.1).t === 9.5);
  check("no snap outside the threshold", E.snapTime(9.2, pts, 0.1).t === 9.2);
  check("snap a moving block by its nearest edge", near(E.snapDelta([4, 7], 2.43, [9.5], 0.1).dt, 2.5));
  const many: Clip[] = Array.from({ length: 500 }, (_, i) => clip(`m${i}`, "V1", i * 2, 1.5));
  const t0 = performance.now();
  let shown = 0;
  for (let k = 0; k < 600; k++) shown = E.visibleClips(many, 300 + k, 330 + k, 1.5).length; // 600 scroll frames
  const ms = performance.now() - t0;
  check(`windowing 500 clips: only clips in view (${shown}), 600 frames in ${ms.toFixed(1)} ms`, shown === 16 && ms < 200);
}

/* ---------- move ---------- */
{
  const tl = seq();
  const m = E.moveClips(tl, ["a"], 20);
  check("moving a clip moves its linked sound", near(get(m, "a").start, 20) && near(get(m, "aa").start, 20));
  check("a move never goes before 0", near(get(E.moveClips(tl, ["b"], -10), "b").start, 0));
  const over = E.moveClips(tl, ["c"], -5); // c 7..12 -> 2..7 overwrites end of a (0..4) and all of b (4..7)
  check("moved clips overwrite what they land on", on(over, "V1") === "a@0+2 c@2+5", on(over, "V1"));
  const up = E.moveClips(tl, ["b"], 0, 1, "video");
  check("drag across tracks: one track up", get(up, "b").trackId === "V2");
  check("no track to move to: nothing happens", E.moveClips(tl, ["b"], 0, 5, "video") === tl);
  check("cannot move onto a locked track", E.moveClips(tl, ["b"], 0, 2, "video") === tl);
  check("cannot move a clip on a locked track", E.moveClips(tl, ["lk"], 3) === tl);
  check("fill clips are not moved", E.moveClips(tl, ["song"], 3) === tl);
  const nudged = E.moveClips(tl, ["c"], 10 / 25);
  check("nudge by ten frames", near(get(nudged, "c").start, 7.4));
  const dup = E.duplicateClips(tl, ["a"], 30);
  check("duplicate copies linked clips with a fresh link", dup.ids.length === 2 && new Set(dup.ids.map((i) => get(dup.tl, i).linkId)).size === 1 && get(dup.tl, dup.ids[0]).linkId !== "la");
  check("moves leave locked tracks alone", lockedSame(tl, m) && lockedSame(tl, over));
}

/* ---------- delete ---------- */
{
  const tl = seq();
  check("delete leaves a gap", on(E.deleteClips(tl, ["b"]), "V1") === "a@0+4 c@7+5");
  check("ripple delete closes the gap", on(E.rippleDelete(tl, ["b"]), "V1") === "a@0+4 c@4+5");
  const rd = E.rippleDelete(tl, ["a"]);
  check("ripple delete with linked sound closes both tracks", on(rd, "V1") === "b@0+3 c@3+5" && !rd.clips.some((c) => c.id === "aa"));
  check("ripple delete does not touch other tracks", on(rd, "A2") === "x@2+4");
}

/* ---------- blade ---------- */
{
  const tl = seq();
  const b = E.blade(tl, 2);
  check("blade cuts every unlocked clip under the playhead", on(b, "V1").startsWith("a@0+2 ") && E.clipsOn(b, "A1").length === 2 && E.clipsOn(b, "A2").length === 1); // x starts at 2: nothing to cut
  check("blade keeps the source continuous", near(E.clipsOn(b, "V1")[1].sourceIn, 12));
  check("blade relinks the right halves together", (() => {
    const r = E.clipsOn(b, "V1")[1];
    const ra = E.clipsOn(b, "A1")[1];
    return r.linkId === ra.linkId && r.linkId !== "la";
  })());
  check("blade never cuts locked tracks", E.clipsOn(b, "L").length === 1);
  check("blade on selected clips only", E.clipsOn(E.blade(tl, 3, ["x"]), "V1").length === 3);
}

/* ---------- trims ---------- */
{
  const tl = seq();
  const t1 = E.trimEdge(tl, "c", "end", 2, false, ctx);
  check("trim an end out", near(get(t1, "c").duration, 7) && near(get(t1, "c").sourceOut, 17));
  check("normal trim stops at the next clip", near(get(E.trimEdge(tl, "a", "end", 3, false, ctx), "a").duration, 4));
  check("normal trim of a head stops at the previous clip", near(get(E.trimEdge(tl, "b", "start", -2, false, ctx), "b").start, 4));
  check("trim stops at the start of the source", near(get(E.trimEdge(E.deleteClips(tl, ["a"]), "b", "start", -20, false, ctx), "b").start, 0));
  const shortTl: Timeline = { ...tl, clips: tl.clips.map((c) => (c.id === "c" ? { ...c, mediaId: "short", sourceIn: 0, sourceOut: 5 } : c)) };
  check("trim stops at the end of the source", near(get(E.trimEdge(shortTl, "c", "end", 5, false, ctx), "c").duration, 6));
  check("a clip never gets shorter than a frame", near(get(E.trimEdge(tl, "b", "end", -10, false, ctx), "b").duration, 1 / 25));

  const r1 = E.trimEdge(tl, "a", "end", 1, true, ctx);
  check("ripple trim out: later clips move", on(r1, "V1") === "a@0+5 b@5+3 c@8+5", on(r1, "V1"));
  check("ripple trim takes the linked sound along", near(get(r1, "aa").duration, 5));
  const r2 = E.trimEdge(tl, "b", "start", 1, true, ctx);
  check("ripple trim of a head: clip stays put, later clips move up", on(r2, "V1") === "a@0+4 b@4+2 c@6+5" && near(get(r2, "b").sourceIn, 11), on(r2, "V1"));
  check("trims never touch locked tracks", E.trimEdge(tl, "lk", "end", 1, false, ctx) === tl && lockedSame(tl, r1));

  const ro = E.roll(tl, "a", "b", 1, ctx);
  check("roll moves the cut, total length unchanged", on(ro, "V1") === "a@0+5 b@5+2 c@7+5" && near(get(ro, "b").sourceIn, 11));
  check("roll stops a frame before eating the next clip", near(get(E.roll(tl, "a", "b", 10, ctx), "b").duration, 1 / 25));
  check("roll needs touching clips", E.roll(tl, "a", "c", 1, ctx) === tl);

  const sl = E.slip(tl, "b", 3, ctx);
  check("slip changes the source range only", on(sl, "V1") === on(tl, "V1") && near(get(sl, "b").sourceIn, 13) && near(get(sl, "b").sourceOut, 16));
  check("slip stops at the start of the source", near(get(E.slip(tl, "b", -50, ctx), "b").sourceIn, 0));
  check("slip moves the linked sound too", near(get(E.slip(tl, "a", 2, ctx), "aa").sourceIn, 12));

  const sd = E.slide(tl, "b", 1, ctx);
  check("slide: clip moves, neighbours absorb", on(sd, "V1") === "a@0+5 b@5+3 c@8+4" && near(get(sd, "b").sourceIn, 10) && near(get(sd, "c").sourceIn, 11), on(sd, "V1"));
  check("slide stops before a neighbour vanishes", near(get(E.slide(tl, "b", 9, ctx), "c").duration, 1 / 25));
  const gap = E.deleteClips(tl, ["c"]);
  check("slide into a gap just moves", on(E.slide(gap, "b", 2, ctx), "V1") === "a@0+6 b@6+3");
}

/* ---------- the smart pointer ---------- */
{
  const tl = seq();
  const pps = 50; // b is 150 px wide
  check("selection tool: edge trims", E.pointerMode(tl, "b", 3, 0.5, pps, "select") === "trim-start" && E.pointerMode(tl, "b", 147, 0.5, pps, "select") === "trim-end");
  check("selection tool: body moves", E.pointerMode(tl, "b", 75, 0.5, pps, "select") === "move");
  check("trim tool: right at a cut rolls", E.pointerMode(tl, "b", 1, 0.5, pps, "trim") === "roll");
  check("trim tool: near an edge ripples", E.pointerMode(tl, "b", 6, 0.5, pps, "trim") === "ripple-start" && E.pointerMode(tl, "c", 245, 0.5, pps, "trim") === "ripple-end");
  check("trim tool: name band slides, the rest slips", E.pointerMode(tl, "b", 75, 0.1, pps, "trim") === "slide" && E.pointerMode(tl, "b", 75, 0.7, pps, "trim") === "slip");
  check("blade tool blades", E.pointerMode(tl, "b", 75, 0.5, pps, "blade") === "blade");
}

/* ---------- placing media ---------- */
{
  const tl = seq();
  const src: E.Source = { mediaId: "a", name: "A", kind: "video", in: 5, out: 7, withAudio: true };
  const ow = E.overwriteEdit(tl, src, 3, { video: "V1", audio: "A2" });
  check("overwrite replaces over its length", on(ow.tl, "V1").includes("b@5+2") && ow.ids.length === 2);
  check("overwrite links picture and sound", get(ow.tl, ow.ids[0]).linkId === get(ow.tl, ow.ids[1]).linkId);
  check("overwrite cuts the clip underneath on the audio track", on(ow.tl, "A2") === "x@2+1 " + `${ow.ids[1]}@3+2` + " x@5+1".replace("x@5", E.clipsOn(ow.tl, "A2")[2]?.id + "@5"));
  const ins = E.insertEdit(tl, src, 4, { video: "V1" });
  check("insert pushes later clips on every unlocked track", on(ins.tl, "V1") === `a@0+4 ${ins.ids[0]}@4+2 b@6+3 c@9+5` && E.clipsOn(ins.tl, "A2").some((c) => near(c.start, 6)));
  check("insert never moves locked tracks", lockedSame(tl, ins.tl));
  const rep = E.replaceEdit(tl, "b", { ...src, mediaId: "b", in: 1 }, ctx);
  check("replace keeps place and length, swaps the source", near(get(rep, "b").start, 4) && near(get(rep, "b").duration, 3) && get(rep, "b").mediaId === "b" && near(get(rep, "b").sourceIn, 1));
  const top = E.placeOnTop(tl, { ...src, withAudio: false }, 0, { video: "V1" });
  check("place on top uses the next free track up", get(top.tl, top.ids[0]).trackId === "V2");
  const top2 = E.placeOnTop(top.tl, { ...src, withAudio: false }, 0, { video: "V1" });
  check("place on top adds a track when none is free", top2.tl.tracks.filter((t) => t.kind === "video").length === 4);
  const fit = E.fitToFill(tl, { ...src, withAudio: false }, 20, 24, { video: "V1" });
  check("fit to fill changes the speed", near(get(fit.tl, fit.ids[0]).speed, 0.5) && near(get(fit.tl, fit.ids[0]).duration, 4));
  const app = E.appendEdit(tl, { ...src, withAudio: false }, { video: "V1" });
  check("append goes after the last clip", near(get(app.tl, app.ids[0]).start, 12));
  check("edits into a locked target do nothing", E.overwriteEdit(tl, { ...src, withAudio: false }, 0, { video: "L" }).ids.length === 0);
}

/* ---------- three- and four-point marks ---------- */
{
  check("three-point: source in/out + playhead", JSON.stringify(E.resolveMarks({ srcIn: 2, srcOut: 5 }, 30, 10)) === JSON.stringify({ in: 2, out: 5, at: 10 }));
  check("three-point: source in + timeline in/out", JSON.stringify(E.resolveMarks({ srcIn: 2, tlIn: 10, tlOut: 14 }, 30, 0)) === JSON.stringify({ in: 2, out: 6, at: 10 }));
  check("three-point: backtimed from the timeline out", JSON.stringify(E.resolveMarks({ srcIn: 2, srcOut: 5, tlOut: 20 }, 30, 0)) === JSON.stringify({ in: 2, out: 5, at: 17 }));
  check("three-point: source out + timeline range backtimes the source", JSON.stringify(E.resolveMarks({ srcOut: 9, tlIn: 1, tlOut: 4 }, 30, 0)) === JSON.stringify({ in: 6, out: 9, at: 1 }));
  check("four-point with different lengths asks for fit to fill", E.resolveMarks({ srcIn: 0, srcOut: 4, tlIn: 1, tlOut: 3 }, 30, 0).fitTo === 3);
  check("no marks: whole source at the playhead", JSON.stringify(E.resolveMarks({}, 8, 2)) === JSON.stringify({ in: 0, out: 8, at: 2 }));
}

/* ---------- ranges, joins, markers ---------- */
{
  const tl = seq();
  const lift = E.liftRange(tl, 3, 8);
  check("lift clears the range and leaves a gap", on(lift, "V1") === "a@0+3 c@8+4");
  check("lift never touches locked tracks", lockedSame(tl, lift));
  check("extract closes the gap", on(E.extractRange(tl, 3, 8), "V1") === "a@0+3 c@3+4");
  const bl = E.blade(tl, 2, ["b"]); // nothing under 2 on b
  check("blade outside a clip does nothing", bl === tl);
  const cut = E.blade(tl, 5.5, ["b"]);
  const [b1, b2] = E.clipsOn(cut, "V1").filter((c) => c.start >= 4 && c.start < 7);
  check("join through edit rejoins a cut", on(E.joinThroughEdit(cut, b1.id, b2.id), "V1") === on(tl, "V1"));
  check("join refuses different sources", E.joinThroughEdit(tl, "a", "b") === tl);
  let m = E.addMarker(tl, 5, { name: "chorus", color: "#ff0" }).tl;
  m = E.addMarker(m, 2).tl;
  check("markers stay in time order", m.markers.map((x) => x.time).join() === "2,5");
  check("next and previous marker", E.nearMarker(m, 3, 1)?.time === 5 && E.nearMarker(m, 3, -1)?.time === 2 && !E.nearMarker(m, 6, 1));
  check("clip markers are not ruler stops", !E.nearMarker(E.addMarker(tl, 4, { clipId: "b" }).tl, 0, 1));
  check("in/out range keeps in before out", (() => {
    const r = E.setRange(tl, 9, 3);
    return r.inPoint === 3 && r.outPoint === 9;
  })());
  check("clearing the range", E.setRange(E.setRange(tl, 1, 2), null, null).inPoint === undefined);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
