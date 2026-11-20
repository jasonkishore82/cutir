// Phases 13 and 14 in the store: engine edits become one undoable operation each, and the lyric view keeps working.
import { useProject, defaultProject } from "../src/store/project";
import { activeTimeline, viewToDoc } from "../src/model/convert";
import * as E from "../src/timeline/engine";
import type { ProjectDoc } from "../src/model/types";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
}

const view = {
  ...defaultProject(),
  lines: [
    { id: "l1", text: "one", start: 0, end: 2, layerId: "main" },
    { id: "l2", text: "two", start: 2.5, end: 4, layerId: "main" },
  ],
};
const st = () => useProject.getState();
const tl = () => activeTimeline(st().doc);
const edit = (fn: (d: ProjectDoc) => ProjectDoc, key?: string) => st().editDoc(fn, key);

st().loadDoc(viewToDoc(view));

// a video track with two clips
edit((d) => E.onActive(d, (t) => {
  const r = E.addTrack(t, "video", "B-roll");
  return { ...r.tl, clips: [...r.tl.clips,
    { id: "v1", trackId: r.id, mediaId: "m", start: 0, duration: 3, sourceIn: 0, sourceOut: 3, speed: 1, enabled: true, effects: [], keyframes: {} },
    { id: "v2", trackId: r.id, mediaId: "m", start: 3, duration: 3, sourceIn: 3, sourceOut: 6, speed: 1, enabled: true, effects: [], keyframes: {} },
  ] };
}));
check("adding a track with clips is one operation", st().past.length === 1);
check("the lyric view is unchanged by video edits", st().project.lines.map((l) => l.text).join() === "one,two");

// one drag = many intermediate edits = one undo step
st().beginGesture();
for (let i = 1; i <= 20; i++) edit((d) => E.onActive(d, (t) => E.moveClips(t, ["v2"], 0.1)));
st().endGesture();
check("a whole drag is one undo step", st().past.length === 2);
check("the drag moved the clip", Math.abs(tl().clips.find((c) => c.id === "v2")!.start - 5) < 1e-6);
st().undo();
check("undo puts it back", tl().clips.find((c) => c.id === "v2")!.start === 3);
st().redo();

// nudges with the same key merge
edit((d) => E.onActive(d, (t) => E.moveClips(t, ["v1"], 0.04)), "nudge:v1");
edit((d) => E.onActive(d, (t) => E.moveClips(t, ["v1"], 0.04)), "nudge:v1");
check("repeated nudges merge into one step", st().past.length === 3);

// engine edits on subtitle clips are lyric edits
edit((d) => E.onActive(d, (t) => E.moveClips(t, ["l2"], 1)));
check("moving a subtitle clip moves the lyric line", st().project.lines.find((l) => l.id === "l2")!.start === 3.5);
st().undo();
check("and undo restores the line", st().project.lines.find((l) => l.id === "l2")!.start === 2.5);

// lyric edits keep the video track
st().updateLine("l1", { text: "uno" });
check("lyric edits keep video tracks and clips", tl().clips.some((c) => c.id === "v1") && tl().tracks.some((t) => t.name === "B-roll"));

// locked tracks
const vt = tl().tracks.find((t) => t.name === "B-roll")!.id;
edit((d) => E.onActive(d, (t) => E.setTrack(t, vt, { locked: true })));
const before = st().past.length;
edit((d) => E.onActive(d, (t) => E.rippleDelete(E.blade(E.moveClips(t, ["v1"], 2), 1), ["v1", "v2"])));
check("no edit changes a locked track", st().past.length === before && tl().clips.filter((c) => c.trackId === vt).length === 2);

// markers and range are undoable too
edit((d) => E.onActive(d, (t) => E.setRange(E.addMarker(t, 1, { name: "x" }).tl, 1, 2)));
check("markers and in/out are saved in the timeline", tl().markers.length === 1 && tl().inPoint === 1);
st().undo();
check("and undo removes them", tl().markers.length === 0 && tl().inPoint === undefined);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
