// Phase 21: sample-accurate voice plans for decoded clips, including reversed ones.
import { DRIFT_LIMIT, LOOKAHEAD, MAX_BUFFER_BYTES, bufferable, fitsInMemory, needsRestart, upcoming, voiceDrift, voicePlan, voicePosition } from "../src/lib/audio/schedule";
import type { Clip } from "../src/model/types";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) < e;
const clip = (p: Partial<Clip> = {}): Clip => ({ id: "c", trackId: "a1", mediaId: "m", start: 10, duration: 4, sourceIn: 20, sourceOut: 24, speed: 1, enabled: true, effects: [], keyframes: {}, ...p });
const BUF = 100;

// forward
const f0 = voicePlan(clip(), 10, 1, BUF)!;
check("forward: at the clip start it plays from the in point", near(f0.offset, 20) && f0.rate === 1 && near(f0.remaining, 4), f0);
const f1 = voicePlan(clip(), 11.5, 1, BUF)!;
check("forward: 1.5 s in is 21.5 s into the source, 2.5 s left", near(f1.offset, 21.5) && near(f1.remaining, 2.5), f1);
check("forward: before and after the clip is silent", voicePlan(clip(), 9.99, 1, BUF) === null && voicePlan(clip(), 14, 1, BUF) === null);
const f2 = voicePlan(clip({ speed: 2, sourceOut: 28 }), 12, 1, BUF)!;
check("speed 2: the buffer plays at rate 2 from the right place", f2.rate === 2 && near(f2.offset, 24) && near(f2.remaining, 4), f2);
check("transport rate multiplies the clip speed", voicePlan(clip(), 11, 0.5, BUF)!.rate === 0.5);
check("too fast for a buffer is silent", voicePlan(clip({ speed: 4 }), 11, 8, BUF) === null);
check("too slow for a buffer is silent", voicePlan(clip({ speed: 0.01 }), 11, 1, BUF) === null);

// reversed: the reversed buffer starts at the original's end, so the out point is heard first
const r0 = voicePlan(clip({ reverse: true }), 10, 1, BUF)!;
check("reverse: at the start it plays from the out point backwards (offset = length - out)", near(r0.offset, BUF - 24) && r0.rate === 1 && near(r0.remaining, 4), r0);
const r1 = voicePlan(clip({ reverse: true }), 11, 1, BUF)!;
check("reverse: one second in is one second further into the reversed buffer", near(r1.offset, BUF - 24 + 1) && near(r1.remaining, 3), r1);
const rEnd = voicePlan(clip({ reverse: true }), 13.99, 1, BUF)!;
check("reverse: near the end the buffer position is near the in point's mirror", near(rEnd.offset, BUF - 24 + 3.99) && rEnd.remaining < 0.02, rEnd);
check("reverse at speed 2 reads twice as fast", (() => { const p = voicePlan(clip({ reverse: true, speed: 2, sourceIn: 20, sourceOut: 28 }), 11, 1, BUF)!; return p.rate === 2 && near(p.offset, BUF - 28 + 2); })());
check("reverse and forward cover the same source range", (() => { const a = voicePlan(clip(), 10, 1, BUF)!, b = voicePlan(clip({ reverse: true }), 10, 1, BUF)!; return near(a.offset, 20) && near(BUF - b.offset, 24); })());

// what can use a buffer
check("a clip with a speed ramp uses a media element", !bufferable(clip({ ramp: { ease: true, keys: [{ t: 0, speed: 1 }, { t: 1, speed: 2 }] } })) && bufferable(clip()));
check("nested and multicam clips use a media element", !bufferable(clip({ timelineId: "t2" })) && !bufferable(clip({ multicam: { angles: [], cuts: [] } as never })));
check("five minutes of stereo fits, an hour does not", fitsInMemory(300) && !fitsInMemory(3600) && fitsInMemory(100, 44100, 2) && !fitsInMemory(0));
check("the memory limit is 128 MB", MAX_BUFFER_BYTES === 128 * 1024 * 1024);

// drift
const plan = voicePlan(clip(), 11, 1, BUF)!;
const v = { startedAt: 5, offset: 20, rate: 1 };
check("a voice's position follows the audio clock and its rate", near(voicePosition(v, 6.5), 21.5) && near(voicePosition({ ...v, rate: 2 }, 6.5), 23));
check("a voice on time is kept", !needsRestart({ startedAt: 5, offset: 20, rate: 1 }, 6, plan) && near(voiceDrift({ startedAt: 5, offset: 20, rate: 1 }, 6, plan), 0));
check("a voice that drifted past the limit restarts", needsRestart({ startedAt: 5, offset: 20, rate: 1 }, 6 + DRIFT_LIMIT * 2, plan) && needsRestart({ startedAt: 5, offset: 20, rate: 1 }, 6 - DRIFT_LIMIT * 2, plan));
check("a small drift is tolerated", !needsRestart({ startedAt: 5, offset: 20, rate: 1 }, 6 + DRIFT_LIMIT / 2, plan));
check("a rate change restarts it", needsRestart({ startedAt: 5, offset: 20, rate: 1 }, 6, { ...plan, rate: 1.5 }));

// lookahead
const clips = [clip({ id: "soon", start: 10.1 }), clip({ id: "later", start: 12 }), clip({ id: "past", start: 9 })];
const up = upcoming(clips, 10, 1, 100);
check("only clips starting inside the lookahead are scheduled", up.map((u) => u.clip.id).join() === "soon" && LOOKAHEAD > 0.1);
check("the start time is on the audio clock to the sample", near(up[0].when, 100.1, 1e-9), up);
check("at double speed the same timeline gap is half the clock time", near(upcoming(clips, 10, 2, 100)[0].when, 100.05, 1e-9));
check("nothing is scheduled while paused or going backwards", upcoming(clips, 10, 0, 100).length === 0 && upcoming(clips, 10, -1, 100).length === 0);

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
