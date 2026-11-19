// Phase 16.5: automatic emphasis (src/lib/emphasis.ts).
import { applyAutoEmphasis, isStopWord, suggestEmphasis } from "../src/lib/emphasis";
import { defaultProject, lineWords, type LyricLine, type Project } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}

const line = (id: string, text: string, start = 0, end = 3, extra: Partial<LyricLine> = {}): LyricLine => ({ id, text, start, end, ...extra });
const proj = (lines: LyricLine[]): Project => ({ ...defaultProject(), lines });
const picked = (l: LyricLine, p: Project) => Object.keys(suggestEmphasis(l, p)).map((k) => lineWords(l.text)[Number(k)]);

/* ---------- stop words ---------- */
check("stop words are recognised with punctuation and case", isStopWord("The") && isStopWord("don't") && isStopWord("you,") && !isStopWord("fire"));
const stops = line("s", "and the you I to of it is");
check("a line of stop words gets no emphasis", Object.keys(suggestEmphasis(stops, proj([stops]))).length === 0, suggestEmphasis(stops, proj([stops])));
const mixed = line("m", "I will never let you go tonight");
const pm = proj([mixed]);
check("stop words are never emphasised", picked(mixed, pm).every((w) => !isStopWord(w)), picked(mixed, pm));

/* ---------- held word wins ---------- */
const held = line("h", "I will love you forever", 0, 4, {
  words: [
    { text: "I", start: 0, end: 0.3 },
    { text: "will", start: 0.3, end: 0.6 },
    { text: "love", start: 0.6, end: 2.8 },
    { text: "you", start: 2.8, end: 3.1 },
    { text: "forever", start: 3.1, end: 3.5 },
  ],
});
const ph = proj([held]);
const sh = suggestEmphasis(held, ph);
check("a long held word gets the top level", sh[2] !== undefined && Object.values(sh).every((v) => v <= sh[2]), sh);
check("a word that clearly stands out gets level 3", sh[2] === 3, sh);
const even = line("e", "I will love you forever", 0, 4);
check("without timings the longer content word wins", suggestEmphasis(even, proj([even]))[4] !== undefined, suggestEmphasis(even, proj([even])));
check("word timings that do not match the words are ignored", JSON.stringify(suggestEmphasis({ ...held, words: held.words!.slice(0, 3) }, ph)) === JSON.stringify(suggestEmphasis(even, ph)));

/* ---------- hook words ---------- */
const hookLines = [
  line("a", "burning fire inside my heart"),
  line("b", "we are fire tonight"),
  line("c", "feel the fire running"),
  line("d", "dancing slowly through fire"),
];
const ph2 = proj(hookLines);
check("a hook word repeated across lines is emphasised", hookLines.every((l) => picked(l, ph2).includes("fire")), hookLines.map((l) => picked(l, ph2)));
const topOf = (l: LyricLine, p: Project) => { const s = suggestEmphasis(l, p); const best = Object.keys(s).sort((a, b) => s[Number(b)] - s[Number(a)] || Number(a) - Number(b))[0]; return lineWords(l.text)[Number(best)]; };
check("the repeats make the hook the top word", topOf(hookLines[0], ph2) === "fire" && topOf(hookLines[0], proj([hookLines[0]])) !== "fire", [topOf(hookLines[0], ph2), topOf(hookLines[0], proj([hookLines[0]]))]);

/* ---------- limits ---------- */
const long = line("long", "golden rivers carry silver stars beyond shining mountains forever dreaming");
const sl = suggestEmphasis(long, proj([long]));
check("at most one emphasised word per three words", Object.keys(sl).length <= Math.floor(lineWords(long.text).length / 3) && Object.keys(sl).length >= 1, sl);
check("never every word", Object.keys(sl).length < lineWords(long.text).length);
const short = line("short", "burning fire");
check("short lines get at most one", Object.keys(suggestEmphasis(short, proj([short]))).length === 1);
const one = line("one", "Fire!");
check("a one-word line gets none", Object.keys(suggestEmphasis(one, proj([one]))).length === 0);
check("only one word can be level 3", Object.values(sl).filter((v) => v === 3).length <= 1);

/* ---------- deterministic ---------- */
check("same input, same output", JSON.stringify(suggestEmphasis(long, proj([long]))) === JSON.stringify(suggestEmphasis({ ...long }, proj([{ ...long }]))));

/* ---------- applyAutoEmphasis ---------- */
const styled = line("x", "I will love you forever", 0, 4, {
  words: held.words,
  wordOverrides: { 0: { style: { color: "#ff0000" }, emphasis: 2 }, 4: { transform: { scale: 1.2 } } },
});
const other = line("y", "golden rivers carry silver stars", 4, 8, { wordOverrides: { 1: { emphasis: 1 } } });
const p0 = proj([styled, other]);
const p1 = applyAutoEmphasis(p0, ["x"]);
const x1 = p1.lines[0];
check("other override fields are kept", x1.wordOverrides?.[0]?.style?.color === "#ff0000" && x1.wordOverrides?.[4]?.transform?.scale === 1.2, x1.wordOverrides);
check("an earlier level on a stop word is cleared", x1.wordOverrides?.[0]?.emphasis === undefined, x1.wordOverrides);
check("the suggested level is written", x1.wordOverrides?.[2]?.emphasis === 3, x1.wordOverrides);
check("lines not listed are untouched", p1.lines[1] === other);
check("input project is not changed (pure)", p0.lines[0].wordOverrides?.[0]?.emphasis === 2 && !p0.lines[0].wordOverrides?.[2]);
const p2 = applyAutoEmphasis(p0);
check("without ids every line is done", p2.lines[1] !== other && Object.values(p2.lines[1].wordOverrides ?? {}).some((o) => o.emphasis));
check("a word whose only override was emphasis is dropped when cleared", (() => {
  const l = line("z", "and the you", 0, 3, { wordOverrides: { 1: { emphasis: 3 } } });
  return applyAutoEmphasis(proj([l])).lines[0].wordOverrides === undefined;
})());

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
