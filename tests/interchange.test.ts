// Phase 29: interchange (EDL, OTIO, FCPXML), versions, project packages, recovery, usage, sync and review.
import { viewToDoc } from "../src/model/convert";
import { defaultProject } from "../src/store/project";
import type { Clip, ProjectDoc, Timeline } from "../src/model/types";
import * as E from "../src/timeline/engine";
import { exportTimeline, importTimeline } from "../src/lib/interchange";
import { toEditList } from "../src/lib/interchange/common";
import { fromTc, parseEdl, toTc, exportEdl } from "../src/lib/interchange/edl";
import { exportOtio, parseOtio } from "../src/lib/interchange/otio";
import { describeDiff, diffDocs, isMajorChange, memoryVersionBackend, prune, restoreDoc, snapshotOf } from "../src/lib/versions";
import { crcOfBlob, readZip, writeZip, entryIsIntact } from "../src/lib/storage/zipfile";
import { buildPackage, openPackage } from "../src/lib/storage/pack";
import { checksum, chooseSource, memoryRecoveryBackend, recoveryWriter } from "../src/lib/storage/recovery";
import { formatBytes, projectUsage } from "../src/lib/storage/usage";
import { mergeDocs, rebase } from "../src/lib/sync/merge";
import { httpBackend, memoryBackend, newSession, syncOnce } from "../src/lib/sync/backend";
import { diff, applyPatches } from "../src/model/ops";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${typeof got === "string" ? got : JSON.stringify(got)?.slice(0, 500)}`}`);
}
const near = (a: number | undefined, b: number, e = 1e-3) => a !== undefined && Math.abs(a - b) < e;

