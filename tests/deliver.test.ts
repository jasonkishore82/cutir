// Phase 26: presets, file names, queue state machine, zip writer, output verdicts.
import { BUILTIN_PRESETS, fileName, fitSize, presetsFromJson, presetsToJson, sanitizePreset, estimateBytes, audioCodecsFor, videoCodecsFor } from "../src/lib/deliver/presets";
import * as Q from "../src/lib/deliver/queue";
import { crc32, zipStore } from "../src/lib/deliver/zip";
import { judge } from "../src/lib/deliver/verify";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};

/* presets */
check("built-in presets cover the spec", ["youtube-1080", "youtube-4k", "shorts-reels", "instagram-square", "twitter", "archive", "audio-wav", "gif", "png-seq"].every((id) => BUILTIN_PRESETS.some((p) => p.id === id)));
check("built-in ids are unique", new Set(BUILTIN_PRESETS.map((p) => p.id)).size === BUILTIN_PRESETS.length);
check("every built-in survives sanitising unchanged in codecs", BUILTIN_PRESETS.every((p) => { const s = sanitizePreset(p); return !!s && s.video === p.video && s.audio === p.audio && s.container === p.container; }));
check("fit: same aspect uses the preset frame", JSON.stringify(fitSize({ width: 1280, height: 720 }, { w: 1920, h: 1080 })) === JSON.stringify({ w: 1280, h: 720 }));
check("fit: 9:16 preset on 16:9 project does not stretch", (() => { const r = fitSize({ width: 1080, height: 1920 }, { w: 1920, h: 1080 }); return Math.abs(r.w / r.h - 16 / 9) < 0.02 && r.w <= 1080; })());
check("fit: width only keeps aspect and is even", (() => { const r = fitSize({ width: 641, height: 0 }, { w: 1920, h: 1080 }); return r.w % 2 === 0 && r.h % 2 === 0 && Math.abs(r.w / r.h - 16 / 9) < 0.02; })());
check("fit: zero means project size", JSON.stringify(fitSize({ width: 0, height: 0 }, { w: 1080, h: 1920 })) === JSON.stringify({ w: 1080, h: 1920 }));
check("container/codec mismatch is repaired", (() => { const p = sanitizePreset({ name: "x", container: "webm", video: "avc", audio: "aac" }); return p?.video === "vp9" && p?.audio === "opus"; })());
check("preset without a name is rejected", sanitizePreset({ container: "mp4" }) === null && sanitizePreset(5) === null);
check("numbers are clamped", (() => { const p = sanitizePreset({ name: "x", bitrateMbps: 99999, fps: -4, audioKbps: 1 }); return p?.bitrateMbps === 400 && p?.fps === 0 && p?.audioKbps === 32; })());
check("webm holds only opus audio", audioCodecsFor("webm").join() === "opus" && videoCodecsFor("wav").length === 0);

/* file names */
const d = new Date(2026, 10, 21, 9, 5, 7);
check("pattern fills tokens", fileName("{project}-{preset}-{date}_{time}-{w}x{h}", { project: "My Song", preset: "YouTube", date: d, w: 1920, h: 1080 }, "mp4") === "My Song-YouTube-2026-11-21_090507-1920x1080.mp4");
check("unsafe characters are removed", fileName("{preset}", { project: "p", preset: 'a/b:c*"d' }, "webm") === "a_b_c_d.webm");
check("unknown tokens stay visible", fileName("{nope}-{n}", { project: "p", preset: "x", n: 3 }, "mp4") === "{nope}-03.mp4");
check("empty pattern falls back to project", fileName("  ", { project: "song", preset: "x" }, "wav") === "song.wav");
check("png sequence is a zip", fileName("a", { project: "p", preset: "x" }, "png-seq") === "a.zip");

/* import and export */
const mine = sanitizePreset({ name: "Mine", container: "mp4", bitrateMbps: 5 })!;
const text = presetsToJson([mine]);
const back = presetsFromJson(text, new Set(BUILTIN_PRESETS.map((p) => p.id)));
check("preset round trip", back.presets.length === 1 && back.presets[0].name === "Mine" && back.presets[0].bitrateMbps === 5 && back.skipped === 0);
check("imported ids never clash", (() => { const again = presetsFromJson(text, new Set(["custom-mine"])); return again.presets[0].id !== "custom-mine"; })());
check("import accepts one preset, an array, and skips junk", presetsFromJson(JSON.stringify(mine), new Set()).presets.length === 1 && presetsFromJson(JSON.stringify([mine, { x: 1 }]), new Set()).skipped === 1 && presetsFromJson("not json", new Set()).presets.length === 0);
check("size estimate is sane", estimateBytes(BUILTIN_PRESETS[0], 60) > 50e6 && estimateBytes(BUILTIN_PRESETS.find((p) => p.id === "audio-wav")!, 1) === 192000);

