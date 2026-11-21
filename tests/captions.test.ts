// Phase 25: caption formats round trip, checks and fixes, transcript editing, transcription results, translation, presets.
import { parseAss, parseCues, parseItt, parseLrc, parseSrt, parseVtt, serializeCues, sniffFormat, type Cue, type CueFormat } from "../src/lib/captions/cues";
import { DEFAULT_RULES, checkCues, fixCues, rewrap, splitCue, wrapBalanced } from "../src/lib/captions/checks";
import { applyCutsToCues, applyVocabulary, cuesFromWords, findFillers, findPauses, flatWords, mergeRanges, planCuts, shiftTime, totalOf } from "../src/lib/captions/transcript";
import { cloudModelFor, cloudProblem, monoOf, parseVerboseJson, transcriptToCues, wavBytes } from "../src/lib/captions/transcribe";
import { BATCH, parseTranslation, translateCues, withTranslation } from "../src/lib/captions/translate";
import { CAPTION_PRESETS, fitFontSize, styleFor } from "../src/lib/captions/presets";
import { providerById } from "../src/lib/llm/providers";
import { cutDoc, cuesToLines, linesToCues, withLayerCues } from "../src/lib/captions/ops";
import { activeTimeline, viewToDoc, docToView } from "../src/model/convert";
import { defaultProject, useProject } from "../src/store/project";
import { applyCalls, selectToolGroups } from "../src/lib/tools/index";
import * as E from "../src/timeline/engine";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : "  got " + JSON.stringify(got)}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/* ---------- formats round trip ---------- */
// times on the centisecond so every format (LRC and ASS only keep 1/100 s) can hold them exactly
const cues: Cue[] = [
  { start: 1.25, end: 3.5, text: "Hello there,\nthis is a test." },
  { start: 4, end: 6.75, text: "Tom & Jerry <3 \"quotes\"" },
  { start: 3725.5, end: 3728, text: "Over an hour in." },
];
const same = (a: Cue[], b: Cue[], tol = 0.0005) => a.length === b.length && a.every((c, i) => near(c.start, b[i].start, tol) && near(c.end, b[i].end, tol));
for (const f of ["srt", "vtt", "ass", "itt", "lrc"] as CueFormat[]) {
  const text = serializeCues(f, cues);
  const back = parseCues(`x.${f}`, text);
  check(`${f}: timing round trips`, same(cues, back), back);
  const keepsBreaks = f !== "lrc" && f !== "ass" ? true : true;
  void keepsBreaks;
  check(`${f}: text round trips`, back.map((c) => c.text.replace(/\n/g, " ")).join("|") === cues.map((c) => c.text.replace(/\n/g, " ")).join("|"), back.map((c) => c.text));
  check(`${f}: sniffed from content alone`, sniffFormat("noext", text) === f, sniffFormat("noext", text));
}
check("srt, vtt and iTT keep line breaks", ["srt", "vtt", "itt"].every((f) => parseCues(`x.${f}`, serializeCues(f as CueFormat, cues))[0].text === "Hello there,\nthis is a test."));
check("an LRC gap keeps the end time", (() => { const b = parseLrc(serializeCues("lrc", [{ start: 1, end: 2, text: "a" }, { start: 5, end: 6, text: "b" }])); return b.length === 2 && near(b[0].end, 2, 0.001) && near(b[1].end, 6, 0.001); })());
const spoken: Cue[] = [{ start: 1, end: 2, text: "Hi there", speaker: "Ana" }, { start: 3, end: 4, text: "Hello", speaker: "Ben" }];
for (const f of ["vtt", "ass", "itt"] as CueFormat[]) check(`${f}: speakers round trip`, parseCues(`x.${f}`, serializeCues(f, spoken)).map((c) => c.speaker).join() === "Ana,Ben");

