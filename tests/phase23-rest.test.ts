// Phase 23, the rest: optical flow slow motion, live sound inside nested clips, reframing from a tracker, ramp curve, nested markers.
import { viewToDoc, activeTimeline } from "../src/model/convert";
import { defaultProject } from "../src/store/project";
import * as E from "../src/timeline/engine";
import { makeCompound, nestedMarkers, pictureFraction, reframeTimeline, reframeX, coverRatio } from "../src/timeline/compound";
import { estimateFlow, flowActivity, flowDraws, interpolateGray } from "../src/lib/flow";
import { withNestedSound } from "../src/lib/audio/nested";
import { audible, soundTrackOf, activeAudio } from "../src/render/audio";
import { rampCurve, speedAt } from "../src/lib/retime";
import type { Clip, ProjectDoc } from "../src/model/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const clip = (o: Partial<Clip> & { id: string; trackId: string }): Clip => ({ start: 0, duration: 4, sourceIn: 0, sourceOut: 4, speed: 1, enabled: true, effects: [], keyframes: {}, ...o });

/* ---------- optical flow ---------- */
// a textured picture (bumps that are all different) moved by a known amount
const W = 96;
const H = 64;
const texture = (x: number, y: number) => 128 + 60 * Math.sin(x * 0.31 + Math.sin(y * 0.17) * 2) * Math.cos(y * 0.23 + x * 0.05) + 40 * Math.sin((x + 2 * y) * 0.11);
const frame = (dx: number, dy: number) => {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = texture(x - dx, y - dy);
  return g;
};
{
  const a = frame(0, 0);
  const b = frame(3, 2);
  const f = estimateFlow(a, b, W, H, { block: 8, range: 6 });
  let good = 0;
  let total = 0;
  for (let r = 1; r < f.rows - 1; r++)
    for (let c = 1; c < f.cols - 1; c++) {
      total++;
      if (near(f.dx[r * f.cols + c], 3, 0.6) && near(f.dy[r * f.cols + c], 2, 0.6)) good++;
    }
  check("block motion finds a known shift", good / total > 0.9, { good, total });
  check("a moving picture counts as active", flowActivity(f) > 0.5);
  check("a still picture has no motion", flowActivity(estimateFlow(a, a, W, H)) === 0);

  // halfway between: closer to the true halfway frame than a plain blend is
  const truth = frame(1.5, 1);
  const mid = interpolateGray(a, b, f, 0.5);
  const blend = Float32Array.from(a, (v, i) => v * 0.5 + b[i] * 0.5);
  const err = (p: ArrayLike<number>) => {
    let s = 0;
    let n = 0;
    for (let y = 8; y < H - 8; y++) for (let x = 8; x < W - 8; x++) (s += Math.abs(p[y * W + x] - truth[y * W + x])), n++;
    return s / n;
  };
  check("flow halfway beats a plain blend", err(mid) < err(blend) * 0.6, { flow: err(mid), blend: err(blend) });
  const e0 = interpolateGray(a, b, f, 0);
  let d0 = 0;
  for (let y = 8; y < H - 8; y++) for (let x = 8; x < W - 8; x++) d0 += Math.abs(e0[y * W + x] - a[y * W + x]);
  check("at 0 the frame is A", d0 / (W * H) < 1, d0 / (W * H));

  const draws = flowDraws(f, 0.5, 192, 128);
  check("draw blocks tile the output", draws.length === f.cols * f.rows && near(draws[0].x, 0) && near(draws[0].y, 0));
  const i = f.cols + 1;
  const inner = draws[i];
  const vx = f.dx[i] * 2; // the output is twice the analysed picture
  check("a block reads A back and B forward by its vector", near(inner.x - inner.ax, 0.5 * vx, 1e-6) && near(inner.bx - inner.x, 0.5 * vx, 1e-6), [inner, vx]);

  const flat = new Float32Array(W * H).fill(90);
  check("flat pictures have no motion", flowActivity(estimateFlow(flat, flat, W, H)) === 0);
  const noise = new Float32Array(W * H);
  const noise2 = new Float32Array(W * H);
  for (let k = 0; k < noise.length; k++) (noise[k] = (k * 7919) % 255), (noise2[k] = (k * 104729 + 13) % 255);
  check("noise stays within the search range", estimateFlow(noise, noise2, W, H).dx.every((v) => Math.abs(v) <= 8.5));
}

