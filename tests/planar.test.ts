// Phase 22 rest: planar tracking, rotation and scale from a tracker, tracking through a matcher (worker stand-in).
import { applyHomography, applySimilarity, fitHomography, fitMotion, fitSimilarity, invert3, localMotion, PlanarTracker, type Mat3, type Pt } from "../src/lib/track/planar";
import { TrackSession, unwrapAngle } from "../src/lib/track/session";
import { followFrames, inlineMatcher, type Matcher } from "../src/lib/track/matcher";
import { hasMotion, rotationZoom, stabiliseRotation, trackerMotion, type Gray, type Tracker } from "../src/lib/track/tracker";
import { transformOf } from "../src/render/compositor";
import type { Clip, Timeline } from "../src/model/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

/* ---------- the maths ---------- */
const grid: Pt[] = [[0, 0], [10, 0], [20, 0], [0, 10], [10, 10], [20, 10], [0, 20], [10, 20], [20, 20]];
const sim = { s: 1.3, rot: 25, tx: 7, ty: -3 };
const moved = grid.map((p) => applySimilarity(sim, p));
const fs = fitSimilarity(grid, moved)!;
check("a similarity is recovered exactly", near(fs.s, 1.3) && near(fs.rot, 25, 1e-6) && near(fs.tx, 7) && near(fs.ty, -3), fs);
check("two points are enough for a similarity", !!fitSimilarity([[0, 0], [10, 0]], [[1, 1], [1, 11]]) && near(fitSimilarity([[0, 0], [10, 0]], [[1, 1], [1, 11]])!.rot, 90, 1e-6));
check("identical points give no similarity", fitSimilarity([[1, 1], [1, 1]], [[2, 2], [3, 3]]) === null);

const H: Mat3 = [1.1, 0.12, 5, -0.08, 0.95, 2, 0.0006, 0.0002, 1];
const hp = grid.map((p) => applyHomography(H, p));
const fh = fitHomography(grid, hp)!;
check("a homography is recovered from nine points", fh.every((v, i) => near(v, H[i], 1e-6)), fh);
check("four points are enough for a homography", (() => { const idx = [0, 2, 6, 8]; const f = fitHomography(idx.map((i) => grid[i]), idx.map((i) => hp[i]))!; return grid.every((p, i) => Math.hypot(...(applyHomography(f, p).map((v, k) => v - hp[i][k]) as [number, number])) < 1e-6); })());
check("three points are not enough for a homography", fitHomography(grid.slice(0, 3), hp.slice(0, 3)) === null);
const inv = invert3(H)!;
check("a homography inverts", (() => { const p = applyHomography(inv, applyHomography(H, [12, 7])); return near(p[0], 12, 1e-8) && near(p[1], 7, 1e-8); })());
const lm = localMotion([Math.cos(0.3) * 1.2, -Math.sin(0.3) * 1.2, 4, Math.sin(0.3) * 1.2, Math.cos(0.3) * 1.2, 1, 0, 0, 1], [10, 10]);
check("local rotation and scale of a similarity are read back", near(lm.rot, (0.3 * 180) / Math.PI, 1e-4) && near(lm.scale, 1.2, 1e-4), lm);

// outliers: one point is far off
const noisy = moved.map((p, i) => (i === 4 ? ([p[0] + 40, p[1] - 30] as Pt) : p));
const fit = fitMotion(grid, noisy, [10, 10])!;
check("an outlier is thrown out and the fit is still right", !fit.inliers[4] && fit.inliers.filter(Boolean).length === 8 && near(fit.scale, 1.3, 0.02) && near(fit.rot, 25, 0.5), { rot: fit.rot, scale: fit.scale, inl: fit.inliers });
check("with three points a similarity is used", fitMotion(grid.slice(0, 3), moved.slice(0, 3), [5, 5])!.kind === "similarity" && fitMotion(grid, moved, [10, 10])!.kind === "homography");
check("fewer than two points cannot be fitted", fitMotion([[0, 0]], [[1, 1]], [0, 0]) === null);

/* ---------- following a textured surface ---------- */
const W = 200, H2 = 150;
const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const lattice = 5;
const tex = (x: number, y: number) => {
  const gx = x / lattice, gy = y / lattice;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return 40 + 175 * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
};
const C: Pt = [100, 75];
/** The frame after the surface moved by (dx, dy), turned by deg and grew by s about the region's centre. */
function frame(dx: number, dy: number, deg: number, s: number): Gray {
  const r = (deg * Math.PI) / 180;
  const cs = Math.cos(r), sn = Math.sin(r);
  const data = new Uint8Array(W * H2);
  for (let v = 0; v < H2; v++) {
    for (let u = 0; u < W; u++) {
      const qx = u - C[0] - dx, qy = v - C[1] - dy;
      // inverse of p -> s R p
      const px = (cs * qx + sn * qy) / s + C[0];
      const py = (-sn * qx + cs * qy) / s + C[1];
      data[v * W + u] = tex(px, py);
    }
  }
  return { w: W, h: H2, data };
}
const region = { x: 60, y: 45, w: 80, h: 60 };
const path = [[0, 0, 0, 1], [2, 1, 2, 1.01], [4, 2, 4, 1.02], [6, 2.5, 6, 1.03], [8, 3, 8, 1.05], [10, 4, 10, 1.06], [12, 5, 12, 1.08]] as const;

