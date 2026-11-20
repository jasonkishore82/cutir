// Kinetic rendering (phase 16.5): beat reactions, energy, Fx colour terms and the word-by-word layout.
import {
  BEATS, BEAT_NAMES, IDENTITY, LOOPS, beatFxAt, combineFx, energyAt, energyClock, energyFactor, nearestBeatBefore, scaleFx, scaleLoop, toFx,
} from "../src/lib/animations";
import { hasWordOverrides, mixColor, placeWords, resolveWordStyle, wordLook, wrapText, wrapWords } from "../src/lib/renderer";
import { DEFAULT_STYLE, defaultProject, lineWords, type Beat, type BeatName, type LyricLine } from "../src/store/project";

let fails = 0;
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- Fx ---------- */

check("IDENTITY has rest flash and swap", IDENTITY.flash === 0 && IDENTITY.swap === 0);
check("toFx({}) is IDENTITY", same(toFx({}), IDENTITY));
check("combine with IDENTITY leaves Fx unchanged", same(combineFx(toFx({ dx: 0.1, scale: 1.2, flash: 0.3, swap: 0.4 }), IDENTITY), toFx({ dx: 0.1, scale: 1.2, flash: 0.3, swap: 0.4 })));
const c = combineFx(toFx({ flash: 0.3, swap: 0.8 }), toFx({ flash: 0.6, swap: 0.2 }));
check("combineFx takes the max of flash and swap", c.flash === 0.6 && c.swap === 0.8, c);
check("scaleFx by 1 is unchanged", same(scaleFx({ dx: 0.2, scale: 1.1 }, 1), { dx: 0.2, scale: 1.1 }));
check("scaleFx scales offsets and scale around 1", near(scaleFx({ dx: 0.2, scale: 1.1 }, 2).dx!, 0.4) && near(scaleFx({ dx: 0.2, scale: 1.1 }, 2).scale!, 1.2));
check("scaleLoop by 1 is the same object", (() => { const p = { glow: 0.5 }; return scaleLoop(p, 1) === p; })());
check("loops untouched at energy 0", same(scaleLoop(LOOPS.pulse.fx(0.3, 1), energyFactor(0, 0.9)), LOOPS.pulse.fx(0.3, 1)));

/* ---------- beats ---------- */

check("BEAT_NAMES lists every effect", same(BEAT_NAMES, ["none", "pulse", "flash", "shake", "nudge", "colour-swap", "jump-cut"]));
check("none does nothing", same(BEATS.none.fx(0, 1, 0), {}));
const decaying: BeatName[] = ["pulse", "flash", "shake", "nudge", "colour-swap"];
const dev = (p: Partial<ReturnType<typeof toFx>>) => {
  const f = toFx(p);
  return Math.abs(f.dx) + Math.abs(f.dy) + Math.abs(f.scale - 1) + Math.abs(f.rotation) / 10 + f.flash + f.swap;
};
for (const n of decaying) {
  const at0 = dev(BEATS[n].fx(0.001, 1, 0));
  const mid = dev(BEATS[n].fx(0.08, 1, 0));
  const late = dev(BEATS[n].fx(0.5, 1, 0));
  check(`${n} reacts on the beat`, at0 > 0, at0);
  check(`${n} has died out after 0.5 s`, late === 0, late);
  check(`${n} is weaker on a soft hit`, dev(BEATS[n].fx(0.001, 0.3, 0)) < at0);
  if (n !== "shake") check(`${n} decays`, mid < at0, [at0, mid]);
}
check("pulse scales up on the beat", BEATS.pulse.fx(0, 1, 0).scale! > 1.05);
check("flash is bounded to 1", BEATS.flash.fx(0, 5, 0).flash! <= 1);
check("nudge alternates direction", Math.sign(BEATS.nudge.fx(0.01, 1, 0).dx!) === -Math.sign(BEATS.nudge.fx(0.01, 1, 1).dx!));
check("jump cut holds (no decay)", same(BEATS["jump-cut"].fx(0.01, 1, 1), BEATS["jump-cut"].fx(3, 1, 1)));
check("jump cut changes framing per beat", !same(BEATS["jump-cut"].fx(0, 1, 1), BEATS["jump-cut"].fx(0, 1, 2)));