/* queue */
const job = (id: string, status: Q.JobStatus = "queued"): Q.Job => ({ id, name: id, preset: BUILTIN_PRESETS[0], timelineId: "t", timelineName: "T", start: 0, end: 10, source: "original", status, progress: 0, stage: "Waiting", attempts: 0, createdAt: 0 });
let jobs: Q.Job[] = ["a", "b", "c"].reduce((l, id) => Q.enqueue(l, job(id)), [] as Q.Job[]);
check("first queued job runs first", Q.nextRunnable(jobs, false)?.id === "a");
check("nothing starts while held or busy", Q.nextRunnable(jobs, true) === undefined && Q.nextRunnable(Q.start(jobs, "a"), false) === undefined);
jobs = Q.move(jobs, "c", -1);
check("reorder", jobs.map((j) => j.id).join("") === "acb");
check("move past the ends does nothing", Q.move(jobs, "a", -1) === jobs);
jobs = Q.setHold(jobs, "a", true);
check("held job is skipped", Q.nextRunnable(jobs, false)?.id === "c");
jobs = Q.setHold(jobs, "a", false);
jobs = Q.start(jobs, "a");
check("running job is not moved or cancelled as waiting", Q.move(jobs, "a", 1) === jobs && Q.cancelWaiting(jobs, "a").find((j) => j.id === "a")!.status === "running");
jobs = Q.progress(jobs, "a", 0.5, "Encoding");
check("progress is recorded", jobs[0].progress === 0.5 && jobs[0].stage === "Encoding");
jobs = Q.finish(jobs, "a", { kind: "failed", error: "boom" });
check("a failed job leaves the others queued", jobs[0].status === "failed" && jobs[0].error === "boom" && jobs.filter((j) => j.status === "queued").length === 2);
check("the queue moves on after a failure", Q.nextRunnable(jobs, false)?.id === "c");
jobs = Q.retry(jobs, "a");
check("retry requeues only that job", jobs[0].status === "queued" && jobs[0].error === undefined && jobs[0].attempts === 1 && jobs[1].status === "queued");
jobs = Q.cancelWaiting(jobs, "b");
check("cancel a waiting job", jobs.find((j) => j.id === "b")!.status === "cancelled");
jobs = Q.start(jobs, "a");
jobs = Q.finish(jobs, "a", { kind: "done", fileName: "a.mp4", bytes: 10, verdict: { ok: true, checks: [] } });
check("done job keeps its file info", jobs[0].status === "done" && jobs[0].hasFile === true && jobs[0].fileName === "a.mp4");
jobs = Q.finish(Q.start(jobs, "c"), "c", { kind: "done", fileName: "c.mp4", bytes: 5, verdict: { ok: false, checks: [{ name: "x", ok: false, detail: "" }] } });
check("a failed verification is flagged", jobs.find((j) => j.id === "c")!.stage === "Finished, check failed" && !!jobs.find((j) => j.id === "c")!.error);
const reloaded = Q.recover(Q.start([job("x"), job("y")], "x"));
check("reload: running becomes interrupted, waiting stays", reloaded[0].status === "interrupted" && reloaded[1].status === "queued");
check("reload: finished files are gone but the record stays", Q.recover(jobs).find((j) => j.id === "a")!.hasFile === false && Q.recover(jobs).find((j) => j.id === "a")!.status === "done");
check("interrupted job can be retried", Q.retry(reloaded, "x")[0].status === "queued");
check("remove skips running, clear drops finished", Q.remove(Q.start([job("x")], "x"), "x").length === 1 && Q.clearFinished(jobs).every((j) => !Q.isFinished(j)));
check("summary counts", (() => { const s = Q.summary(jobs); return s.done === 2 && s.waiting === 0; })());

/* zip */
check("crc32 of 123456789", crc32(new TextEncoder().encode("123456789")) === 0xcbf43926);
const zip = zipStore([{ name: "a.txt", data: new TextEncoder().encode("hello") }, { name: "dir/b.bin", data: new Uint8Array([1, 2, 3]) }]);
const dv = new DataView(zip.buffer);
check("zip signatures", dv.getUint32(0, true) === 0x04034b50 && dv.getUint32(zip.length - 22, true) === 0x06054b50);
check("zip entry count and directory offset", dv.getUint16(zip.length - 22 + 10, true) === 2 && dv.getUint32(dv.getUint32(zip.length - 22 + 16, true), true) === 0x02014b50);
check("zip stores data verbatim", new TextDecoder().decode(zip.slice(30 + 5, 30 + 5 + 5)) === "hello");

/* verdicts */
const good = judge({ container: "mp4", seconds: 10, fps: 30, hasAudio: true }, { bytes: 1000, videoSeconds: 10, frames: 300, audioSeconds: 10, firstFrame: true, lastFrame: true });
check("good file passes", good.ok);
check("wrong frame count fails", !judge({ container: "mp4", seconds: 10, fps: 30, hasAudio: false }, { bytes: 1, videoSeconds: 10, frames: 250, firstFrame: true, lastFrame: true }).ok);
check("audio drift fails", !judge({ container: "mp4", seconds: 10, fps: 30, hasAudio: true }, { bytes: 1, videoSeconds: 10, frames: 300, audioSeconds: 9.3, firstFrame: true, lastFrame: true }).ok);
check("missing audio track fails", !judge({ container: "webm", seconds: 10, fps: 30, hasAudio: true }, { bytes: 1, videoSeconds: 10, frames: 300, firstFrame: true, lastFrame: true }).ok);
check("undecodable last frame fails", !judge({ container: "mp4", seconds: 1, fps: 30, hasAudio: false }, { bytes: 1, videoSeconds: 1, frames: 30, firstFrame: true, lastFrame: false }).ok);
check("audio only checks duration", judge({ container: "wav", seconds: 5, fps: 30, hasAudio: true }, { bytes: 9, audioSeconds: 5.02, firstAudio: true }).ok && !judge({ container: "wav", seconds: 5, fps: 30, hasAudio: true }, { bytes: 9, audioSeconds: 4, firstAudio: true }).ok);
check("gif and zip are checked by header", judge({ container: "gif", seconds: 1, fps: 15, hasAudio: false }, { bytes: 5, head: "GIF89a" }).ok && !judge({ container: "png-seq", seconds: 1, fps: 15, hasAudio: false }, { bytes: 5, head: "xx" }).ok);
check("empty file fails", !judge({ container: "mp4", seconds: 1, fps: 30, hasAudio: false }, { bytes: 0 }).ok);

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