const pt = new PlanarTracker(frame(0, 0, 0, 1), region, { grid: 3 });
let worst = { pos: 0, rot: 0, scale: 0 };
let lastModel = "";
for (const [dx, dy, deg, s] of path.slice(1)) {
  const r = pt.next(frame(dx, dy, deg, s));
  if (!r) { worst = { pos: 99, rot: 99, scale: 99 }; break; }
  lastModel = r.model;
  worst = { pos: Math.max(worst.pos, Math.hypot(r.x - (C[0] + dx), r.y - (C[1] + dy))), rot: Math.max(worst.rot, Math.abs(r.rot - deg)), scale: Math.max(worst.scale, Math.abs(r.scale - s)) };
}
check(`the surface is followed: centre within ${worst.pos.toFixed(2)} px`, worst.pos < 1.2, worst);
check(`rotation within ${worst.rot.toFixed(2)} degrees`, worst.rot < 1.5, worst);
check(`scale within ${(worst.scale * 100).toFixed(1)}%`, worst.scale < 0.03, worst);
check("a homography is the model once enough points are alive", lastModel === "homography", lastModel);

// a hand covering part of the surface: the points under it are dropped and the rest still track
const covered = frame(3, 1, 3, 1.02);
for (let v = 45; v < 75; v++) for (let u = 60; u < 95; u++) covered.data[v * W + u] = 20;
const pc = new PlanarTracker(frame(0, 0, 0, 1), region, { grid: 4 });
const rc = pc.next(covered);
check("with part of the surface covered the rest is still followed", !!rc && Math.hypot(rc.x - (C[0] + 3), rc.y - (C[1] + 1)) < 3 && Math.abs(rc.rot - 3) < 3, rc);
check("some points were dropped", pc.points.filter((p) => !p.alive).length > 0);

// losing the surface entirely
const lost = new PlanarTracker(frame(0, 0, 0, 1), region, { grid: 3 });
const blank: Gray = { w: W, h: H2, data: new Uint8Array(W * H2).fill(128) };
check("a blank frame loses it", lost.next(blank) === null);

/* ---------- sessions and the matcher ---------- */
const sPoint = new TrackSession(frame(0, 0, 0, 1), { mode: "point", x: 100, y: 75 });
const stepP = sPoint.next(frame(4, 2, 0, 1));
check("a point session follows a point", !!stepP && near(stepP.x, 104, 0.6) && near(stepP.y, 77, 0.6) && stepP.rot === undefined, stepP);
const sPlan = new TrackSession(frame(0, 0, 0, 1), { mode: "planar", region });
check("a planar session reports its start and a first sample with rotation and scale", sPlan.start.x === 100 && sPlan.start.y === 75 && sPlan.first().rot === 0 && sPlan.first().scale === 1);
let lastRot = 0;
const sSpin = new TrackSession(frame(0, 0, 0, 1), { mode: "planar", region });
for (const deg of [4, 8, 12, 16, 20]) lastRot = sSpin.next(frame(0, 0, deg, 1))?.rot ?? NaN;
check("a steady turn is followed", near(lastRot, 20, 2), lastRot);
check("angles are kept continuous across the half turn", unwrapAngle(170, -175) === 185 && unwrapAngle(-170, 175) === -185 && unwrapAngle(10, 20) === 20 && unwrapAngle(350, 5) === 365);

const seq = path.map(([dx, dy, deg, s]) => frame(dx, dy, deg, s));
const order: string[] = [];
const traced: Matcher = (() => {
  const m = inlineMatcher();
  return { ...m, start: async (...a) => (order.push("start"), m.start(...a)), frame: async (g) => (order.push("frame"), m.frame(g)) };
})();
const drawn: number[] = [];
const run = await followFrames(traced, seq.length, async (i) => (drawn.push(i), seq[i]), () => ({ mode: "planar", region }));
check("every frame is followed, in order", run.steps.length === seq.length && order[0] === "start" && order.filter((o) => o === "frame").length === seq.length - 1 && drawn.join() === "0,1,2,3,4,5,6", { steps: run.steps.length, order });
check("the first step is the start and later steps move", run.steps[0].x === 100 && run.steps[6].x > run.steps[1].x);
const lostRun = await followFrames(inlineMatcher(), 5, async (i) => (i < 3 ? seq[i] : blank), () => ({ mode: "planar", region }));
check("a lost surface stops the run and says where", lostRun.lostAt === 3 && lostRun.steps.length === 3, lostRun);
const ctl = new AbortController();
const cancelled = await followFrames(inlineMatcher(), 7, async (i) => (i === 2 && ctl.abort(), seq[i]), () => ({ mode: "planar", region }), { signal: ctl.signal });
check("cancelling stops after the frame in flight", cancelled.cancelled === true && cancelled.steps.length >= 2 && cancelled.steps.length < 7, cancelled.steps.length);
const noFrame = await followFrames(inlineMatcher(), 5, async (i) => (i < 2 ? seq[i] : null), () => ({ mode: "planar", region }));
check("a frame that cannot be made ends the run", noFrame.frameError === true && noFrame.steps.length === 2);
check("no first frame is an error", (await followFrames(inlineMatcher(), 3, async () => null, () => ({ mode: "point", x: 1, y: 1 }))).frameError === true);