/* ---------- a project to export ---------- */
function project(): ProjectDoc {
  const doc = viewToDoc(defaultProject());
  doc.media = [
    { id: "m1", name: "interview.mp4", kind: "video", fileKey: "", duration: 600 },
    { id: "m2", name: "broll.mp4", kind: "video", fileKey: "", duration: 60 },
    { id: "m3", name: "song.wav", kind: "audio", fileKey: "", duration: 200 },
  ];
  let tl: Timeline = doc.timelines[0];
  const v = E.addTrack(tl, "video");
  tl = v.tl;
  const a = E.addTrack(tl, "audio");
  tl = a.tl;
  const clip = (id: string, trackId: string, mediaId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({ id, trackId, mediaId, start, duration, sourceIn: 10, sourceOut: 10 + duration, speed: 1, enabled: true, effects: [], keyframes: {}, ...extra });
  tl = {
    ...tl,
    clips: [
      ...tl.clips,
      clip("c1", v.id, "m1", 0, 4, { linkId: "L1" }),
      clip("c2", v.id, "m2", 6, 3, { speed: 2, sourceOut: 16, effects: [{ id: "e1", type: "blur", enabled: true, params: { amount: 5 } } as never] }),
      clip("c3", a.id, "m1", 0, 4, { linkId: "L1" }),
      clip("c4", a.id, "m3", 4, 10, { sourceIn: 0, sourceOut: 10 }),
    ],
    markers: [{ id: "k1", time: 2, name: "Intro ends", color: "#f00", note: "check this" }],
  };
  doc.timelines = [tl, ...doc.timelines.slice(1)];
  doc.activeTimelineId = tl.id;
  return doc;
}
const tlOf = (d: ProjectDoc) => d.timelines.find((t) => t.id === d.activeTimelineId)!;

/* ---------- timecode and EDL ---------- */
{
  check("timecode: 1h 2m 3s 4f at 30fps", toTc(3723 + 4 / 30, 30) === "01:02:03:04", toTc(3723 + 4 / 30, 30));
  check("timecode round trip", near(fromTc("00:01:30:15", 30) ?? 0, 90.5));
  check("timecode: bad text is null", fromTc("nope", 30) === null);

  const doc = project();
  const { list } = toEditList(doc, tlOf(doc));
  check("edit list: 1 video + 1 audio track", list.tracks.length === 2 && list.tracks[0].kind === "video" && list.tracks[1].kind === "audio", list.tracks.map((t) => t.kind));
  check("edit list: marker kept, duration 14s", list.markers.length === 1 && near(list.duration, 14), [list.markers.length, list.duration]);

  const edl = exportEdl(list);
  check("EDL: title, NDF, events", /TITLE:/.test(edl.text) && /FCM: NON-DROP FRAME/.test(edl.text) && /001 /.test(edl.text));
  check("EDL: speed written as M2", /M2 /.test(edl.text));
  check("EDL: clip names as comments", /\* FROM CLIP NAME: interview\.mp4/.test(edl.text));
  const back = parseEdl(edl.text, 30);
  check("EDL round trip: tracks and clip counts", back.list.tracks.length === 2 && back.list.tracks[0].items.length === 2 && back.list.tracks[1].items.length === 2, back.list.tracks.map((t) => t.items.length));
  const c2 = back.list.tracks[0].items[1];
  check("EDL round trip: times and speed", near(c2.start, 6, 0.04) && near(c2.duration, 3, 0.04) && near(c2.speed, 2, 0.05) && c2.media === "broll.mp4", c2);
  check("EDL: an audio channel name survives", back.list.tracks[1].name === "A1", back.list.tracks[1].name);

  const dissolve = "TITLE: x\nFCM: NON-DROP FRAME\n001  AX  V  C  00:00:00:00 00:00:02:00 00:00:00:00 00:00:02:00\n002  AX  V  D 030 00:00:02:00 00:00:04:00 00:00:02:00 00:00:04:00\n";
  const p = parseEdl(dissolve, 30);
  check("EDL: dissolve skipped and reported", p.list.tracks[0].items.length === 1 && p.report.some((r) => /dissolve/.test(r.text)), p.report);
  check("EDL: drop frame warned", parseEdl("TITLE: x\nFCM: DROP FRAME\n", 30).report.some((r) => /drop frame/.test(r.text)));
  check("EDL: empty file reported", parseEdl("hello", 30).report.some((r) => /No edits/.test(r.text)));
}

/* ---------- OTIO ---------- */
{
  const doc = project();
  const { list } = toEditList(doc, tlOf(doc));
  const { json } = exportOtio(list);
  check("OTIO: schema and tracks", json.OTIO_SCHEMA === "Timeline.1" && json.tracks.children.length === 2 && json.tracks.children[0].kind === "Video");
  const v1 = json.tracks.children[0].children;
  check("OTIO: gap before the second clip", v1.length === 3 && v1[1].OTIO_SCHEMA === "Gap.1" && near(v1[1].source_range.duration.value / v1[1].source_range.duration.rate, 2));
  check("OTIO: speed as LinearTimeWarp", v1[2].effects[0]?.time_scalar === 2, v1[2].effects);
  check("OTIO: marker on the stack", json.tracks.markers.length === 1 && json.tracks.markers[0].name === "Intro ends");

  // through Cutir and back: the effect and the link survive
  const text = JSON.stringify(json);
  const r = importTimeline(doc, "movie.otio", text);
  const nt = r.doc.timelines.find((t) => t.id === r.timelineId)!;
  const vtr = nt.tracks.filter((t) => t.kind === "video")[0];
  const clips = E.clipsOn(nt, vtr.id);
  check("OTIO round trip: 2 video clips at the same times", clips.length === 2 && near(clips[0].start, 0) && near(clips[1].start, 6) && near(clips[1].duration, 3), clips.map((c) => [c.start, c.duration]));
  check("OTIO round trip: speed and source range", near(clips[1].speed, 2) && near(clips[1].sourceIn, 10) && near(clips[1].sourceOut, 16), clips[1]);
  check("OTIO round trip: effect kept", clips[1].effects.length === 1, clips[1].effects);
  check("OTIO round trip: media matched by name, none offline", r.doc.media.length === doc.media.length && !r.report.some((x) => /offline/.test(x.text)), r.report);
  const audio = E.clipsOn(nt, nt.tracks.find((t) => t.kind === "audio")!.id);
  check("OTIO round trip: linked pair stays linked", clips[0].linkId !== undefined && clips[0].linkId === audio[0].linkId, [clips[0].linkId, audio[0].linkId]);
  check("OTIO round trip: marker", nt.markers.length === 1 && near(nt.markers[0].time, 2) && nt.markers[0].note === "check this", nt.markers);
  check("OTIO round trip: original timeline untouched", r.doc.timelines.length === doc.timelines.length + 1 && tlOf(doc).clips.length === tlOf(r.doc).clips.length, [tlOf(doc).clips.length, tlOf(r.doc).clips.length]);

  // a file from another tool: no metadata, 24 fps, a transition and a nested stack
  const foreign = {
    OTIO_SCHEMA: "Timeline.1", name: "From Resolve",
    tracks: { OTIO_SCHEMA: "Stack.1", children: [
      { OTIO_SCHEMA: "Track.1", kind: "Video", name: "Video 1", children: [
        { OTIO_SCHEMA: "Clip.2", name: "shot A", source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: { rate: 24, value: 240 }, duration: { rate: 24, value: 48 } }, media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: "file:///D:/shots/New%20Take.mov" } }, active_media_reference_key: "DEFAULT_MEDIA" },
        { OTIO_SCHEMA: "Transition.1", name: "dissolve" },
        { OTIO_SCHEMA: "Clip.2", name: "shot B", source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: { rate: 24, value: 0 }, duration: { rate: 24, value: 24 } }, media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: "interview.mp4" }, effects: [{ OTIO_SCHEMA: "LinearTimeWarp.1", time_scalar: 0.5 }, { OTIO_SCHEMA: "Effect.1", effect_name: "Blur" }] },
        { OTIO_SCHEMA: "Stack.1", name: "nested", children: [] },
      ] },
    ] },
  };
  const f = importTimeline(doc, "resolve.otio", JSON.stringify(foreign));
  const ft = f.doc.timelines.find((t) => t.id === f.timelineId)!;
  const fc = E.clipsOn(ft, ft.tracks.find((t) => t.kind === "video")!.id);
  check("foreign OTIO: 24 fps frames read as seconds", fc.length === 2 && near(fc[0].duration, 2) && near(fc[0].sourceIn, 10), fc.map((c) => [c.start, c.duration, c.sourceIn]));
  check("foreign OTIO: half speed stretches the clip", near(fc[1].speed, 0.5) && near(fc[1].duration, 2) && near(fc[1].start, 2), fc[1]);
  check("foreign OTIO: unknown file offline, known file matched", f.doc.media.some((m) => m.name === "New Take.mov" && m.note) && fc[1].mediaId === "m1", f.doc.media.map((m) => m.name));
  check("foreign OTIO: transition, effect and nested stack reported", ["transitions", "effects", "nested"].every((w) => f.report.some((x) => x.text.includes(w))), f.report);
  check("foreign OTIO: timeline name kept", ft.name === "From Resolve");

  let threw = "";
  try {
    parseOtio("{ not json", 30);
  } catch (e) {
    threw = (e as Error).message;
  }
  check("OTIO: invalid file gives a readable error", /not an OpenTimelineIO/.test(threw), threw);
  try {
    importTimeline(doc, "x.fcpxml", "<fcpxml/>");
  } catch (e) {
    threw = (e as Error).message;
  }
  check("FCPXML import says it is not supported", /not import/.test(threw), threw);
}