const beats: Beat[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((time, i) => ({ time, downbeat: i % 4 === 0, strength: i % 2 ? 0.5 : 1 }));
check("nearest before the first beat is null", nearestBeatBefore(beats, -0.1) === null);
check("no beats -> null", nearestBeatBefore([], 1) === null && nearestBeatBefore(undefined, 1) === null);
check("exactly on a beat picks it", nearestBeatBefore(beats, 1.5)?.index === 3);
check("between beats picks the earlier", nearestBeatBefore(beats, 1.74)?.beat.time === 1.5);
check("after the last beat picks the last", nearestBeatBefore(beats, 99)?.index === 7);
check("downbeats only: latest downbeat", nearestBeatBefore(beats, 3.2, true)?.beat.time === 2);
check("downbeats only: index counts downbeats", nearestBeatBefore(beats, 3.2, true)?.index === 1);
check("downbeats only, none yet", nearestBeatBefore([{ time: 0, downbeat: false, strength: 1 }], 1, true) === null);

const slot = { name: "pulse" as const, strength: 1, downbeatsOnly: false };
check("no beats -> no reaction", same(beatFxAt(undefined, slot, 1), {}) && same(beatFxAt([], slot, 1), {}));
check("no slot -> no reaction", same(beatFxAt(beats, undefined, 1), {}));
const big = beatFxAt(beats, slot, 1.01).scale! - 1; // beat at 1 has strength 1
const soft = beatFxAt(beats, slot, 1.51).scale! - 1; // beat at 1.5 has strength 0.5
check("big hits react more than soft ones", big > soft && soft > 0, [big, soft]);
check("slot strength scales the hit", beatFxAt(beats, { ...slot, strength: 2 }, 1.01).scale! - 1 > big);
check("downbeatsOnly ignores off-beats", near(beatFxAt(beats, { ...slot, downbeatsOnly: true }, 1.01).scale ?? 1, 1));

/* ---------- energy ---------- */

const curve = { rate: 2, values: [0, 1, 0.5] }; // 0 s, 0.5 s, 1 s
check("energyAt interpolates", near(energyAt(curve, 0.25), 0.5) && near(energyAt(curve, 0.75), 0.75));
check("energyAt clamps at the ends", energyAt(curve, -1) === 0 && energyAt(curve, 9) === 0.5);
check("energyAt without a curve is 0", energyAt(undefined, 1) === 0 && energyAt({ rate: 10, values: [] }, 1) === 0);
check("energy factor is 1 at amount 0", energyFactor(0, 0) === 1 && energyFactor(0, 1) === 1);
check("energy factor at amount 1 spans 0.4..1.6", near(energyFactor(1, 0), 0.4) && near(energyFactor(1, 1), 1.6));
check("energy clock at amount 0 is plain time", energyClock(curve, 0, 0.2, 1.7) === 1.5);
check("energy clock runs fast in loud parts", energyClock({ rate: 1, values: [1, 1] }, 1, 0, 1) > 1.5);
const loud = beatFxAt(beats, slot, 1.01, { rate: 1, values: [1, 1, 1, 1] }, 1).scale! - 1;
const quiet = beatFxAt(beats, slot, 1.01, { rate: 1, values: [0, 0, 0, 0] }, 1).scale! - 1;
check("energy makes loud sections hit harder", loud > big && big > quiet, [quiet, big, loud]);

/* ---------- words ---------- */

const ws = (s: string) => s.split(" ");
for (const text of ["hello world", "one two three four five six seven", "a much longer lyric line that wraps onto two rows"]) {
  const words = ws(text);
  const rows = wrapWords(words, words.map(() => 1), 24);
  const ref = wrapText(text, 24).map((r) => r.split(" ").length);
  check(`wrapWords with weight 1 matches wrapText: "${text}"`, same(rows, ref), [rows, ref]);
}
const ww = ws("tell me why you are so quiet");
check("a heavy word changes where the line breaks", !same(wrapWords(ww, ww.map((_, i) => (i === 6 ? 3 : 1)), 24), wrapWords(ww, ww.map(() => 1), 24)));

// measure: 10 px per character at 100 px font, so a 2x word is twice as wide
const items = (words: string[], sizes: number[]) => words.map((t, i) => ({ w: t.length * sizes[i] * 0.1, fontPx: sizes[i] }));
const flat = placeWords(items(["ab", "cd", "ef"], [100, 100, 100]), [3], 10, 1.2);
check("rows are centred on their real width", near(flat.width, 80) && near(flat.words[0].x, -40) && near(flat.words[2].x + flat.words[2].w, 40), flat);
check("plain row height = font x line height", near(flat.height, 120));
const emph = placeWords(items(["ab", "cd", "ef"], [100, 200, 100]), [3], 10, 1.2);
check("emphasis widens the row", near(emph.width, 100), emph.width);
check("row height = tallest word", near(emph.height, 240), emph.height);
const two = placeWords(items(["a", "bb", "ccc", "dd"], [100, 100, 200, 100]), [2, 2], 10, 1.2);
check("words map to rows in order", same(two.words.map((x) => x.row), [0, 0, 1, 1]));
check("each row is centred on its own width", near(two.words[0].x, -(10 + 10 + 20) / 2) && near(two.words[2].x, -(60 + 10 + 20) / 2), two.words);
check("rows stack by their own heights", near(two.height, 120 + 240) && near(two.words[0].y, -180 + 60) && near(two.words[2].y, -180 + 120 + 120), two.words);

const project = defaultProject();
const line: LyricLine = { id: "L", text: "we are the champions", start: 0, end: 4 };
check("a plain line has no word overrides", !hasWordOverrides(line) && !hasWordOverrides({ ...line, wordOverrides: { 1: {} } }));
const styled: LyricLine = { ...line, wordOverrides: { 1: { style: { color: "#ff0000" } }, 3: { emphasis: 3 } } };
check("a styled word counts as an override", hasWordOverrides(styled));
check("resolveWordStyle lays the word style over the line", resolveWordStyle(project, styled, 1).color === "#ff0000" && resolveWordStyle(project, styled, 1).fontSize === DEFAULT_STYLE.fontSize);
check("resolveWordStyle without an override is the line style", resolveWordStyle(project, styled, 0).color === DEFAULT_STYLE.color);
const champ = wordLook(project, styled, 3);
check("emphasis 3 enlarges, bolds and colours", near(champ.style.fontSize, DEFAULT_STYLE.fontSize * 2) && champ.bold && champ.style.color === "#ffd84a", champ);
check("word look text follows uppercase and lineWords", champ.text === lineWords(line.text)[3].toUpperCase());
const own = wordLook(project, { ...line, wordOverrides: { 0: { emphasis: 3, style: { color: "#00ff00" } } } }, 0);
check("a word's own colour beats the emphasis colour", own.style.color === "#00ff00");

check("mixColor ends", mixColor("#000000", "#ffffff", 0) === "#000000" && mixColor("#000", "#fff", 1) === "#fff");
check("mixColor halfway", mixColor("#000000", "#ffffff", 0.5) === "rgb(128,128,128)", mixColor("#000000", "#ffffff", 0.5));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