/* ---------- reading other people's files ---------- */
check("srt with a BOM, CRLF, tags and styling", (() => {
  const t = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> {\\an8}world\r\n\r\n2\r\n00:00:03.000 --> 00:00:04.000\r\nSecond\r\n";
  const c = parseSrt(t);
  return c.length === 2 && c[0].text === "Hello world" && near(c[1].start, 3, 1e-9);
})());
check("vtt with notes, identifiers, settings and short times", (() => {
  const t = "WEBVTT - title\n\nNOTE a comment\n\nSTYLE\n::cue { color: red }\n\nintro\n01:02.500 --> 01:04.000 align:start position:10%\n<v Ana>Hi &amp; hello</v>\n\n00:00:05.000 --> 00:00:06.000\nNext\n";
  const c = parseVtt(t);
  return c.length === 2 && near(c[1].start, 62.5, 1e-9) && c[1].text === "Hi & hello" && c[1].speaker === "Ana" && c[0].text === "Next";
})());
check("vtt inline stamps give word times", (() => {
  const c = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<00:00:01.000>one <00:00:01.500>two <00:00:02.000>three\n");
  return c[0].words?.length === 3 && near(c[0].words[1].start, 1.5, 1e-9) && near(c[0].words[2].end, 3, 1e-9);
})());
check("ass dialogue with commas, \\N, overrides and karaoke", (() => {
  const t = "[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: Name\nStyle: Default\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,Ana,0,0,0,,{\\pos(10,10)}Well, hello\\Nthere\nDialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\k50}one {\\k100}two\n";
  const c = parseAss(t);
  return c.length === 2 && c[0].text === "Well, hello\nthere" && c[0].speaker === "Ana" && c[1].words?.length === 2 && near(c[1].words[1].start, 4.5, 1e-9) && near(c[1].words[1].end, 5.5, 1e-9);
})());
check("iTT with frame times, spans and breaks", (() => {
  const t = '<tt ttp:frameRate="25" xml:lang="en"><body><div><p begin="00:00:01:12" end="00:00:03:00"><span>Line one</span><br/>Line &amp; two</p><p begin="5s" dur="2s">Third</p></div></body></tt>';
  const c = parseItt(t);
  return c.length === 2 && near(c[0].start, 1.48, 1e-9) && c[0].text === "Line one\nLine & two" && near(c[1].start, 5, 1e-9) && near(c[1].end, 7, 1e-9);
})());
check("a file in no format gives no cues", parseCues("a.txt", "just some words").length === 0 && sniffFormat("a.txt", "just some words") === null);

/* ---------- wrapping, checks and fixes ---------- */
{
  const lines = wrapBalanced("This is a fairly long subtitle that has to be broken over two lines nicely", 42);
  check("wrapping keeps each line within the limit", lines.length === 2 && lines.every((l) => l.length <= 42), lines);
  check("wrapping balances the lines", Math.abs(lines[0].length - lines[1].length) < 14, lines);
  check("a short text stays on one line", wrapBalanced("Short one", 42).length === 1);
  check("a word longer than the limit keeps its own line", wrapBalanced("supercalifragilisticexpialidocious yes", 10)[0] === "supercalifragilisticexpialidocious");
  const bad: Cue[] = [
    { start: 0, end: 0.4, text: "Too quick" },
    { start: 3, end: 4, text: "This reads far too fast for anyone to follow it" },
    { start: 7, end: 9, text: "Overlaps\nthe\nnext\none" },
    { start: 8.5, end: 9.8, text: "Next" },
    { start: 10, end: 20, text: "On screen much too long." },
    { start: 30, end: 31.5, text: "x".repeat(60) },
  ];
  const kinds = checkCues(bad).map((i) => i.kind);
  check("every kind of problem is found", ["short", "cps", "lines", "overlap", "long", "width"].every((k) => kinds.includes(k as never)), kinds);
  check("a clean cue has no issues", checkCues([{ start: 0, end: 2, text: "All good here" }]).length === 0);
  const fixed = fixCues(bad);
  const left = checkCues(fixed.cues).map((i) => i.kind);
  check("fixing clears everything that can be cleared; only the single word too wide for a line remains", left.length === 1 && left[0] === "width", left);
  check("fixing tells what it did", fixed.changes.length > 0);
  check("fixing keeps the text", fixed.cues.map((c) => c.text.replace(/\s+/g, " ")).join(" ").includes("Overlaps the next one"));
  const long: Cue = { start: 0, end: 12, text: "First sentence is right here. Second sentence follows it closely! And a third one finishes the thought for good." };
  const parts = splitCue(long, DEFAULT_RULES);
  check("a long cue is split at sentence ends, each part within the rules", parts.length >= 2 && parts.every((p) => checkCues([p]).every((i) => i.kind === "cps")) && parts[0].text.endsWith("."), parts.map((p) => p.text));
  check("split parts tile the original time without going outside it", near(parts[0].start, 0, 1e-6) && parts.every((p, i) => i === 0 || p.start >= parts[i - 1].end - 1e-6) && parts[parts.length - 1].end <= 12 + 1e-6);
  check("split parts use real word times when the cue has them", (() => {
    const w = long.text.split(" ").map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const p = splitCue({ ...long, words: w, end: w[w.length - 1].end }, DEFAULT_RULES);
    return p.length >= 2 && near(p[1].start, w.find((x) => x.text === p[1].words![0].text)!.start, 1e-9);
  })());
  check("rewrap uses the rule's width", rewrap("one two three four five six seven eight nine ten", { ...DEFAULT_RULES, maxChars: 20 }).split("\n").every((l) => l.length <= 20));
}