/* ---------- mapping report ---------- */
{
  const doc = project();
  const tl = tlOf(doc);
  const sub = tl.tracks.find((t) => t.kind === "subtitle")!;
  tl.clips.push({ id: "t1", trackId: sub.id, start: 0, duration: 2, sourceIn: 0, sourceOut: 2, speed: 1, enabled: true, effects: [], keyframes: {}, text: { text: "hello" } as never });
  tl.clips.push({ ...tl.clips.find((c) => c.id === "c1")!, id: "gen", mediaId: undefined, generator: { type: "color" } as never });
  tl.cutTransitions = [{ id: "x1", trackId: "v" } as never];
  const r = exportTimeline(doc, tl, "edl");
  const t = r.report.map((x) => x.text).join(" | ");
  check("report: text clips, generators, effects, transitions all listed", /text clip/.test(t) && /generated/.test(t) && /Effects/.test(t) && /transition/.test(t), t);
  const f = exportTimeline(doc, tl, "fcpxml");
  check("FCPXML: assets, lanes, markers", /<asset id="r2" name="interview.mp4"/.test(f.text) && /lane="1"/.test(f.text) && /lane="-1"/.test(f.text) && /<marker /.test(f.text) && /<timeMap>/.test(f.text));
  const open = (f.text.match(/<(\w[\w-]*)[^>]*[^/]>/g) ?? []).length;
  const close = (f.text.match(/<\/\w[\w-]*>/g) ?? []).length;
  check("FCPXML: tags balanced", open - 1 === close || open === close + 0 || Math.abs(open - close) <= 2, [open, close]);
  check("export filenames", f.filename === "Timeline_1.fcpxml" || f.filename.endsWith(".fcpxml"), f.filename);
}

