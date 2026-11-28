// Phase 25, the rest: speaker detection, translation kept in step with its source, safe areas, soft subtitle tracks from the compatibility encoder.
import { clusterSpeakers, framePitch, labelSpeakers, voicePrint } from "../src/lib/captions/speakers";
import { pairTranslation, resyncTranslation } from "../src/lib/captions/translate";
import { SAFE_WIDTH, safeRects } from "../src/lib/captions/presets";
import { muxArgs } from "../src/lib/muxArgs";
import type { Cue } from "../src/lib/captions/cues";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/* ---------- speakers ---------- */
const SR = 16000;
/** A voice: harmonics of f0 whose strength peaks around `formant` Hz, with a little wobble in the pitch. */
function voice(f0: number, formant: number, seconds: number, seed = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let phase = 0;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + 0.01 * Math.sin(2 * Math.PI * 4 * t) + 0.002 * rnd());
    phase += (2 * Math.PI * f) / SR;
    let v = 0;
    for (let h = 1; h * f < 5000; h++) v += Math.sin(h * phase) * Math.exp(-(((h * f - formant) / 700) ** 2));
    const env = Math.min(1, t * 20, (seconds - t) * 20); // a short fade at each end
    out[i] = 0.25 * v * env;
  }
  return out;
}
{
  const p = voice(120, 600, 0.3);
  const hz = framePitch(p, 1000, SR);
  check("pitch of a 120 Hz voice is found", near(hz, 120, 4), hz);
  const hi = framePitch(voice(220, 600, 0.3), 1000, SR);
  check("pitch of a 220 Hz voice is found", near(hi, 220, 6), hi);
  check("silence has no pitch", framePitch(new Float32Array(2000), 0, SR) === 0);

  // a conversation: A (low, dark), B (high, bright), in this order of captions
  const order = ["A", "A", "B", "A", "B", "B", "A"];
  const seg = 1.4;
  const gap = 0.3;
  const total = order.length * (seg + gap) + 1;
  const samples = new Float32Array(Math.round(total * SR));
  const cues: Cue[] = [];
  order.forEach((who, i) => {
    const start = 0.2 + i * (seg + gap);
    const v = who === "A" ? voice(115, 500, seg, i + 1) : voice(215, 1800, seg, i + 11);
    samples.set(v, Math.round(start * SR));
    cues.push({ start, end: start + seg, text: `line ${i}` });
  });
  const r = labelSpeakers(cues, samples, SR);
  const names = r.cues.map((c) => c.speaker);
  check("two voices are found", r.speakers === 2, r.speakers);
  check("the first to speak is Speaker 1", names[0] === "Speaker 1");
  check("captions are grouped by voice", order.every((w, i) => (w === order[0]) === (names[i] === names[0])), names);
  const forced = labelSpeakers(cues, samples, SR, { speakers: 2 });
  check("asking for two speakers gives the same grouping", forced.cues.map((c) => c.speaker).join() === names.join());

  // one speaker only: never split
  const mono = new Float32Array(Math.round(8 * SR));
  const oneCues: Cue[] = [];
  for (let i = 0; i < 5; i++) {
    const start = 0.2 + i * 1.5;
    mono.set(voice(130 + (i % 2) * 4, 700, 1.3, i + 3), Math.round(start * SR));
    oneCues.push({ start, end: start + 1.3, text: "x" });
  }
  const one = labelSpeakers(oneCues, mono, SR);
  check("one voice stays one speaker", one.speakers === 1 && one.cues.every((c) => c.speaker === "Speaker 1"), one.cues.map((c) => c.speaker));

  // a caption with no voiced sound takes the speaker before it
  const quiet = [...cues.slice(0, 3), { start: 40, end: 41, text: "silent" }];
  const q = labelSpeakers(quiet, samples, SR);
  check("a caption that cannot be judged takes the previous speaker", q.cues[3].speaker === q.cues[2].speaker);
  check("a named speaker is kept when asked", labelSpeakers([{ ...cues[0], speaker: "Ana" }, ...cues.slice(1)], samples, SR, { keepNamed: true }).cues[0].speaker === "Ana");
  check("no cues, no speakers", labelSpeakers([], samples, SR).speakers === 0 && clusterSpeakers([]).speakers === 0);
  check("a too-short stretch gives no voice print", voicePrint(samples, SR, 0, 0.01) === null);
}