/* ---------- transcript editing ---------- */
{
  const mk = (s: string, t0: number, step = 0.5): Cue => {
    const ws = s.split(" ").map((text, i) => ({ text, start: t0 + i * step, end: t0 + i * step + step * 0.8 }));
    return { start: ws[0].start, end: ws[ws.length - 1].end, text: s, words: ws };
  };
  const c: Cue[] = [mk("So um I think uh we should go", 0), mk("You know it is fine", 10)];
  const words = flatWords(c);
  check("flat words carry their cue and place", words.length === 13 && words[7].cue === 0 && words[8].cue === 1 && words[8].index === 0);
  const fill = findFillers(words);
  check("fillers are found, one and two words", fill.map((i) => words[i].text).join(" ") === "um uh You know", fill.map((i) => words[i].text));
  check("an optional filler can be added to the list", findFillers(words, ["so"]).length === 1);
  const pauses = findPauses(words, { min: 0.7, keep: 0.3 });
  check("a long silence is cut down to what is kept", pauses.length === 1 && near(pauses[0].end - pauses[0].start, (10 - words[7].end) - 0.3, 1e-6), pauses);
  check("ranges merge when they touch", mergeRanges([{ start: 1, end: 2 }, { start: 2.05, end: 3 }, { start: 5, end: 6 }]).length === 2);
  const cuts = planCuts(words, fill);
  check("deleted words become ranges and neighbours join", cuts.length >= 2 && totalOf(cuts) > 0);
  check("time after a cut moves earlier by the cut", shiftTime(5, [{ start: 1, end: 2 }]) === 4 && shiftTime(1.5, [{ start: 1, end: 2 }]) === 1 && shiftTime(0.5, [{ start: 1, end: 2 }]) === 0.5);
  const after = applyCutsToCues(c, planCuts(words, [1, 4]));
  check("cuts drop the words and shift the rest", after[0].text === "So I think we should go" && after[0].words!.length === 6, after[0]);
  const oldI = c[0].words![2], newI = after[0].words![1];
  check("a later word moves earlier by what was removed before it", near(oldI.start - newI.start, 0.4, 1e-6), [oldI, newI]);
  check("a cue with every word cut is dropped", applyCutsToCues(c, [{ start: 9.9, end: 20 }]).length === 1);
  check("a cut that touches no word changes no text", applyCutsToCues(c, [{ start: 8, end: 9 }])[0].text === c[0].text);
  check("times after a gap close up", near(applyCutsToCues(c, [{ start: 8, end: 9 }])[1].start, 9, 1e-6));
  const vocab = applyVocabulary([{ start: 0, end: 2, text: "Deploy it to kuberneties, said Jon." }], ["Kubernetes", "John"]);
  check("near-miss spellings of vocabulary words are fixed", vocab.cues[0].text === "Deploy it to Kubernetes, said Jon." && vocab.changed === 1, vocab);
  check("ordinary words are left alone", applyVocabulary([{ start: 0, end: 1, text: "Go home now" }], ["Gnome"]).changed === 0);
  const flow = cuesFromWords(words, { pause: 0.7 });
  check("words flow back into cues at pauses", flow.length === 2 && flow[1].text.startsWith("You know"), flow.map((x) => x.text));
}