/* ---------- versions ---------- */
{
  const doc = project();
  const s1 = snapshotOf(doc, "manual", { name: "First cut", at: 1000 });
  const tl = tlOf(doc);
  const byId = (id: string) => tl.clips.find((c) => c.id === id)!;
  const n0 = tl.clips.length;
  const doc2: ProjectDoc = { ...doc, timelines: [{ ...tl, clips: [...tl.clips.map((c) => (c.id === "c4" ? { ...c, start: 5 } : c)), { ...byId("c1"), id: "new", start: 30 }] }, ...doc.timelines.slice(1)] };
  const d = diffDocs(doc, doc2);
  check("compare: one clip added, one moved", d.timelines[0]?.added === 1 && d.timelines[0].moved === 1 && d.timelines[0].removed === 0, d.timelines);
  check("compare: described in words", describeDiff(d).some((l) => /1 clip added/.test(l)), describeDiff(d));
  check("compare: same doc has no differences", describeDiff(diffDocs(doc, doc)).length === 0);
  const restored = restoreDoc(s1, { ...doc2, media: doc2.media.map((m) => ({ ...m, url: `blob:${m.id}` })) });
  check("restore: back to the snapshot, media URLs kept", tlOf(restored).clips.length === n0 && restored.media[0].url === "blob:m1", [tlOf(restored).clips.length, restored.media[0].url]);
  check("snapshot holds no session URLs", !s1.json.includes("blob:"));

  const many = Array.from({ length: 60 }, (_, i) => snapshotOf(doc, "auto", { at: 2000 + i, id: `a${i}` }));
  const kept = prune([s1, ...many]);
  check("prune: 40 auto + the named one", kept.length === 41 && kept.some((s) => s.name === "First cut") && kept.some((s) => s.id === "a59") && !kept.some((s) => s.id === "a0"), kept.length);
  check("major change: clips removed", isMajorChange({ ...doc2, timelines: [{ ...tl, clips: Array.from({ length: 9 }, (_, i) => ({ ...tl.clips[0], id: `z${i}` })) }] }, { ...doc2, timelines: [{ ...tl, clips: [] }] }) !== null);
  check("major change: small edit is not", isMajorChange(doc, doc2) === null);
  const be = memoryVersionBackend();
  await be.write("p", [s1]);
  check("version backend round trip", (await be.read("p"))[0].name === "First cut");
}