/* ---------- sound inside nested clips, live ---------- */
function nestedDoc() {
  let doc = viewToDoc(defaultProject());
  let tl = activeTimeline(doc);
  const v1 = E.addTrack(tl, "video");
  tl = v1.tl;
  let a1 = tl.tracks.find((t) => t.kind === "audio")?.id;
  if (!a1) {
    const r = E.addTrack(tl, "audio");
    tl = r.tl;
    a1 = r.id;
  }
  doc = { ...doc, timelines: doc.timelines.map((t) => (t.id === tl.id ? tl : t)), media: [{ id: "m1", name: "a.mp4", kind: "video", fileKey: "a", poolId: "1", duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }, { id: "m3", name: "rec.wav", kind: "audio", fileKey: "c", poolId: "3", duration: 120 }] };
  return { doc, v1: v1.id, a1 };
}
{
  const { doc, v1, a1 } = nestedDoc();
  const base = E.onActive(doc, (t) => ({ ...t, clips: [clip({ id: "v", trackId: v1, mediaId: "m1", start: 0, duration: 6, sourceIn: 5, sourceOut: 11 }), clip({ id: "s", trackId: a1, mediaId: "m3", start: 2, duration: 8, sourceIn: 20, sourceOut: 28, volume: 0.5 })] }));
  const made = makeCompound(base, ["v", "s"])!;
  const host = activeTimeline(made.doc);
  const nestClip = host.clips.find((c) => c.timelineId)!;
  const flat = withNestedSound(made.doc, host, audible, soundTrackOf);
  const stand = flat.clips.filter((c) => c.id.startsWith(nestClip.id + ">"));
  check("a nested clip's sound becomes stand-in clips on the host", stand.length === 1 && stand[0].mediaId === "m3", stand.map((c) => c.id));
  const s0 = stand[0];
  check("the stand-in keeps its volume and source range", near(s0.volume ?? 1, 0.5) && near(s0.sourceIn, 20, 1e-6) && s0.speed === 1, [s0.volume, s0.sourceIn, s0.speed]);
  check("the stand-in goes through an audio track of the host", host.tracks.find((t) => t.id === s0.trackId)?.kind === "audio");
  const at = (t: number) => activeAudio(flat, t).filter((c) => c.id.includes(">")).length;
  const mid = s0.start + s0.duration / 2;
  check("the live mixer hears it while the nested clip plays", at(mid) === 1 && at(nestClip.start + nestClip.duration + 50) === 0, [at(mid), s0]);

  // the nested clip at double speed: the sound runs at double speed and takes half the time
  const fast = E.onActive(made.doc, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === nestClip.id ? { ...c, speed: 2, duration: c.duration / 2 } : c)) }));
  const fflat = withNestedSound(fast, activeTimeline(fast), audible, soundTrackOf);
  const fs0 = fflat.clips.find((c) => c.id.startsWith(nestClip.id + ">"));
  check("a faster nested clip doubles the stand-in's speed and halves its length", !!fs0 && fs0.speed === 2 && near(fs0.duration, s0.duration / 2, 1e-6), [fs0?.speed, fs0?.duration, s0.duration]);

  const innerId = nestClip.timelineId!;
  const muted = { ...made.doc, timelines: made.doc.timelines.map((t) => (t.id === innerId ? { ...t, tracks: t.tracks.map((k) => (k.kind === "audio" ? { ...k, muted: true } : k)) } : t)) };
  check("a muted inner track stays silent", !withNestedSound(muted, activeTimeline(muted), audible, soundTrackOf).clips.some((c) => c.id.includes(">")));
  const off = E.onActive(made.doc, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === nestClip.id ? { ...c, enabled: false } : c)) }));
  check("a disabled nested clip adds nothing", !withNestedSound(off, activeTimeline(off), audible, soundTrackOf).clips.some((c) => c.id.includes(">")));
  const plain = activeTimeline(base);
  check("a timeline without nests is returned as it is", withNestedSound(base, plain, audible, soundTrackOf) === plain);
}

