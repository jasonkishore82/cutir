// Phase 30: benchmarks on reference projects. Each case prints its time; a case fails only when it is far over its
// budget, so slow CI machines do not flap but a real regression (an accidental quadratic loop) does. Budgets are for
// logic that runs on the page while editing: project diffs, snapshots, interchange, the document save.
import { viewToDoc } from "../src/model/convert";
import { defaultProject } from "../src/store/project";
import type { Clip, ProjectDoc, Timeline } from "../src/model/types";
import * as E from "../src/timeline/engine";
import { toEditList } from "../src/lib/interchange/common";
import { exportOtio, parseOtio } from "../src/lib/interchange/otio";
import { exportEdl } from "../src/lib/interchange/edl";
import { diffDocs, snapshotOf } from "../src/lib/versions";
import { checksum } from "../src/lib/storage/recovery";
import { diff } from "../src/model/ops";
import { createGovernor } from "../src/lib/system/governor";

let fails = 0;

/** Reference projects: a short film (400 clips on 6 tracks) and a heavy one (3000 clips on 12 tracks). */
function reference(clips: number, tracks: number): ProjectDoc {
  const doc = viewToDoc(defaultProject());
  doc.media = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: `shot-${i}.mp4`, kind: "video" as const, fileKey: "", duration: 600 }));
  let tl: Timeline = doc.timelines[0];
  const ids: string[] = [];
  for (let i = 0; i < tracks; i++) {
    const r = E.addTrack(tl, i % 3 === 2 ? "audio" : "video");
    tl = r.tl;
    ids.push(r.id);
  }
  const per = Math.ceil(clips / tracks);
  const list: Clip[] = [];
  for (let n = 0; n < clips; n++) {
    const t = n % tracks;
    list.push({ id: `c${n}`, trackId: ids[t], mediaId: `m${n % 20}`, start: Math.floor(n / tracks) * 3, duration: 2.5, sourceIn: 5, sourceOut: 7.5, speed: n % 7 === 0 ? 1.5 : 1, enabled: true, effects: n % 5 === 0 ? [{ id: `e${n}`, type: "blur", enabled: true, params: { amount: 4 } } as never] : [], keyframes: {} });
  }
  void per;
  doc.timelines = [{ ...tl, clips: list }, ...doc.timelines.slice(1)];
  doc.activeTimelineId = tl.id;
  return doc;
}

function bench(name: string, budgetMs: number, fn: () => unknown) {
  fn(); // warm up
  const runs = 5;
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(runs / 2)];
  const pass = med <= budgetMs;
  if (!pass) fails++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}: ${med.toFixed(1)} ms (budget ${budgetMs} ms)`);
}

for (const [label, clips, tracks, scale] of [["film", 400, 6, 1], ["heavy", 3000, 12, 6]] as const) {
  const doc = reference(clips, tracks);
  const tl = doc.timelines[0];
  const edited = { ...doc, timelines: [{ ...tl, clips: tl.clips.map((c, i) => (i % 50 === 0 ? { ...c, start: c.start + 1 } : c)) }, ...doc.timelines.slice(1)] };
  const json = JSON.stringify(doc);
  console.log(`-- ${label}: ${clips} clips, ${tracks} tracks, ${(json.length / 1e6).toFixed(1)} MB of project data`);
  bench(`${label}: serialize the document`, 40 * scale, () => JSON.stringify(doc));
  bench(`${label}: checksum for the autosave`, 60 * scale, () => checksum(json));
  bench(`${label}: patch diff after an edit`, 120 * scale, () => diff(doc, edited));
  bench(`${label}: version snapshot`, 40 * scale, () => snapshotOf(doc, "auto"));
  bench(`${label}: compare two versions`, 150 * scale, () => diffDocs(doc, edited));
  bench(`${label}: edit list for interchange`, 100 * scale, () => toEditList(doc, doc.timelines[0], 30));
  const { list } = toEditList(doc, doc.timelines[0], 30);
  bench(`${label}: export OTIO`, 200 * scale, () => JSON.stringify(exportOtio(list).json));
  bench(`${label}: export EDL`, 200 * scale, () => exportEdl(list));
  const otio = JSON.stringify(exportOtio(list).json);
  bench(`${label}: import OTIO`, 300 * scale, () => parseOtio(otio, 30));
}

bench("quality governor: 10000 samples", 20, () => {
  const g = createGovernor();
  for (let i = 0; i < 10000; i++) g.sample({ fps: 20 + (i % 15), target: 30, playing: true });
});

console.log(fails ? `\n${fails} benchmarks over budget` : "\nall checks passed");
process.exit(fails ? 1 : 0);