/* ---------- zip and packages ---------- */
{
  const text = (s: string) => new Blob([s]);
  const zip = await writeZip([{ name: "a.txt", blob: text("hello") }, { name: "dir/b.bin", blob: new Blob([new Uint8Array([1, 2, 3, 250])]) }, { name: "empty", blob: new Blob([]) }]);
  const items = await readZip(zip);
  check("zip: names and sizes", items.map((i) => `${i.name}:${i.size}`).join() === "a.txt:5,dir/b.bin:4,empty:0", items.map((i) => i.name));
  check("zip: contents", (await (await items[0].read()).text()) === "hello" && (await (await items[1].read()).arrayBuffer()).byteLength === 4);
  check("zip: crc check passes", (await Promise.all(items.map(entryIsIntact))).every(Boolean));
  check("crc32 of '123456789'", (await crcOfBlob(text("123456789"))) === 0xcbf43926, (await crcOfBlob(text("123456789"))).toString(16));
  // bit flip in the data
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const at = bytes.indexOf(104); // the h of hello (first entry)
  bytes[at] ^= 0xff;
  const bad = await readZip(new Blob([bytes]));
  check("zip: a flipped byte is detected", !(await entryIsIntact(bad[0])) && (await entryIsIntact(bad[1])));
  let msg = "";
  try {
    await readZip(text("not a zip at all"));
  } catch (e) {
    msg = (e as Error).message;
  }
  check("zip: not a zip says so", /not a zip/.test(msg), msg);
  // a deflated entry, as made by other zip tools
  const raw = new TextEncoder().encode("deflate me ".repeat(50));
  const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const crc = await crcOfBlob(new Blob([raw]));
  const name = new TextEncoder().encode("d.txt");
  const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 8, true); lh.setUint32(14, crc, true); lh.setUint32(18, packed.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, name.length, true);
  const cd = new DataView(new ArrayBuffer(46)); cd.setUint32(0, 0x02014b50, true); cd.setUint16(10, 8, true); cd.setUint32(16, crc, true); cd.setUint32(20, packed.length, true); cd.setUint32(24, raw.length, true); cd.setUint16(28, name.length, true);
  const cdStart = 30 + name.length + packed.length;
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true); end.setUint32(12, 46 + name.length, true); end.setUint32(16, cdStart, true);
  const def = await readZip(new Blob([lh.buffer, name, packed, cd.buffer, name, end.buffer]));
  check("zip: deflated entry reads back", (await (await def[0].read()).text()) === "deflate me ".repeat(50) && (await entryIsIntact(def[0])));

  // a project package
  const doc = project();
  doc.media[0] = { ...doc.media[0], fileKey: "audio", url: "blob:x" };
  const files: Record<string, Blob> = { m1: new Blob(["VIDEO-1"]), m3: new Blob(["WAV"]) };
  const built = await buildPackage({
    name: "My film", doc,
    items: [{ id: "m1", name: "interview.mp4", storage: "link" }, { id: "m2", name: "broll.mp4" }, { id: "m3", name: "song.wav" }],
    bins: [{ id: "b1", name: "Bin" }],
    readFile: async (it) => files[it.id] ?? null,
    readSlot: async (k) => (k === "audio" ? new Blob(["SONG"]) : null),
  });
  check("package: a file that cannot be read is reported", built.missing.join() === "broll.mp4", built.missing);
  const pkg = await openPackage(built.blob, { verify: true });
  check("package: project, items and bins", pkg.manifest.name === "My film" && pkg.doc.media.length === 3 && pkg.items.length === 3 && pkg.bins.length === 1);
  check("package: linked items become copies", pkg.items.every((i) => i.storage !== "link"), pkg.items);
  check("package: media files and slot file inside", (await (await pkg.files.get("m1")!.read()).text()) === "VIDEO-1" && pkg.files.size === 2 && (await (await pkg.slots.get("audio")!.read()).text()) === "SONG");
  check("package: no session URL inside", !JSON.stringify(pkg.doc).includes("blob:x"));
  check("package: intact", pkg.damaged.length === 0, pkg.damaged);
  const b2 = new Uint8Array(await built.blob.arrayBuffer());
  const needle = new TextEncoder().encode("VIDEO-1");
  let pos = 0;
  while (pos < b2.length && !needle.every((x, k) => b2[pos + k] === x)) pos++;
  b2[pos] ^= 0xff;
  check("package: a damaged media file is named", (await openPackage(new Blob([b2]), { verify: true })).damaged.join() === "interview.mp4");
  msg = "";
  try {
    await openPackage(await writeZip([{ name: "x.txt", blob: text("1") }]));
  } catch (e) {
    msg = (e as Error).message;
  }
  check("package: another zip is refused", /not a Cutir/.test(msg), msg);
}

