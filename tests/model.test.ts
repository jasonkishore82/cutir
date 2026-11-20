// Phase 11 checks: migration of every old project shape, round trips, operations and inverses, store undo/redo.
import { normalizeProject, useProject, type Project } from "../src/store/project";
import { docToView, viewToDoc, IDS } from "../src/model/convert";
import { loadDoc, serializeDoc, versionOf } from "../src/model/migrate";
import { applyPatches, makeOperation } from "../src/model/ops";
import type { ProjectDoc } from "../src/model/types";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${typeof got === "string" ? got : JSON.stringify(got)?.slice(0, 400)}`}`);
}
/** JSON with sorted keys and undefined dropped: "the same data" regardless of key order. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) : x));
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
const firstDiff = (a: unknown, b: unknown) => {
  const x = canon(a), y = canon(b);
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return `...${x.slice(Math.max(0, i - 60), i + 60)}\n   vs ...${y.slice(Math.max(0, i - 60), i + 60)}`;
};
const stripUrls = (p: Project): Project => JSON.parse(JSON.stringify(p, (k, v) => (k === "url" ? undefined : v)));

/* ---------- fixtures: projects as phases 1 to 10 saved them ---------- */
const FIXTURES: Record<string, unknown> = {
  "phase 1-5: one animation name, no layers": {
    audio: { name: "song.mp3", kind: "audio" },
    background: { type: "gradient", colors: ["#111111", "#444444"], angle: 90, noise: false },
    lines: [
      { id: "a", text: "first line", start: 0.5, end: 3.3 },
      { id: "b", text: "second line", start: 3.5, end: 6.1, words: [{ text: "second", start: 3.5, end: 4 }, { text: "line", start: 4, end: 6.1 }] },
    ],
    style: { fontFamily: "Permanent Marker", fontSize: 96, color: "#ffffff", uppercase: true, letterSpacing: 2, lineHeight: 1.2, maxCharsPerLine: 24, shadow: { blur: 12, offsetX: 0, offsetY: 4, opacity: 0.45 }, outline: { width: 0, color: "#000000" }, position: "center", animation: "pop", animationMs: 300 },
    aspect: "16:9",
    fps: 30,
  },
  "phase 3: typewriter, 9:16, image background": {
    audio: { name: "track.wav", kind: "audio", mediaId: "pool1" },
    background: { type: "asset", asset: { name: "bg.jpg", kind: "image", mediaId: "pool2" } },
    lines: [{ id: "x", text: "type me out", start: 1, end: 4 }],
    style: { animation: "typewriter", color: "#ff0000" },
    aspect: "9:16",
    fps: 60,
  },
  "phase 6-8: layers, overrides, slots": {
    background: { type: "asset", asset: { name: "loop.mp4", kind: "video" } },
    layers: [
      { id: "main", name: "Lyrics", visible: true, locked: false },
      { id: "tr", name: "Translation", visible: false, locked: true, style: { fontSize: 48, animation: "slide-up" } },
    ],
    lines: [
      { id: "1", text: "hola", start: 0, end: 2, layerId: "tr", styleOverride: { color: "#00ff00" } },
      { id: "2", text: "hello", start: 0, end: 2, layerId: "main", styleOverride: { transform: { x: 0.3, y: 0.2, rotation: 12 } } },
      { id: "3", text: "world", start: 2.2, end: 4.4, layerId: "main" },
    ],
    style: { animation: { in: { name: "fade", ms: 200, easing: "linear" }, out: { name: "zoom", ms: 300, easing: "ease-in" }, loop: { name: "float", speed: 2 } }, transform: { scale: 1.2, rotation: 0 } },
    aspect: "1:1",
    fps: 30,
  },
  "phase 9-10: keyframes, transitions, karaoke": {
    audio: { name: "song.mp3", kind: "audio" },
    background: { type: "gradient", colors: ["#1e2a6b", "#5b3a8c"], angle: 135, noise: true },
    layers: [{ id: "main", name: "Lyrics", visible: true, locked: false }],
    lines: [
      { id: "k1", text: "drift", start: 0, end: 3, layerId: "main", keyframes: [{ id: "f1", time: 0, props: { x: 0 }, easing: "ease-in-out" }, { id: "f2", time: 2, props: { x: 0.2, opacity: 0.5 }, easing: "linear" }], transition: { type: "zoom-through", ms: 600 } },
      { id: "k2", text: "sing", start: 3.1, end: 5, layerId: "main" },
    ],
    style: { animation: { in: { name: "word-highlight", ms: 0, easing: "linear" }, out: { name: "fade", ms: 200, easing: "linear" }, loop: { name: "none", speed: 1 } }, highlight: { tint: true, color: "#ffd84a", activeScale: 1.15 } },
    aspect: "16:9",
    fps: 30,
    transition: { type: "crossfade", ms: 400 },
  },
  "empty object": {},
  "half-written: only lines": { lines: [{ id: "q", text: "only", start: 0, end: 1 }] },
};

