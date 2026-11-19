// Phase 15.5: timeline tools (src/lib/tools/timeline.ts) through applyCalls, as MCP and the in-app chat use them.
import { applyCalls, buildSystemPrompt, selectToolGroups } from "../src/lib/tools/index";
import { useProject, defaultProject } from "../src/store/project";
import { useMedia } from "../src/store/media";
import { activeTimeline, viewToDoc } from "../src/model/convert";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}
const st = () => useProject.getState();
const tl = () => activeTimeline(st().doc);
const run = async (tool: string, args: unknown) => (await applyCalls([{ tool, args }])).results[0];

st().loadDoc(viewToDoc({ ...defaultProject(), lines: [{ id: "l1", text: "hi", start: 0, end: 2, layerId: "main" }] }));
useMedia.setState({
  projectId: "p",
  items: [
    { id: "v1", name: "Beach.mp4", kind: "video", mime: "video/mp4", size: 1, lastModified: 0, addedAt: 0, duration: 20, width: 1920, height: 1080, hasAudio: true },
    { id: "a1", name: "drums.wav", kind: "audio", mime: "audio/wav", size: 1, lastModified: 0, addedAt: 0, duration: 8 },
    { id: "f1", name: "font.ttf", kind: "font", mime: "", size: 1, lastModified: 0, addedAt: 0 },
  ],
});

// tracks first: a video and an audio track to edit on
check("add_track video", (await run("add_track", { kind: "video", name: "B-roll" })).ok);
check("add_track audio", (await run("add_track", { kind: "audio", name: "FX" })).ok);
const before = st().past.length;
const r1 = await run("add_clip", { media: "beach", at: 2, out: 6 });
check("add_clip finds media by partial name and places it (source 0-6 s)", r1.ok && tl().clips.some((c) => c.name === "Beach.mp4" && c.start === 2 && c.duration === 6), r1);
check("one tool call is one undo step", st().past.length === before + 1);
check("a video with sound gets linked sound on the audio target", (() => {
  const pics = tl().clips.filter((c) => c.name === "Beach.mp4");
  return pics.length === 2 && pics[0].linkId && pics[0].linkId === pics[1].linkId;
})());
check("the media is registered in the document", st().doc.media.some((m) => m.poolId === "v1" && m.duration === 20));
const vid = tl().clips.find((c) => c.name === "Beach.mp4" && tl().tracks.find((t) => t.id === c.trackId)?.kind === "video")!;
check("and its sound on the FX track, not the song track", tl().clips.some((c) => c.linkId === vid.linkId && tl().tracks.find((t) => t.id === c.trackId)!.name === "FX"));

check("add_clip to a named track", (await run("add_clip", { media: "drums.wav", track: "FX", at: 0 })).ok && tl().clips.some((c) => c.name === "drums.wav" && tl().tracks.find((t) => t.id === c.trackId)?.name === "FX"));
check("add_clip rejects fonts", !(await run("add_clip", { media: "font.ttf" })).ok);
const unknown = await run("add_clip", { media: "nothing-like-this" });
check("unknown media lists the library", !unknown.ok && unknown.summary.includes("Beach.mp4"), unknown.summary);
const wrongKind = await run("add_clip", { media: "drums.wav", track: "B-roll" });
check("audio cannot go on a video track", !wrongKind.ok && wrongKind.summary.includes("audio track"), wrongKind.summary);

check("trim_clip to a time", (await run("trim_clip", { clip: vid.id, edge: "end", to: 5 })).ok && tl().clips.find((c) => c.id === vid.id)!.duration === 3);
check("without a target the clip went on the B-roll track", tl().tracks.find((t) => t.id === vid.trackId)!.name === "B-roll");
check("move_clips to a time (linked sound follows)", (await run("move_clips", { clips: vid.id, to: 10 })).ok && tl().clips.filter((c) => c.linkId === vid.linkId).every((c) => c.start === 10));
check("set_clip places a clip in the frame", (await run("set_clip", { clips: [vid.id], x: 25, y: 75, scale: 0.5, blend: "screen" })).ok && tl().clips.find((c) => c.id === vid.id)!.transform?.x === 0.25);
check("cut_at cuts under a time", (await run("cut_at", { time: 11 })).ok && tl().clips.filter((c) => c.name === "Beach.mp4" && c.trackId === vid.trackId).length === 2); // its sound was replaced by drums.wav above
const missing = await run("delete_clips", { clips: ["nope"] });
check("unknown clip ids are reported", !missing.ok && missing.summary.includes("nope"));
check("set_track mutes by name", (await run("set_track", { track: "FX", muted: true })).ok && tl().tracks.find((t) => t.name === "FX")!.muted);
check("set_track locks, and locked clips stay put", (await run("set_track", { track: "B-roll", locked: true })).ok && !(await run("move_clips", { clips: vid.id, by: 1 })).ok);
check("add_marker and set_range", (await run("add_marker", { time: 3, name: "drop" })).ok && (await run("set_range", { in: 1, out: 4 })).ok && tl().markers.length === 1 && tl().inPoint === 1);
check("the lyric line is untouched by all of this", st().project.lines.length === 1 && st().project.lines[0].text === "hi");

check("clip requests route to the timeline tools", selectToolGroups("put the beach video on the timeline", st().project).includes("timeline"));
const prompt = buildSystemPrompt(st().project, false, ["style", "timeline"]);
check("the chat prompt lists clips and the library when timeline tools are offered", prompt.includes("CLIPS (id") && prompt.includes(vid.id) && prompt.includes("Beach.mp4"));
check("and leaves them out otherwise", !buildSystemPrompt(st().project, false, ["style"]).includes("CLIPS (id"));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