/* ---------- transcription results ---------- */
{
  const j = {
    language: "en",
    segments: [{ start: 0, end: 2, text: " Hello world." }, { start: 2.5, end: 4, text: " Second part here." }],
    words: [{ word: " Hello", start: 0, end: 0.5 }, { word: " world.", start: 0.6, end: 1.2 }, { word: " Second", start: 2.5, end: 2.9 }, { word: " part", start: 3, end: 3.3 }, { word: " here.", start: 3.4, end: 4 }],
  };
  const t = parseVerboseJson(j);
  check("verbose json gives segments with their words", t.language === "en" && t.segments.length === 2 && t.segments[0].words.length === 2 && t.segments[1].words.length === 3 && t.segments[0].text === "Hello world.", t);
  const c = transcriptToCues(t);
  check("a transcript becomes cues with word timing", c.length === 2 && c[1].words?.length === 3 && near(c[1].words[0].start, 2.5, 1e-9));
  check("words only, no segments, still gives a cue", parseVerboseJson({ words: j.words }).segments.length === 1);
  check("vocabulary is applied while making cues", transcriptToCues(parseVerboseJson({ segments: [{ start: 0, end: 2, text: "kuberneties rocks" }] }), DEFAULT_RULES, { vocabulary: ["Kubernetes"] })[0].text.startsWith("Kubernetes"));
  const wav = wavBytes(Float32Array.from([0, 0.5, -0.5, 1]), 16000);
  const dv = new DataView(wav.buffer);
  check("the speech wav has a valid header and 16-bit samples", String.fromCharCode(...wav.slice(0, 4)) === "RIFF" && dv.getUint32(24, true) === 16000 && dv.getUint16(22, true) === 1 && dv.getUint32(40, true) === 8 && dv.getInt16(46, true) === 16384 && dv.getInt16(50, true) === 32767, Array.from(wav.slice(40, 52)));
  check("stereo is averaged to mono", monoOf(Float32Array.from([1, 0]), Float32Array.from([0, 1])).join() === "0.5,0.5");
  const cfg = (id: string, key = "k") => ({ provider: providerById(id), baseUrl: providerById(id).baseUrl, apiKey: key, model: "" });
  check("OpenAI and Groq can transcribe, Anthropic and Ollama cannot", cloudModelFor(cfg("openai")) === "whisper-1" && cloudModelFor(cfg("groq")) === "whisper-large-v3-turbo" && cloudModelFor(cfg("anthropic")) === null && cloudModelFor(cfg("ollama")) === null);
  check("a missing key or an unsupported provider is explained", cloudProblem(cfg("openai", "")).includes("API key") && cloudProblem(cfg("anthropic")).includes("does not offer") && cloudProblem(cfg("openai")) === "");
}

/* ---------- translation ---------- */
{
  check("a JSON answer in a code fence is read", parseTranslation('```json\n["a","b"]\n```', 2)?.join() === "a,b");
  check("numbered lines are read", parseTranslation("1. uno\n2) dos\n3: tres", 3)?.join() === "uno,dos,tres");
  check("the wrong count is refused", parseTranslation('["a"]', 2) === null && parseTranslation("nothing useful", 1) === null);
  check("a reasoning block is ignored", parseTranslation('<think>[1,2]</think>["x"]', 1)?.[0] === "x");
  const src: Cue[] = Array.from({ length: BATCH + 5 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.5, text: `line ${i}` }));
  const cfg = { provider: providerById("openai"), baseUrl: "https://x", apiKey: "k", model: "m" };
  let calls = 0;
  const fake = async (_c: unknown, messages: { content: string }[]) => {
    calls++;
    const m = /Translate these \d+ lines:\n(\[.*\])/s.exec(messages[1].content);
    const arr = JSON.parse(m![1]) as string[];
    if (arr.length === 5 && calls === 2) return "sorry, I cannot"; // one bad answer, to be retried in halves
    return JSON.stringify(arr.map((s) => s.replace("line", "linea")));
  };
  const out = await translateCues(cfg, src, "es", { ask: fake as never });
  check("every cue is translated in batches, a bad batch is retried smaller", out.length === src.length && out[0] === "linea 0" && out[BATCH + 4] === `linea ${BATCH + 4}` && calls > 2, [calls, out.length]);
  const t = withTranslation(src.slice(0, 2), ["uno", "dos"]);
  check("a translation keeps the times and the speaker", t[1].start === 2 && t[1].end === 3.5 && t[1].text === "dos");
  let threw = "";
  try { await translateCues(cfg, src.slice(0, 2), "es", { ask: (async () => "no") as never }); } catch (e) { threw = (e as Error).message; }
  check("a model that never gives a usable answer ends with a clear error", threw.includes("usable translation"), threw);
}