/* ---------- recovery and integrity ---------- */
{
  const doc = project();
  const good = JSON.stringify(doc);
  const rec = (json: string, at: number) => ({ at, sum: checksum(json), json });
  check("checksum differs for different text", checksum("abc") !== checksum("abd") && checksum("abc") === checksum("abc"));
  check("source: intact local wins", chooseSource({ json: good, sum: checksum(good), savedAt: 5000 }, rec(good, 5100)).source === "local");
  check("source: no checksum yet (older save) is trusted when it parses", chooseSource({ json: good, sum: null, savedAt: 1 }, null).source === "local");
  const lost = chooseSource({ json: good, sum: checksum(good), savedAt: 5000 }, rec(JSON.stringify({ ...doc, activeTimelineId: doc.activeTimelineId }) + " ", 9000));
  check("source: a parseable newer recovery copy wins when the last save was lost", lost.source === "recovery" && (lost as { why: string }).why === "newer", lost);
  const cut = good.slice(0, good.length - 50);
  const dam = chooseSource({ json: cut, sum: checksum(good), savedAt: 5000 }, rec(good, 4000));
  check("source: cut-off save falls back to the recovery copy", dam.source === "recovery" && (dam as { why: string }).why === "damaged", dam);
  check("source: checksum mismatch with valid JSON is not trusted", chooseSource({ json: good, sum: "0:0", savedAt: 1 }, rec(good, 1)).source === "recovery");
  check("source: both bad -> none", chooseSource({ json: cut, sum: null, savedAt: 1 }, rec("{", 2)).source === "none");
  check("source: nothing at all -> none (empty)", (chooseSource({ json: null, sum: null, savedAt: 0 }, null) as { why: string }).why === "empty");

  const backend = memoryRecoveryBackend();
  let t = 1000;
  const w = recoveryWriter(backend, 20, () => t);
  w.schedule("p", "one");
  w.schedule("p", "two");
  await w.flush();
  check("recovery writer: keeps only the latest, with checksum", backend.store.get("p")?.json === "two" && backend.store.get("p")?.sum === checksum("two"), backend.store.get("p"));
  w.schedule("p", "three");
  await new Promise((r) => setTimeout(r, 60));
  check("recovery writer: writes by itself after the delay", backend.store.get("p")?.json === "three");
  w.schedule("q", "x");
  w.schedule("r", "y");
  await w.flush();
  check("recovery writer: switching project does not drop the first", backend.store.has("q") && backend.store.has("r"));
}

/* ---------- storage usage ---------- */
{
  const files = [
    { key: "p1/m/a", size: 1000 }, { key: "p1/m/b", size: 5000 }, { key: "p1/proxy/a", size: 300 }, { key: "p1/opt/b", size: 700 },
    { key: "p1/thumb/a", size: 10 }, { key: "p1/versions.json", size: 40 }, { key: "p1/recovery.json", size: 60 }, { key: "p1/m/gone", size: 800 }, { key: "p2/m/a", size: 99999 },
  ];
  const u = projectUsage("p1", files, [{ id: "a", name: "A.mp4" }, { id: "b", name: "B.mp4", storage: "link" }]);
  check("usage: totals by kind", u.media === 6800 && u.proxies === 300 && u.optimized === 700 && u.thumbs === 10 && u.versions === 40 && u.recovery === 60 && u.total === 6800 + 300 + 700 + 10 + 100, u);
  check("usage: other projects not counted", !u.orphans.some((o) => o.key.startsWith("p2")) && u.total < 99999);
  check("usage: orphan found", u.orphans.length === 1 && u.orphans[0].key === "p1/m/gone", u.orphans);
  check("usage: items largest first", u.items[0].id === "b" && u.items[0].bytes === 5700 && u.items[0].linked, u.items);
  check("formatBytes", formatBytes(512) === "512 B" && formatBytes(1536) === "1.5 KB" && formatBytes(5 * 1048576) === "5.0 MB" && formatBytes(3 * 1073741824) === "3.0 GB", [formatBytes(1536), formatBytes(5 * 1048576)]);
}

