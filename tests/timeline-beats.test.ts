// Phase 16.5: beats on the timeline (snapping, next/previous marker, ruler tick thinning) in src/timeline/engine.ts.
import * as E from "../src/timeline/engine";
import type { Marker, Timeline } from "../src/model/types";
import { DEFAULT_STYLE } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 500)}`}`);
}
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-6;

/** 120 bpm in 4/4: a beat every 0.5 s from 1.0, a downbeat every 2 s. */
const beatMarkers = (n: number): Marker[] =>
  Array.from({ length: n }, (_, i) => ({ id: `b${i}`, time: 1 + i * 0.5, name: "", color: "#888", kind: "beat" as const, downbeat: i % 4 === 0, strength: 0.5 }));
const tl = (markers: Marker[]): Timeline => ({ id: "t", name: "t", tracks: [], clips: [], markers, textStyle: DEFAULT_STYLE, transition: { type: "none", ms: 400 } });
const user = (id: string, time: number): Marker => ({ id, time, name: id, color: "#5b9dff" });

/* ---------- snapToBeat ---------- */
{
  const beats = [{ time: 1 }, { time: 1.5 }, { time: 2, downbeat: true }, { time: 2.5 }];
  check("snaps to the nearest beat within tolerance", near(E.snapToBeat(beats, 1.58, 0.1), 1.5));
  check("leaves the time alone outside tolerance", near(E.snapToBeat(beats, 1.75, 0.1), 1.75));
  check("tolerance is inclusive", near(E.snapToBeat(beats, 1.6, 0.1), 1.5));
  check("before the first beat", near(E.snapToBeat(beats, 0.95, 0.1), 1) && near(E.snapToBeat(beats, 0.5, 0.1), 0.5));
  check("after the last beat", near(E.snapToBeat(beats, 2.56, 0.1), 2.5) && near(E.snapToBeat(beats, 4, 0.1), 4));
  check("exactly on a beat", near(E.snapToBeat(beats, 2, 0.1), 2));
  check("no beats", near(E.snapToBeat([], 3.3, 1), 3.3));
  check("a downbeat wins a tie", near(E.snapToBeat(beats, 1.75, 0.3), 2));
  const many = Array.from({ length: 2000 }, (_, i) => ({ time: i * 0.25 }));
  const t0 = performance.now();
  let ok = true;
  for (let k = 0; k < 20000; k++) {
    const t = (k * 0.0371) % 499;
    const want = Math.round(t / 0.25) * 0.25;
    const got = E.snapToBeat(many, t, 0.2);
    if (Math.abs(Math.abs(got - t) - Math.abs(want - t)) > 1e-9 || !Number.isInteger(got * 4)) ok = false;
  }
  check("binary search agrees with rounding on a long song", ok);
  check("20k lookups on 2000 beats are fast", performance.now() - t0 < 200, performance.now() - t0);
}

/* ---------- windows ---------- */
{
  const b = beatMarkers(10).map((m) => ({ time: m.time }));
  check("lowerBound", E.lowerBound(b, 0) === 0 && E.lowerBound(b, 1.25) === 1 && E.lowerBound(b, 1.5) === 1 && E.lowerBound(b, 99) === 10);
  check("inWindow keeps both ends", E.inWindow(b, 1.5, 2.5).map((x) => x.time).join() === "1.5,2,2.5");
}

/* ---------- snapping includes beats only with the beat toggle ---------- */
{
  const t = tl([...beatMarkers(8), user("u", 7.3)]);
  const off = E.snapPoints(t, {});
  const on = E.snapPoints(t, { beats: true });
  check("beats are not snap points by default", !off.includes(1.5) && off.includes(7.3));
  check("beats are snap points with beats: true", on.includes(1.5) && on.includes(4.5) && on.includes(7.3));
  check("the marker toggle leaves beats alone", !E.snapPoints(t, { markers: true }).includes(1.5) && E.snapPoints(t, { markers: false, beats: true }).includes(1.5) && !E.snapPoints(t, { markers: false, beats: true }).includes(7.3));
  check("a clip edge snaps to a beat", near(E.snapDelta([0.2], 1.25, on, 0.1).dt, 1.3));
  const ranged = E.snapPoints(tl(beatMarkers(500)), { beats: true }, [], [100, 110]);
  check("in view only (with slack)", ranged.includes(100) && ranged.includes(110) && !ranged.includes(50) && !ranged.includes(200), ranged.length);
  // 2.75 is halfway between the beat at 2.5 and the downbeat at 3
  const tie = E.snapTime(2.75, E.snapPoints(tl(beatMarkers(8)), { beats: true, edges: false }), 0.3);
  check("downbeats come first, so they win equal-distance snaps", near(tie.t, 3), tie);
}

/* ---------- next / previous marker skip beats ---------- */
{
  const t = tl([...beatMarkers(20), user("a", 2.2), user("b", 6.7)]);
  check("next marker skips beats", E.nearMarker(t, 0, 1)?.id === "a" && E.nearMarker(t, 2.2, 1)?.id === "b");
  check("previous marker skips beats", E.nearMarker(t, 6, -1)?.id === "a" && !E.nearMarker(t, 2, -1));
  check("no user markers: no stop", !E.nearMarker(tl(beatMarkers(20)), 0, 1));
  check("userMarkers lists only user markers", E.userMarkers(t).map((m) => m.id).join() === "a,b");
}

/* ---------- ruler tick thinning ---------- */
{
  const beats = beatMarkers(400).map((m) => ({ time: m.time, downbeat: !!m.downbeat }));
  const spacing = (list: { time: number }[], pps: number) => Math.min(...list.slice(1).map((b, i) => (b.time - list[i].time) * pps));
  check("zoomed in: every beat", E.thinBeats(beats, 80).length === 400);
  const mid = E.thinBeats(beats, 4); // beats 2 px apart, bars 8 px apart
  check("zoomed out: downbeats only", mid.length === 100 && mid.every((b) => b.downbeat));
  const far = E.thinBeats(beats, 1); // bars 2 px apart
  check("far out: every other bar, still downbeats", far.every((b) => b.downbeat) && spacing(far, 1) >= 4 && far.length === 50);
  for (const pps of [0.3, 1, 2, 3, 5, 8, 20, 300]) check(`ticks never closer than 4 px at ${pps} px/s`, spacing(E.thinBeats(beats, pps), pps) >= 4 - 1e-9, spacing(E.thinBeats(beats, pps), pps));
  const noDown = beats.map((b) => ({ ...b, downbeat: false }));
  check("no downbeats: every n-th beat", spacing(E.thinBeats(noDown, 2), 2) >= 4);
  check("tiny lists pass through", E.thinBeats(beats.slice(0, 1), 1).length === 1);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