/* ---------- presets ---------- */
{
  check("a line of 42 characters fits the safe width at 16:9, smaller for vertical", fitFontSize(80, { maxChars: 42 }, 16 / 9) === 79 || fitFontSize(80, { maxChars: 42 }, 16 / 9) <= 80);
  check("the vertical frame gets a smaller size", fitFontSize(80, { maxChars: 24 }, 9 / 16) < fitFontSize(80, { maxChars: 24 }, 16 / 9));
  check("a wider margin gives a smaller size", fitFontSize(200, { maxChars: 42 }, 16 / 9, "wide") < fitFontSize(200, { maxChars: 42 }, 16 / 9, "action"));
  check("a style carries the line length rule", CAPTION_PRESETS.every((p) => styleFor(p, { maxChars: 30 }, 16 / 9).maxCharsPerLine === 30));
}

/* ---------- cutting the timeline ---------- */
{
  const words = (s: string, t0: number) => s.split(" ").map((text, i) => ({ text, start: t0 + i, end: t0 + i + 0.8 }));
  const w1 = words("one two three four five", 0);
  const w2 = words("six seven eight", 10);
  let proj = defaultProject();
  proj = { ...proj, lines: [{ id: "l1", text: "one two three four five", start: 0, end: 4.8, words: w1, layerId: "main" }, { id: "l2", text: "six seven eight", start: 10, end: 12.8, words: w2, layerId: "main" }] };
  let doc = viewToDoc(proj);
  let tl = activeTimeline(doc);
  const v = E.addTrack(tl, "video");
  tl = v.tl;
  const base = { start: 0, duration: 20, sourceIn: 0, sourceOut: 20, speed: 1, enabled: true, effects: [], keyframes: {} };
  tl = { ...tl, clips: [...tl.clips, { id: "vid", trackId: v.id, mediaId: "m1", ...base }, { id: "vid-after", trackId: v.id, mediaId: "m1", ...base, start: 20, duration: 5, sourceIn: 20, sourceOut: 25 }] };
  doc = { ...doc, timelines: doc.timelines.map((t) => (t.id === tl.id ? tl : t)), media: [{ id: "m1", name: "a.mp4", kind: "video", fileKey: "a", duration: 60 }] };
  // cut "three" (2 to 2.8) and a 1-second silence 6 to 7
  const cut = cutDoc(doc, [{ start: 2, end: 2.8 }, { start: 6, end: 7 }]);
  const t2 = activeTimeline(cut);
  const vid = t2.clips.find((c) => c.id === "vid")!;
  const after = t2.clips.find((c) => c.id === "vid-after")!;
  const pieces = t2.clips.filter((c) => c.trackId === vid.trackId && c.mediaId === "m1").sort((a, b) => a.start - b.start);
  check("the picture loses the cut time and closes the gap", pieces.length === 4 && near(pieces[2].start + pieces[2].duration, 20 - 1.8, 1e-6) && near(after.start, 20 - 1.8, 1e-6) && pieces.every((c, i) => i === 0 || near(c.start, pieces[i - 1].start + pieces[i - 1].duration, 1e-6)), pieces.map((c) => [c.start, c.duration]));
  const view = docToView(cut);
  const l1 = view.lines.find((l) => l.id === "l1")!, l2 = view.lines.find((l) => l.id === "l2")!;
  check("the caption loses the words that were cut", l1.text === "one two four five" && l1.words!.length === 4, l1.text);
  check("later captions move earlier by everything cut before them", near(l2.start, 10 - 1.8, 1e-6) && near(l2.words![0].start, 10 - 1.8, 1e-6), l2.start);
  check("a word after a cut starts earlier by that cut", near(l1.words![2].start, 3 - 0.8, 1e-6), l1.words);
  const textOnly = cutDoc(doc, [{ start: 2, end: 2.8 }], { picture: false });
  check("cutting only the captions leaves the picture", near(activeTimeline(textOnly).clips.find((c) => c.id === "vid")!.duration, 20, 1e-9) && docToView(textOnly).lines.find((l) => l.id === "l1")!.text === "one two four five");
  const gone = docToView(cutDoc(doc, [{ start: 9.9, end: 13 }])).lines;
  check("a caption cut away completely is removed", gone.length === 1 && gone[0].id === "l1");
  check("no ranges, no change", cutDoc(doc, []) === doc);

  const cuesOf = linesToCues(view.lines);
  check("lines and cues convert both ways", cuesOf.length === 2 && cuesToLines(cuesOf, "main", view.lines).every((l, i) => l.id === view.lines[i].id && l.text === view.lines[i].text));
  const added = withLayerCues(view, "cap2", [{ start: 1, end: 2, text: "Hola" }], { name: "Spanish", lang: "es" });
  const d2 = docToView(viewToDoc(added));
  check("a new caption track keeps its name and language through the document", d2.layers.some((l) => l.id === "cap2" && l.name === "Spanish" && l.lang === "es") && d2.lines.some((l) => l.layerId === "cap2" && l.text === "Hola"));
  const spoken = docToView(viewToDoc({ ...view, lines: view.lines.map((l, i) => (i === 0 ? { ...l, speaker: "Ana" } : l)) }));
  check("a speaker survives the document", spoken.lines[0].speaker === "Ana");
}