/* ---------- translation kept in step ---------- */
{
  const src: Cue[] = [{ start: 0, end: 2, text: "Hello" }, { start: 2, end: 4, text: "How are you" }, { start: 4, end: 6, text: "Fine" }];
  const tr: Cue[] = [{ start: 0, end: 2, text: "Hola" }, { start: 2, end: 4, text: "Como estas" }, { start: 4, end: 6, text: "Bien" }];
  const same = resyncTranslation(src, tr);
  check("an untouched pair is in step", same.retimed === 0 && same.missing.length === 0 && same.cues.every((c, i) => c.text === tr[i].text));

  // the source was retimed (shifted and stretched)
  const moved = src.map((c) => ({ ...c, start: c.start + 1, end: c.end + 1.5 }));
  const rt = resyncTranslation(moved, tr);
  check("a retimed source brings its translation along", rt.retimed === 3 && rt.missing.length === 0 && rt.cues.every((c, i) => near(c.start, moved[i].start) && near(c.end, moved[i].end) && c.text === tr[i].text), rt);

  // a source cue was split in two: the first half keeps the text, the second is missing
  const split: Cue[] = [{ start: 0, end: 2, text: "Hello" }, { start: 2, end: 3, text: "How are" }, { start: 3, end: 4, text: "you" }, { start: 4, end: 6, text: "Fine" }];
  const sp = resyncTranslation(split, tr);
  check("a split leaves one half untranslated", sp.cues.length === 4 && sp.missing.length === 1 && sp.cues[1].text === "Como estas" !== (sp.cues[2].text === "Como estas") && sp.cues[3].text === "Bien", sp);
  check("untranslated cues keep the source timing", near(sp.cues[sp.missing[0]].start, split[sp.missing[0]].start));

  // two source cues merged: the translation of both is joined
  const merged: Cue[] = [{ start: 0, end: 4, text: "Hello. How are you" }, { start: 4, end: 6, text: "Fine" }];
  const mg = resyncTranslation(merged, tr);
  check("a merge joins the translations in order", mg.cues[0].text === "Hola Como estas" && mg.cues[1].text === "Bien" && mg.missing.length === 0, mg.cues);
  check("pairing by position when the counts match", pairTranslation(moved, tr).join() === "0,1,2");
  check("nothing in the source pairs to nothing", pairTranslation([], tr).every((x) => x === -1));
  check("an empty translation marks every cue missing", resyncTranslation(src, []).missing.length === 3);
  check("speaker names are kept", resyncTranslation([{ ...src[0], speaker: "Ana" }], [tr[0]]).cues[0].speaker === "Ana");
}

/* ---------- safe areas ---------- */
{
  const r = safeRects("title");
  check("action safe is 93% centred", near(r.action.w, 0.93) && near(r.action.x, 0.035) && near(r.action.y, 0.035));
  check("title safe is 90% centred", near(r.title.w, 0.9) && near(r.title.x + r.title.w, 0.95));
  check("the caption area uses the chosen width and sits in the lower half", near(r.caption.w, SAFE_WIDTH.title) && r.caption.y >= 0.5 && near(r.caption.y + r.caption.h, 0.95));
  check("a wide margin narrows the caption area", safeRects("wide").caption.w < r.caption.w && near(safeRects("wide").caption.w, 0.8));
}

/* ---------- soft subtitle tracks from the compatibility encoder ---------- */
{
  const plain = muxArgs({ list: "list.txt", audio: "mix.wav", out: "out.mp4" });
  check("without subtitles the mux is as before", plain.join(" ").includes("-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac") && !plain.includes("-c:s") && plain[plain.length - 1] === "out.mp4" && plain[0] === "-y");
  const withSubs = muxArgs({ list: "list.txt", audio: "mix.wav", subtitles: [{ file: "sub0.vtt", lang: "en", name: "English" }, { file: "sub1.vtt", lang: "es", name: "Spanish" }], out: "out.mp4" });
  const j = withSubs.join(" ");
  check("each subtitle file is an input and is mapped", j.includes("-i sub0.vtt") && j.includes("-i sub1.vtt") && j.includes("-map 2:0") && j.includes("-map 3:0"));
  check("subtitles are stored as mov_text with language and name", j.includes("-c:s mov_text") && j.includes("-metadata:s:s:0 language=eng") && j.includes("-metadata:s:s:1 language=spa") && j.includes("title=Spanish"));
  const noAudio = muxArgs({ list: "list.txt", subtitles: [{ file: "sub0.vtt", lang: "fr", name: "French" }], out: "out.mp4" });
  check("without audio the first subtitle input is index 1 and nothing is cut short", noAudio.join(" ").includes("-map 1:0") && !noAudio.includes("-shortest") && !noAudio.includes("-c:a"));
  check("an unknown language is tagged und", muxArgs({ list: "l", subtitles: [{ file: "s.vtt", lang: "xx", name: "X" }], out: "o.mp4" }).join(" ").includes("language=und"));
}

if (fails) process.exit(1);
console.log("all passed");
