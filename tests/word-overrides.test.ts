// Phase 16.5 data model: word overrides survive text edits and round trips; beats are derived from beat markers.
import { defaultProject, lineWords, linesFromText, matchWords, retext, setWordOverride, useProject, type LyricLine } from "../src/store/project";
import { activeTimeline, beatsOf, docToView, viewToDoc } from "../src/model/convert";
import { loadDoc, serializeDoc } from "../src/model/migrate";
import type { ProjectDoc } from "../src/model/types";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}

/* ---------- words ---------- */
check("lineWords splits on any whitespace", JSON.stringify(lineWords("  hold  me\tclose ")) === '["hold","me","close"]', lineWords("  hold  me\tclose "));
check("matchWords pairs a fixed typo's neighbours", JSON.stringify(matchWords(["hold", "me", "clsoe"], ["hold", "me", "close"])) === "[[0,0],[1,1]]", matchWords(["hold", "me", "clsoe"], ["hold", "me", "close"]));
check("matchWords follows an inserted word", JSON.stringify(matchWords(["hold", "close"], ["hold", "me", "close"])) === "[[0,0],[1,2]]");
check("matchWords ignores case", matchWords(["Fire"], ["FIRE"]).length === 1);

const base: LyricLine = {
  id: "l1",
  text: "we are on fire",
  start: 1,
  end: 4,
  words: [
    { text: "we", start: 1, end: 1.5 },
    { text: "are", start: 1.5, end: 2 },
    { text: "on", start: 2, end: 2.5 },
    { text: "fire", start: 2.5, end: 4 },
  ],
  wordOverrides: { 3: { emphasis: 3 }, 0: { style: { color: "#ff0000" } } },
};

const inserted = retext(base, "oh we are on fire");
check("inserted word: overrides move with their words", inserted.wordOverrides?.[4]?.emphasis === 3 && inserted.wordOverrides?.[1]?.style?.color === "#ff0000" && !inserted.wordOverrides?.[3], inserted.wordOverrides);
check("inserted word: timings dropped (no longer 1:1)", inserted.words === undefined, inserted.words);

const recased = retext(base, "We Are On Fire");
check("recase: timings kept with new text", recased.words?.length === 4 && recased.words[3].text === "Fire" && recased.words[3].start === 2.5, recased.words);
check("recase: overrides kept", recased.wordOverrides?.[3]?.emphasis === 3);

const gone = retext(base, "something else");
check("all words replaced: overrides dropped", gone.wordOverrides === undefined, gone.wordOverrides);

const viaText = linesFromText("oh we are on fire", [base]);
check("linesFromText uses retext", viaText[0].wordOverrides?.[4]?.emphasis === 3 && viaText[0].id === "l1");

/* ---------- setWordOverride ---------- */
let l = setWordOverride(base, 2, { emphasis: 1, transform: { x: 0.1 } });
check("setWordOverride adds", l.wordOverrides?.[2]?.emphasis === 1 && l.wordOverrides?.[2]?.transform?.x === 0.1);
l = setWordOverride(l, 2, { emphasis: 0 });
check("emphasis 0 is removed, other fields kept", l.wordOverrides?.[2]?.emphasis === undefined && l.wordOverrides?.[2]?.transform?.x === 0.1, l.wordOverrides?.[2]);
l = setWordOverride(l, 2, { transform: undefined });
check("empty override dropped", !(2 in (l.wordOverrides ?? {})), l.wordOverrides);
let bare = setWordOverride({ ...base, wordOverrides: { 1: { emphasis: 2 } } }, 1, { emphasis: undefined });
check("last override removed drops the field", bare.wordOverrides === undefined, bare.wordOverrides);
check("setWordOverride is pure", base.wordOverrides?.[2] === undefined);

/* ---------- round trip ---------- */
const p = { ...defaultProject(), lines: [base] };
const doc = viewToDoc(p);
const clip = activeTimeline(doc).clips.find((c) => c.id === "l1");
check("wordOverrides stored on the text clip", clip?.text?.wordOverrides?.[3]?.emphasis === 3, clip?.text);
const back = docToView(doc);
check("wordOverrides back in the view", back.lines[0].wordOverrides?.[0]?.style?.color === "#ff0000", back.lines[0]);
const reloaded = loadDoc(serializeDoc(doc)).doc;
check("wordOverrides survive save and load", docToView(reloaded).lines[0].wordOverrides?.[3]?.emphasis === 3);
check("beat slot default present after load", docToView(reloaded).style.animation.beat?.name === "none", docToView(reloaded).style.animation);

/* ---------- beats derived from markers ---------- */
const tl = activeTimeline(doc);
const withBeats: ProjectDoc = {
  ...doc,
  timelines: doc.timelines.map((t) =>
    t.id === tl.id
      ? {
          ...t,
          markers: [
            { id: "b2", time: 1, name: "Beat", color: "#888", kind: "beat", strength: 0.5 },
            { id: "u1", time: 0.7, name: "Chorus", color: "#f00" },
            { id: "b1", time: 0.5, name: "Bar 1", color: "#888", kind: "beat", downbeat: true },
            { id: "c1", time: 0.9, name: "on clip", color: "#888", kind: "beat", clipId: "l1" },
          ],
        }
      : t
  ),
};
const beats = beatsOf(activeTimeline(withBeats));
check("beatsOf: only ruler beat markers, sorted", JSON.stringify(beats) === JSON.stringify([{ time: 0.5, downbeat: true, strength: 1 }, { time: 1, downbeat: false, strength: 0.5 }]), beats);
check("beatsOf is cached per markers array", beatsOf(activeTimeline(withBeats)) === beats);
const view = docToView(withBeats);
check("view carries beats", view.beats?.length === 2);
check("viewToDoc keeps markers (beats not written back)", activeTimeline(viewToDoc(view, withBeats)).markers.length === 4);
check("no beats: view.beats missing", docToView(doc).beats === undefined);

/* ---------- store ---------- */
const st = useProject.getState();
st.loadProject({ ...defaultProject(), lines: [{ id: "x", text: "light it up", start: 0, end: 2 }] });
st.selectWord({ lineId: "x", index: 1 });
check("selectWord selects the line too", useProject.getState().selectedLineId === "x" && useProject.getState().selectedWord?.index === 1);
st.updateWord("x", 1, { emphasis: 2 });
check("updateWord edits the word", useProject.getState().project.lines[0].wordOverrides?.[1]?.emphasis === 2);
st.undo();
check("updateWord is undoable", useProject.getState().project.lines[0].wordOverrides === undefined, useProject.getState().project.lines[0]);
st.select(null);
check("clearing the selection clears the word", useProject.getState().selectedWord === null);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