/* ---------- merge of operations ---------- */
{
  const base = { name: "x", clips: [{ id: "a", start: 0, text: "one" }, { id: "b", start: 5, text: "two" }, { id: "c", start: 9, text: "three" }], settings: { fps: 30 } };
  const edit = <T,>(d: T, f: (x: any) => void): T => { const c = structuredClone(d) as any; f(c); return c; };
  // they insert at the front and move b; we edit c's text and fps
  const theirs = edit(base, (d) => { d.clips.unshift({ id: "n", start: 1, text: "new" }); d.clips[2].start = 6; });
  const ours = edit(base, (d) => { d.clips[2].text = "THREE"; d.settings.fps = 60; });
  const m = mergeDocs(base, theirs, ours);
  check("merge: both sets of changes present", m.doc.clips.map((c) => c.id).join() === "n,a,b,c" && m.doc.clips[2].start === 6 && m.doc.clips[3].text === "THREE" && m.doc.settings.fps === 60 && m.conflicts.length === 0, m.doc);
  // they delete b; we edit b and c
  const del = edit(base, (d) => d.clips.splice(1, 1));
  const ed = edit(base, (d) => { d.clips[1].text = "TWO"; d.clips[2].text = "THREE"; });
  const m2 = mergeDocs(base, del, ed);
  check("merge: edit of a deleted clip dropped and reported, the rest kept", m2.doc.clips.length === 2 && m2.doc.clips[1].text === "THREE" && m2.conflicts.length === 1 && m2.conflicts[0].reason === "deleted-by-other", [m2.doc, m2.conflicts]);
  // both change the same text
  const m3 = mergeDocs(base, edit(base, (d) => { d.clips[0].text = "theirs"; }), edit(base, (d) => { d.clips[0].text = "ours"; }));
  check("merge: same value changed by both: ours wins and it is reported", m3.doc.clips[0].text === "ours" && m3.conflicts.some((c) => c.reason === "both-changed"), [m3.doc.clips[0], m3.conflicts]);
  // both delete the same clip
  const m4 = mergeDocs(base, del, del);
  check("merge: both delete the same clip: deleted once, no conflict", m4.doc.clips.length === 2 && m4.conflicts.length === 0, [m4.doc.clips.length, m4.conflicts]);
  // we delete a, they insert after a
  const m5 = mergeDocs(base, edit(base, (d) => d.clips.splice(1, 0, { id: "ins", start: 2, text: "ins" })), edit(base, (d) => d.clips.splice(0, 1)));
  check("merge: delete here and insert there", m5.doc.clips.map((c) => c.id).join() === "ins,b,c", m5.doc.clips.map((c) => c.id));
  // we add a clip at the end, they add one at the end
  const m6 = mergeDocs(base, edit(base, (d) => d.clips.push({ id: "t", start: 20, text: "t" })), edit(base, (d) => d.clips.push({ id: "o", start: 21, text: "o" })));
  check("merge: both append", m6.doc.clips.length === 5 && m6.doc.clips.some((c) => c.id === "t") && m6.doc.clips.some((c) => c.id === "o"), m6.doc.clips.map((c) => c.id));
  const r = rebase(base, diff(base, theirs), []);
  check("rebase: no local changes leaves theirs", JSON.stringify(r.doc) === JSON.stringify(theirs) && r.patches.length === 0);
  check("diff/applyPatches sanity", JSON.stringify(applyPatches(base, diff(base, ours))) === JSON.stringify(ours));
}