for (const [name, raw] of Object.entries(FIXTURES)) {
  const before = normalizeProject(JSON.parse(JSON.stringify(raw))); // what phases 1 to 10 showed
  const { doc, fromVersion } = loadDoc(JSON.parse(JSON.stringify(raw)));
  const view = docToView(doc);
  check(`${name}: detected as version 1`, fromVersion === 1 && versionOf(raw) === 1);
  check(`${name}: opens looking the same`, same(before, view), firstDiff(before, view));
  const again = loadDoc(serializeDoc(doc));
  check(`${name}: saves and reopens the same`, again.fromVersion === 2 && same(stripUrls(view), docToView(again.doc)), firstDiff(stripUrls(view), docToView(again.doc)));
  check(`${name}: lines are subtitle clips, layers subtitle tracks`, doc.timelines[0].clips.filter((c) => c.text).length === view.lines.length && doc.timelines[0].tracks.filter((t) => t.kind === "subtitle").length === view.layers.length);
}

// specific mappings
const { doc: d1 } = loadDoc(FIXTURES["phase 1-5: one animation name, no layers"]);
const tl1 = d1.timelines[0];
check("song becomes an audio clip on an audio track", tl1.clips.some((c) => c.id === IDS.audioClip && c.mediaId === IDS.audioMedia) && tl1.tracks.some((t) => t.id === IDS.audioTrack && t.kind === "audio"));
check("gradient background becomes a generator clip on a video track", !!tl1.clips.find((c) => c.id === IDS.bgClip)?.generator && tl1.tracks[0].kind === "video");
const { doc: d2 } = loadDoc(FIXTURES["phase 3: typewriter, 9:16, image background"]);
check("image background becomes a media clip", d2.timelines[0].clips.find((c) => c.id === IDS.bgClip)?.mediaId === IDS.bgMedia && d2.media.some((m) => m.kind === "image" && m.poolId === "pool2"));
check("settings hold aspect, size and frame rate", d2.settings.aspect === "9:16" && d2.settings.width === 1080 && d2.settings.height === 1920 && d2.settings.fps === 60);
check("session URLs are never saved", !serializeDoc({ ...d2, media: d2.media.map((m) => ({ ...m, url: "blob:x" })) }).includes("blob:x"));
let threw = "";
try {
  loadDoc({ ...d2, schemaVersion: 99 });
} catch (e) {
  threw = (e as Error).message;
}
check("a file from a newer Cutir is refused with a message", /newer version/.test(threw), threw);

/* ---------- several track kinds in one timeline, kept through lyric edits ---------- */
const multi: ProjectDoc = JSON.parse(JSON.stringify(d1));
const tl = multi.timelines[0];
tl.tracks.push({ id: "v2", kind: "video", name: "B-roll", muted: false, locked: false, solo: false, height: 44, hidden: false }, { id: "a2", kind: "audio", name: "Voice-over", muted: true, locked: false, solo: false, height: 56, hidden: false });
tl.clips.push(
  { id: "broll", trackId: "v2", mediaId: "m-x", start: 2, duration: 3, sourceIn: 1, sourceOut: 4, speed: 1, enabled: true, effects: [], keyframes: {} },
  { id: "vo", trackId: "a2", mediaId: "m-y", start: 0, duration: 5, sourceIn: 0, sourceOut: 5, speed: 1, enabled: true, effects: [], keyframes: {} }
);
tl.markers.push({ id: "mk", time: 1, name: "chorus", color: "#ff0" });
multi.media.push({ id: "m-x", name: "x.mp4", kind: "video", fileKey: "m-x" }, { id: "m-y", name: "y.wav", kind: "audio", fileKey: "m-y" });
multi.timelines.push({ ...JSON.parse(JSON.stringify(tl)), id: "tl-2", name: "Alt cut" });
const v = docToView(multi);
const edited = viewToDoc({ ...v, lines: [...v.lines, { id: "new", text: "added", start: 7, end: 8, layerId: v.layers[0].id }], style: { ...v.style, color: "#123456" } }, multi);
const etl = edited.timelines.find((t) => t.id === tl.id)!;
check("a timeline holds video, audio and subtitle tracks", new Set(etl.tracks.map((t) => t.kind)).size === 3 && etl.tracks.length === 5, etl.tracks.map((t) => t.id));
check("lyric edits keep other tracks and their clips", etl.clips.some((c) => c.id === "broll") && etl.clips.some((c) => c.id === "vo") && etl.tracks.some((t) => t.id === "a2" && t.muted));
check("lyric edits keep markers, media and other timelines", etl.markers.length === 1 && edited.media.some((m) => m.id === "m-x") && edited.timelines.some((t) => t.id === "tl-2"));
check("the edit itself landed", docToView(edited).lines.some((l) => l.id === "new") && docToView(edited).style.color === "#123456");