/* ---------- reframing knows how the clip sat in its frame ---------- */
{
  check("a full picture in its frame: the frame fraction is the picture fraction", near(pictureFraction(0.8, undefined, 16 / 9, 16 / 9), 0.8));
  check("a narrower picture: its edges are at 0.125 and 0.875 of the frame", near(pictureFraction(0.5, undefined, 4 / 3, 16 / 9), 0.5) && near(pictureFraction(0.875, undefined, 4 / 3, 16 / 9), 1, 1e-9) && near(pictureFraction(0.125, undefined, 4 / 3, 16 / 9), 0, 1e-9));
  check("a scaled-up picture is covered by fewer frame fractions", near(pictureFraction(0.75, { scale: 2 }, 16 / 9, 16 / 9), 0.625));
  check("a moved picture shifts the fraction", near(pictureFraction(0.7, { x: 0.7 }, 16 / 9, 16 / 9), 0.5));
  const { doc, v1 } = nestedDoc();
  const tracked = { id: "tk", name: "P", x: 0.6, y: 0.5, t0: 0, samples: [{ t: 0, x: 0.6, y: 0.5, c: 1 }, { t: 2, x: 0.6, y: 0.5, c: 1 }] };
  const m43 = { ...doc, media: doc.media.map((m) => (m.id === "m1" ? { ...m, width: 1440, height: 1080 } : m)) };
  const d = E.onActive(m43, (t) => ({ ...t, clips: [clip({ id: "c", trackId: v1, mediaId: "m1", duration: 2, trackers: [tracked] })] }));
  const out = reframeTimeline(d, d.activeTimelineId, "9:16")!;
  const c = activeTimeline(out).clips.find((x) => x.id === "c")!;
  const ratio = coverRatio(4 / 3, 9 / 16);
  check("a tracker point in a letterboxed picture is placed on the picture, not the frame", near(c.transform!.x as number, reframeX(0.5 + 0.1 / 0.75, ratio), 1e-6) && !near(c.transform!.x as number, reframeX(0.6, ratio), 1e-3), [c.transform?.x]);
}

/* ---------- ramp curve and nested markers ---------- */
{
  const ramp = { ease: false, keys: [{ t: 0, speed: 1 }, { t: 2, speed: 4 }] };
  const c = rampCurve(ramp, 2, 5);
  check("the ramp curve rises with the speed", c.points.length === 5 && c.points[0].y < c.points[4].y && near(c.points[4].x, 1) && c.base < 1 && c.top >= 4);
  check("the curve follows the speed at each point", near(c.points[0].y * c.top, speedAt(ramp, 0), 1e-9) && near(c.points[2].y * c.top, speedAt(ramp, 1), 1e-9));
  const f = rampCurve({ ease: false, keys: [{ t: 0, speed: 1 }, { t: 1, speed: 1 }] }, 1, 4);
  check("a flat ramp at normal speed draws on the base line", f.points.every((p) => near(p.y, f.base, 1e-9)));

  const { doc, v1 } = nestedDoc();
  const base = E.onActive(doc, (t) => ({ ...t, clips: [clip({ id: "v", trackId: v1, mediaId: "m1", start: 0, duration: 10, sourceIn: 0, sourceOut: 10 })] }));
  const made = makeCompound(base, ["v"])!;
  const nc = activeTimeline(made.doc).clips.find((x) => x.timelineId)!;
  const marked = { ...made.doc, timelines: made.doc.timelines.map((t) => (t.id === nc.timelineId ? { ...t, markers: [{ id: "a", time: 3, name: "hit", color: "#f00" }, { id: "b", time: 30, name: "far", color: "#0f0" }] } : t)) } as ProjectDoc;
  const ms = nestedMarkers(marked, nc);
  check("markers inside the window show on the nested clip", ms.length === 1 && ms[0].name === "hit" && near(ms[0].time, 3 - nc.sourceIn, 1e-6), ms);
  const sped = nestedMarkers(marked, { ...nc, speed: 2, duration: nc.duration / 2 });
  check("a faster nested clip squeezes its markers", sped.length === 1 && near(sped[0].time, (3 - nc.sourceIn) / 2, 1e-6), sped);
  check("a clip without a timeline has none", nestedMarkers(marked, clip({ id: "x", trackId: v1 })).length === 0);
}

if (fails) process.exit(1);
console.log("all passed");