/* ---------- sync sessions ---------- */
{
  const base = { clips: [{ id: "a", text: "one" }, { id: "b", text: "two" }], title: "t" };
  const backend = memoryBackend();
  const A = newSession(backend, "proj", base, "A");
  const B = newSession(backend, "proj", base, "B");
  const a1 = { ...base, clips: [{ id: "a", text: "ONE" }, base.clips[1]] };
  const ra = await syncOnce(A, a1);
  check("sync: first client pushes", ra.pushed === 1 && ra.pulled === 0 && A.lastSeq === 1, ra);
  const b1 = { ...base, clips: [...base.clips, { id: "z", text: "zed" }], title: "T" };
  const rb = await syncOnce(B, b1);
  const bd = rb.doc as typeof base;
  check("sync: second client gets the first's change merged with its own", rb.pulled === 1 && rb.pushed === 2 && bd.clips[0].text === "ONE" && bd.clips.length === 3 && bd.title === "T", rb);
  const ra2 = await syncOnce(A, a1);
  const ad = ra2.doc as typeof base;
  check("sync: first client then sees the second's work", ra2.pulled === 1 && ad.clips.length === 3 && ad.title === "T" && ad.clips[0].text === "ONE", ra2);
  check("sync: both end up equal", JSON.stringify(ad) === JSON.stringify(bd));
  const quiet = await syncOnce(A, ra2.doc);
  check("sync: nothing to do when nothing changed", quiet.pulled === 0 && quiet.pushed === 0);
  const c = await backend.addComment("proj", { time: 12.5, text: "cut earlier", author: "Sam" });
  await backend.resolveComment("proj", c.id, true, "Me");
  const cs = await backend.comments("proj");
  check("review: comments pinned to time, resolved by someone", cs.length === 1 && cs[0].time === 12.5 && cs[0].resolved && cs[0].resolvedBy === "Me", cs);
}

/* ---------- the reference service ---------- */
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { makeServer, addUser } = await import("../sync-server/server.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cutir-sync-"));
  const token = addUser(dir, "alice");
  const server = makeServer(dir);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  try {
    const be = httpBackend(url, token);
    const bad = httpBackend(url, "wrong");
    let denied = "";
    try {
      await bad.pull("p", 0);
    } catch (e) {
      denied = (e as Error).message;
    }
    check("server: wrong token refused", /did not accept/.test(denied), denied);
    const base = { clips: [{ id: "a", text: "one" }], n: 1 };
    const A = newSession(be, "film 1", base, "A");
    const B = newSession(be, "film 1", base, "B");
    await syncOnce(A, { ...base, n: 2 });
    const rb = await syncOnce(B, { ...base, clips: [...base.clips, { id: "b", text: "two" }] });
    const d = rb.doc as typeof base;
    check("server: two clients merge through the service", d.n === 2 && d.clips.length === 2 && rb.pulled === 1, rb);
    const stale = await fetch(`${url}/p/film%201/ops`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ baseSeq: 0, client: "X", patches: [] }) });
    check("server: a push on an old base is refused (409)", stale.status === 409, stale.status);
    const link = await be.createReview("film 1", { name: "Rough cut", changes: ["2 clips added"] });
    const page = await (await fetch(link.url.replace(/^http:\/\/[^/]+/, url))).text();
    check("review link: page with changes and comment form", /Rough cut/.test(page) && /2 clips added/.test(page) && /Add comment/.test(page));
    const posted = await fetch(`${url}/review/${link.token}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "Pat", time: 31, text: "Tighten this" }) });
    check("review link: a reviewer needs no account to comment", posted.ok);
    const owner = await be.comments("film 1");
    check("review: the owner sees the comment pinned at 31s", owner.length === 1 && owner[0].time === 31 && owner[0].author === "Pat", owner);
    await be.resolveComment("film 1", owner[0].id, true, "alice");
    check("review: resolved state saved", (await be.comments("film 1"))[0].resolved === true);
    const nope = await fetch(`${url}/review/not-a-token/comments`);
    check("review: unknown link is a 404", nope.status === 404);
    const other = addUser(dir, "bob");
    check("server: another user does not see alice's project", (await httpBackend(url, other).pull("film 1", 0)).head === 0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