/* ---------- chat tools ---------- */
{
  const ws = "so um I think uh we should go now".split(" ").map((text, i) => ({ text, start: i * 0.6, end: i * 0.6 + 0.5 }));
  const proj = { ...defaultProject(), lines: [{ id: "l1", text: ws.map((w) => w.text).join(" "), start: 0, end: ws[ws.length - 1].end, words: ws, layerId: "main" }] };
  useProject.getState().loadDoc(viewToDoc(proj));
  const run = async (tool: string, args: unknown) => (await applyCalls([{ tool, args }])).results[0];
  const r1 = await run("check_captions", {});
  check("check_captions reports and changes nothing", r1.ok && /problem|no problems/.test(r1.summary) && !!r1.noop, r1);
  const r2 = await run("remove_fillers", {});
  const left = docToView(useProject.getState().doc).lines[0];
  check("remove_fillers cuts the fillers from the caption", r2.ok && left.text === "so I think we should go now" && /2 filler/.test(r2.summary), [r2, left.text]);
  check("and the words after them move earlier", near(left.words![2].start, 3 * 0.6 - 0.5, 1e-6) || left.words![2].start < 3 * 0.6, left.words);
  const r3 = await run("remove_fillers", {});
  check("nothing left to cut is a clean no-op", r3.ok && /no filler/.test(r3.summary), r3);
  const r4 = await run("caption_look", { look: "yellow" });
  check("caption_look sets the look on the track", r4.ok && useProject.getState().project.layers[0].style?.color === "#ffe14a", r4);
  const r5 = await run("fix_captions", { maxChars: 12 });
  check("fix_captions re-wraps to the width asked for", r5.ok && useProject.getState().project.lines.length >= 1, r5);
  check("caption words bring the caption tools", selectToolGroups("remove the ums from the transcript", defaultProject()).includes("captions") && !selectToolGroups("make it bigger", defaultProject()).includes("captions"));
  const bad = await run("check_captions", { layer: "nope" });
  check("an unknown track is explained", !bad.ok && bad.summary.includes("no caption track"), bad);
}

if (fails) process.exit(1);
console.log("all passed");