/* ---------- reading rotation and scale ---------- */
const tr: Tracker = { id: "t", name: "t", x: 0.5, y: 0.5, t0: 0, kind: "planar", samples: [0, 1, 2, 3, 4].map((t) => ({ t, x: 0.5 + t * 0.01, y: 0.5, c: 1, rot: t * 5 + (t % 2 ? 2 : -2), scale: 1 + t * 0.1 })) };
check("a planar tracker has motion, a point tracker does not", hasMotion(tr) && !hasMotion({ ...tr, samples: tr.samples.map(({ rot: _r, scale: _s, ...s }) => s) }));
const m2 = trackerMotion(tr, 2);
check("motion at a time is relative to the start", near(m2.rot, 10, 1e-9), m2);
check("scale is relative to the start", near(trackerMotion(tr, 4).scale, 1.4, 1e-9) && near(trackerMotion(tr, 0).scale, 1));
check("motion between samples is interpolated", near(trackerMotion(tr, 0.5).rot, ((-2 + 7) / 2) - -2, 1e-9));
const sr = stabiliseRotation(tr, 1, 4);
check("stabilising turns the picture against the shake", Math.abs(sr) > 0 && near(stabiliseRotation(tr, 1, 0), 0, 1e-9));
check("a point tracker needs no turning", stabiliseRotation({ ...tr, samples: tr.samples.map(({ rot: _r, ...s }) => s) }, 1, 1) === 0);
check("turning needs a zoom, more for more turn", rotationZoom(tr, 4) > rotationZoom({ ...tr, samples: tr.samples.map((s) => ({ ...s, rot: (s.rot ?? 0) * 0.2 })) }, 4) && rotationZoom({ ...tr, samples: tr.samples.map((s) => ({ ...s, rot: 0 })) }, 1) === 1);

/* ---------- pinned clips turn and grow with the surface ---------- */
const clip = (id: string, extra: Partial<Clip> = {}): Clip => ({ id, trackId: "v1", start: 0, duration: 10, sourceIn: 0, sourceOut: 10, speed: 1, enabled: true, effects: [], keyframes: {}, ...extra });
const tracker: Tracker = { id: "k", name: "k", x: 0.5, y: 0.5, t0: 0, kind: "planar", samples: [{ t: 0, x: 0.5, y: 0.5, c: 1, rot: 0, scale: 1 }, { t: 1, x: 0.5, y: 0.5, c: 1, rot: 90, scale: 2 }] };
const host = clip("host", { trackers: [tracker] });
const title = (follow: Clip["follow"]) => clip("title", { follow, transform: { x: 0.6, y: 0.5 } });
const tlx = (c: Clip): Timeline => ({ id: "t", name: "t", tracks: [], clips: [host, c], markers: [] } as unknown as Timeline);
const plain = transformOf(title({ clipId: "host", trackerId: "k" }), 1, tlx(title({ clipId: "host", trackerId: "k" })), 1);
check("without turn or size a pinned clip only moves with the point", near(plain.x, 0.6) && near(plain.rotation, 0) && near(plain.scale, 1), plain);
const f2 = title({ clipId: "host", trackerId: "k", rotate: true, scale: true });
const turned = transformOf(f2, 1, tlx(f2), 1);
check("turning 90 degrees and doubling carries a clip beside the point round and out", near(turned.x, 0.5, 1e-9) && near(turned.y, 0.7, 1e-9) && near(turned.rotation, 90) && near(turned.scale, 2), turned);
const f3 = title({ clipId: "host", trackerId: "k", rotate: true });
const onlyTurn = transformOf(f3, 1, tlx(f3), 1);
check("turning alone keeps the distance", near(Math.hypot(onlyTurn.x - 0.5, onlyTurn.y - 0.5), 0.1, 1e-9) && near(onlyTurn.scale, 1));
const half = transformOf(f2, 0.5, tlx(f2), 1);
check("halfway it is halfway turned", near(half.rotation, 45) && near(half.scale, 1.5), half);
const stabClip = clip("s", { trackers: [{ ...tracker, samples: [0, 1, 2, 3].map((t) => ({ t, x: 0.5, y: 0.5, c: 1, rot: t % 2 ? 6 : -6, scale: 1 })) }], stabilize: { trackerId: "k", smoothing: 0, zoom: 0, rotation: true } });
const st = transformOf(stabClip, 1, tlx(stabClip), 16 / 9);
const st0 = transformOf({ ...stabClip, stabilize: { ...stabClip.stabilize!, rotation: false } }, 1, tlx(stabClip), 16 / 9);
check("stabilising with rotation counter-turns and zooms; without it the clip is not turned", near(st0.rotation, 0) && st.scale >= st0.scale && (stabClip.stabilize!.smoothing === 0 ? true : Math.abs(st.rotation) > 0));

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