/* ---------- operations ---------- */
const base = docToView(loadDoc(FIXTURES["phase 6-8: layers, overrides, slots"]).doc);
const edits: [string, (p: Project) => Project][] = [
  ["add a line", (p) => ({ ...p, lines: [...p.lines, { id: "n", text: "new", start: 9, end: 10, layerId: "main" }] })],
  ["delete a line", (p) => ({ ...p, lines: p.lines.filter((l) => l.id !== "2") })],
  ["move a line", (p) => ({ ...p, lines: p.lines.map((l) => (l.id === "3" ? { ...l, start: 5, end: 7.3 } : l)) })],
  ["restyle", (p) => ({ ...p, style: { ...p.style, fontSize: 120, shadow: { ...p.style.shadow, blur: 3 } } })],
  ["remove a line override", (p) => ({ ...p, lines: p.lines.map((l) => (l.id === "1" ? { ...l, styleOverride: undefined } : l)) })],
  ["reorder layers", (p) => ({ ...p, layers: [...p.layers].reverse() })],
  ["add keyframes", (p) => ({ ...p, lines: p.lines.map((l) => (l.id === "3" ? { ...l, keyframes: [{ id: "z", time: 1, props: { y: -0.1 }, easing: "back" as const }] } : l)) })],
  ["switch background", (p) => ({ ...p, background: { type: "gradient", colors: ["#000000", "#ffffff"], angle: 10, noise: false } })],
  ["add the song", (p) => ({ ...p, audio: { name: "new.mp3", kind: "audio", url: "blob:z" } })],
];
const docA = viewToDoc(base);
for (const [name, fn] of edits) {
  const docB = viewToDoc(fn(base), docA);
  const op = makeOperation(docA, docB)!;
  const fwd = applyPatches(docA, op.patches);
  const back = applyPatches(fwd, op.inverse);
  const viaJson = applyPatches(docA, JSON.parse(JSON.stringify(op)).patches);
  check(`op "${name}": applies, inverts, is plain data`, same(fwd, docB) && same(back, docA) && same(viaJson, docB), firstDiff(fwd, docB));
}
const small = makeOperation(docA, viewToDoc({ ...base, lines: base.lines.map((l) => (l.id === "3" ? { ...l, text: "changed" } : l)) }, docA))!;
check("a one-field edit is a one-patch operation", small.patches.length === 1 && small.inverse.length === 1, small);
const shared = applyPatches(docA, small.patches);
check("unchanged parts are shared, not copied", shared.timelines[0].tracks === docA.timelines[0].tracks && shared.timelines[0].clips[0] === docA.timelines[0].clips[0] && shared.media === docA.media);

/* ---------- the store: undo and redo replay operations ---------- */
const st = useProject.getState();
st.loadDoc(docA);
st.updateLine("3", { text: "one" });
st.updateLine("3", { text: "two" });
st.update((p) => ({ ...p, style: { ...p.style, fontSize: 70 } }), "size");
st.update((p) => ({ ...p, style: { ...p.style, fontSize: 71 } }), "size"); // coalesces with the step above
let s = useProject.getState();
check("history holds operations, not projects", s.past.length === 3 && s.past.every((o) => Array.isArray(o.patches) && Array.isArray(o.inverse) && !("lines" in o)), s.past.length);
check("coalesced slider steps make one operation", s.project.style.fontSize === 71);
s.undo();
check("undo the coalesced step", useProject.getState().project.style.fontSize === base.style.fontSize, useProject.getState().project.style.fontSize);
useProject.getState().undo();
check("undo a line edit", useProject.getState().project.lines.find((l) => l.id === "3")?.text === "one");
useProject.getState().redo();
useProject.getState().redo();
s = useProject.getState();
check("redo both", s.project.lines.find((l) => l.id === "3")?.text === "two" && s.project.style.fontSize === 71);
s.batch(() => {
  s.updateLine("1", { text: "a" });
  s.updateLine("2", { text: "b" });
});
check("a batch is one operation", useProject.getState().past.length === 4);
useProject.getState().undo();
s = useProject.getState();
check("undoing a batch restores both", s.project.lines.find((l) => l.id === "1")?.text === "hola" && s.project.lines.find((l) => l.id === "2")?.text === "hello");
check("view and document stay in step after undo/redo", same(s.project, docToView(s.doc)));
while (useProject.getState().past.length) useProject.getState().undo();
check("undo all returns to the opened project", same(useProject.getState().doc, docA));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
