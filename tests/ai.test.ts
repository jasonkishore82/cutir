// Phase 28: AI across the editor. Silence finding, scene cuts, moments, timeline context for the prompt, tool routing,
// held (destructive) edits, the request log and macros. Heavy browser parts (decoding, frame sampling) are not run here.
import { applyCalls, buildSystemPrompt, registry, selectToolGroups } from "../src/lib/tools/index";
import { useProject, defaultProject } from "../src/store/project";
import { useMedia } from "../src/store/media";
import { useTimelineUi } from "../src/timeline/ui";
import { activeTimeline, viewToDoc } from "../src/model/convert";
import * as E from "../src/timeline/engine";
import { LEVEL_RATE, autoThreshold, findSilences, levelsOf, planSilenceCuts, timelineLevels, type Levels } from "../src/lib/ai/silence";
import { detectCuts, frameDiff, sceneTimes } from "../src/lib/ai/scenes";
import { findMoments } from "../src/lib/ai/moments";
import { timelineContext } from "../src/lib/ai/context";
import { askText, heldCalls, holdReason } from "../src/lib/ai/safety";
import { describeStep, groupSteps, macrosFromJson, macrosToJson, sanitizeMacro } from "../src/lib/ai/macroData";
import { playMacro, missingSteps } from "../src/lib/ai/playMacro";
import { useMacros } from "../src/store/macros";
import { hostOf, summarize, useAiLog } from "../src/store/aiLog";
import { streamChat } from "../src/lib/llm";
import { providerById } from "../src/lib/llm/providers";
import { cutDoc } from "../src/lib/captions/ops";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}
const st = () => useProject.getState();
const tl = () => activeTimeline(st().doc);
const run = async (tool: string, args: unknown) => (await applyCalls([{ tool, args }])).results[0];
const near = (a: number, b: number, eps = 0.06) => Math.abs(a - b) <= eps;

/* ---------- silence ---------- */
{
  const sr = 8000;
  // 0-2 s tone, 2-3.2 s silence, 3.2-6 s tone, 6-6.3 s silence (too short to cut), 6.3-8 s tone
  const s = new Float32Array(sr * 8);
  for (let i = 0; i < s.length; i++) {
    const t = i / sr;
    const quiet = (t >= 2 && t < 3.2) || (t >= 6 && t < 6.3);
    s[i] = quiet ? 0.0005 * Math.sin(i) : 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
  }
  const db = levelsOf(s, sr);
  check("levels: 50 windows a second", db.length === 8 * LEVEL_RATE, db.length);
  check("levels: tone is loud, room noise is quiet", db[10] > -20 && db[110] < -55, [db[10], db[110]]);
  check("levels: digital silence is -Infinity", levelsOf(new Float32Array(1600), 8000)[0] === -Infinity);
  const thr = autoThreshold(db);
  check("threshold sits between noise and speech", thr > -60 && thr < -25, thr);
  const cuts = findSilences(db, { minLen: 0.5, keep: 0.1 });
  check("one pause longer than half a second", cuts.length === 1, cuts);
  check("the pause is trimmed by `keep` so words are not clipped", near(cuts[0].start, 2.05) && near(cuts[0].end, 3.15), cuts);
  check("a shorter minLen finds the short pause too", findSilences(db, { minLen: 0.2, keep: 0.1 }).length === 2);
  check("a pause shorter than keep leaves nothing to cut", findSilences(db, { minLen: 0.1, keep: 5 }).length === 0);
  check("explicit threshold", findSilences(db, { minLen: 0.5, threshold: -70 }).length === 0);

  // timeline levels follow clip placement, speed and muting
  st().loadDoc(viewToDoc({ ...defaultProject(), lines: [{ id: "l1", text: "hi", start: 0, end: 2, layerId: "main" }] }));
  useMedia.setState({ projectId: "p", items: [{ id: "a1", name: "talk.wav", kind: "audio", mime: "audio/wav", size: 1, lastModified: 0, addedAt: 0, duration: 8 }, { id: "v1", name: "Beach.mp4", kind: "video", mime: "video/mp4", size: 1, lastModified: 0, addedAt: 0, duration: 20, width: 1920, height: 1080, hasAudio: true }] });
  await run("add_track", { kind: "audio", name: "Voice" });
  const placed = await run("add_clip", { media: "talk", at: 10, track: "Voice" });
  const poolId = st().doc.media.find((m) => m.poolId === "a1")!.id;
  const levels: Record<string, Levels> = { [poolId]: { rate: LEVEL_RATE, db } };
  const t0 = tl();
  const len = 18;
  const lv = timelineLevels(t0, levels, len);
  check("timeline levels: clip placed at 10 s, so its pause is at 12-13.2 s", placed.ok && lv[Math.round(12.5 * LEVEL_RATE)] < -50 && lv[Math.round(11 * LEVEL_RATE)] > -20, [placed.summary, lv[625], lv[550]]);
  check("timeline levels: before the clip there is no sound", lv[5 * LEVEL_RATE] === -Infinity);
  const plan = planSilenceCuts(t0, levels, { minLen: 0.5, keep: 0.1 });
  check("plan: the gap before the clip is cut too, plus the pause inside it", plan.ranges.length >= 1 && plan.ranges.some((r) => near(r.start, 12.05) && near(r.end, 13.15)), plan.ranges);
  const clipsBefore = tl().clips.filter((c) => c.mediaId === poolId);
  const after = cutDoc(st().doc, [{ start: 12.05, end: 13.15 }], { picture: true });
  const clipsAfter = activeTimeline(after).clips.filter((c) => c.mediaId === poolId);
  const total = (cs: typeof clipsBefore) => cs.reduce((n, c) => n + c.duration, 0);
  check("cutting the pause makes the sound 1.1 s shorter and closes the gap", near(total(clipsBefore) - total(clipsAfter), 1.1, 0.02) && clipsAfter.length === 2, [total(clipsBefore), total(clipsAfter), clipsAfter.length]);
  // muted tracks do not count as sound
  st().editDoc((d) => E.onActive(d, (t) => ({ ...t, tracks: t.tracks.map((x) => (x.name === "Voice" ? { ...x, muted: true } : x)) })));
  check("muted sound is not measured", timelineLevels(tl(), levels, len).every((v) => v === -Infinity));
}

/* ---------- scenes ---------- */
{
  const step = 0.25;
  const diffs = Array.from({ length: 80 }, (_, i) => (i === 0 ? 0 : 0.02 + 0.01 * ((i * 7) % 3)));
  diffs[20] = 0.6;
  diffs[21] = 0.35; // an adjacent echo of the same cut
  diffs[55] = 0.45;
  const cuts = detectCuts(diffs, step);
  check("scene cuts: the two jumps, once each", JSON.stringify(cuts) === "[20,55]", cuts);
  check("scene cuts: steady picture has none", detectCuts(Array.from({ length: 60 }, () => 0.03), step).length === 0);
  check("scene cuts: a fade is not a cut", detectCuts(Array.from({ length: 60 }, () => 0.12), step).length === 0);
  check("scene cuts: higher sensitivity finds a softer change", detectCuts(Object.assign([...diffs], { 40: 0.2 }), step, { sensitivity: 1 }).includes(40) && !detectCuts(Object.assign([...diffs], { 40: 0.2 }), step, { sensitivity: 0 }).includes(40));
  const clip = { start: 10, sourceIn: 2, sourceOut: 12, speed: 2 } as Parameters<typeof sceneTimes>[0];
  check("scene times: source time to timeline time through start and speed", JSON.stringify(sceneTimes(clip, [1, 4, 8, 12])) === "[11,13]", sceneTimes(clip, [1, 4, 8, 12]));
  const a = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  check("frame difference: same = 0, black vs white = 1", frameDiff(a, a) === 0 && frameDiff(new Uint8ClampedArray([0, 0, 0, 255]), new Uint8ClampedArray([255, 255, 255, 255])) > 0.99);
}

/* ---------- moments ---------- */
{
  const cues = [
    { start: 0, end: 3, text: "Welcome to the show." },
    { start: 3, end: 7, text: "Today we talk about pricing and plans." },
    { start: 7, end: 11, text: "The price went up last year." },
    { start: 11, end: 15, text: "Thanks for watching, see you next week." },
  ];
  const m = findMoments(cues, "where they talk about price");
  check("moments: stems match price and pricing", m.length === 2 && m[0].start === 3 && m[1].start === 7, m);
  check("moments: a quoted phrase matches exactly", findMoments(cues, '"see you next week"').length === 1);
  check("moments: no match, no moments", findMoments(cues, "dragons").length === 0);
  check("moments: stop words alone find nothing", findMoments(cues, "the of and").length === 0);
}

/* ---------- tools on a real document ---------- */
st().loadDoc(
  viewToDoc({
    ...defaultProject(),
    lines: [
      { id: "l1", text: "Welcome to the show", start: 0, end: 3, layerId: "main" },
      { id: "l2", text: "Today we talk about pricing", start: 3, end: 7, layerId: "main" },
      { id: "l3", text: "The price went up", start: 7, end: 11, layerId: "main" },
    ],
  })
);
useMedia.setState({ projectId: "p", items: [{ id: "v1", name: "Interview.mp4", kind: "video", mime: "video/mp4", size: 1, lastModified: 0, addedAt: 0, duration: 20, width: 1920, height: 1080, hasAudio: true }] });
{
  const markers0 = tl().markers.length;
  const r = await run("find_moments", { query: "price" });
  check("find_moments: marks both moments on the ruler", r.ok && tl().markers.length === markers0 + 2 && tl().markers.some((m) => m.time === 3) && tl().markers.some((m) => m.time === 7), r);
  check("find_moments: reports nothing found without changing", (await run("find_moments", { query: "dragons" })).summary.includes("nothing"));
}
{
  await run("add_clip", { media: "interview", at: 0, out: 12 });
  const before = tl().clips.filter((c) => tl().tracks.find((t) => t.id === c.trackId)?.kind === "video" && !c.fill).length;
  check("cut_to_beats: refuses without beats", !(await run("cut_to_beats", {})).ok);
  st().editDoc((d) =>
    E.onActive(d, (t) => ({ ...t, markers: [...t.markers, ...Array.from({ length: 25 }, (_, i) => ({ id: `b${i}`, time: i * 0.5, name: "", color: "#fff", kind: "beat" as const }))] }))
  );
  const r = await run("cut_to_beats", { every: 4 });
  const pics = tl().clips.filter((c) => tl().tracks.find((t) => t.id === c.trackId)?.kind === "video" && !c.fill);
  check("cut_to_beats: a cut every 4 beats (every 2 s) across 12 s", r.ok && pics.length === before + 5, [r.summary, pics.length, before]);
  const undoSteps = st().past.length;
  await run("cut_to_beats", { every: 2 });
  check("cut_to_beats: one undo step per call", st().past.length === undoSteps + 1);
}

/* ---------- routing and prompt context ---------- */
{
  const g = (t: string) => selectToolGroups(t, st().project);
  check("routing: pauses brings the smart and timeline tools", g("Remove all pauses longer than half a second").includes("smart") && g("Remove all pauses longer than half a second").includes("timeline"));
  check("routing: translate brings the smart tools", g("translate the captions to Spanish").includes("smart"));
  check("routing: opening a page brings the ui tools", g("go to the color page").includes("ui"));
  check("routing: a plain style request stays small", !g("make the text pink").includes("smart") && !g("make the text pink").includes("ui"));
  check("tools exist for the phase", ["remove_silences", "cut_to_beats", "find_moments", "detect_scenes", "generate_captions", "translate_captions", "export_video", "run_command"].every((n) => registry.get(n)));
  check("smart tools are offered under their group", registry.list(["smart"]).length >= 7 && registry.list(["ui"]).length === 1);

  const clips = tl().clips.filter((c) => !c.fill && !c.text);
  useTimelineUi.setState({ selected: [clips[0].id], view: { t0: 0, t1: 30 } });
  const prompt = buildSystemPrompt(st().project, false, ["style", "smart", "timeline"]);
  check("prompt: selected clips are named", prompt.includes("SELECTED CLIPS") && prompt.includes(clips[0].id));
  check("prompt: playhead and visible range", prompt.includes("PLAYHEAD:") && prompt.includes("VISIBLE: 0s to 30s"), prompt.slice(0, 300));
  check("prompt: transcript for summaries", prompt.includes("TRANSCRIPT") && prompt.includes("[3.0] Today we talk about pricing"));
  const plain = buildSystemPrompt(st().project, false, ["style"]);
  check("prompt: nothing extra for plain requests", !plain.includes("SELECTED CLIPS") && !plain.includes("TRANSCRIPT"));

  // a long edit stays short: only some clips are listed
  const big = viewToDoc({ ...defaultProject() });
  const t1 = activeTimeline(big);
  const many = { ...big, timelines: big.timelines.map((t) => (t.id === t1.id ? { ...t, clips: Array.from({ length: 300 }, (_, i) => ({ ...clips[0], id: `x${i}`, start: i * 2, duration: 2 })) } : t)) };
  const ctx = timelineContext(many, { selected: ["x150"], playhead: 300, view: { t0: 290, t1: 320 }, maxClips: 24 });
  check("context: 300 clips, a short summary", ctx.split("\n").length < 40 && ctx.length < 3000, ctx.length);
  check("context: clips in view come first", ctx.includes("x150 |") && ctx.includes("x146 |") && !ctx.includes("x5 |"), ctx.slice(0, 400));
  useTimelineUi.setState({ selected: [], view: null });
}

/* ---------- held edits ---------- */
{
  check("held: delete_clips", !!holdReason({ tool: "delete_clips", args: { clips: ["a", "b"] } }) && holdReason({ tool: "delete_clips", args: { clips: ["a", "b"] } })!.includes("2 clips"));
  check("held: arguments sent as a JSON string are read", !!holdReason({ tool: "delete_clips", args: '{"clips":["a"],"ripple":true}' })?.includes("close the gap"));
  check("held: cutting tools and export", ["remove_fillers", "remove_silences", "export_video", "delete_line", "delete_layer"].every((t) => holdReason({ tool: t, args: {} })));
  check("held: ordinary edits are not", ["add_clip", "trim_clip", "set_clip", "add_marker", "find_moments", "update_style"].every((t) => holdReason({ tool: t, args: {} }) === null));
  const h = heldCalls([{ tool: "set_clip", args: {} }, { tool: "delete_clips", args: { clips: "a" } }]);
  check("held: only the destructive call is listed, with a question to answer", h.length === 1 && askText(h).includes("Apply it?") && askText([]) === "", h);
}

/* ---------- the request log ---------- */
{
  useAiLog.getState().clear();
  void streamChat({ provider: providerById("openai"), baseUrl: "https://api.openai.com/v1", apiKey: "sk-very-secret", model: "gpt", }, { messages: [{ role: "user", content: "hello there" }] });
  void streamChat({ provider: providerById("ollama"), baseUrl: "http://localhost:11434", apiKey: "", model: "qwen" }, { messages: [{ role: "user", content: "hi" }], purpose: "translate" });
  const e = useAiLog.getState().entries;
  check("log: a request is listed with its host and size", e.length === 2 && e[0].host === "api.openai.com" && e[0].size === 11 && e[0].kind === "chat", e);
  check("log: the key and the text are never kept", !JSON.stringify(e).includes("sk-very-secret") && !JSON.stringify(e).includes("hello there"));
  check("log: local and online are told apart", e[1].local && !e[0].local && e[1].kind === "translate" && summarize(e).remote === 1);
  check("log: host parsing", hostOf("https://api.groq.com/openai/v1") === "api.groq.com" && hostOf("localhost:11434") !== "");
  useAiLog.getState().clear();
  check("log: clear", useAiLog.getState().entries.length === 0);
}

/* ---------- macros ---------- */
{
  const id = (() => { let n = 0; return () => `m${++n}`; })();
  check("macro data: junk is rejected", sanitizeMacro({ steps: [] }, id) === null && sanitizeMacro("x", id) === null && sanitizeMacro({ steps: [{ kind: "tool", tool: "../../etc", args: {} }, { kind: "x" }] }, id) === null);
  const m = sanitizeMacro({ name: "  Tidy  ", steps: [{ kind: "tool", tool: "add_marker", args: { time: 1 } }, { kind: "command", id: "tool.blade" }, { kind: "nope" }] }, id)!;
  check("macro data: good steps kept, bad ones dropped, name trimmed", m.name === "Tidy" && m.steps.length === 2);
  const back = macrosFromJson(macrosToJson([m]), id)!;
  check("macro data: JSON round trip", back.macros.length === 1 && JSON.stringify(back.macros[0].steps) === JSON.stringify(m.steps) && back.skipped === 0);
  check("macro data: not a macros file", macrosFromJson("nope", id) === null && macrosFromJson("{}", id) === null);
  check("macro data: describe", describeStep(m.steps[0]) === "add_marker time=1" && describeStep(m.steps[1]) === "tool.blade");
  const groups = groupSteps([...m.steps, ...m.steps]);
  check("macro data: consecutive tool steps are grouped", groups.length === 4 || groups.length === 3, groups.length);
  check("macro data: tool, command, tool+tool", groupSteps([{ kind: "tool", tool: "a_b", args: {} }, { kind: "tool", tool: "c_d", args: {} }, { kind: "command", id: "x" }]).length === 2);

  // record through the real tool path, then play it back
  const store = useMacros.getState();
  store.start();
  const markers0 = tl().markers.length;
  await run("add_marker", { time: 5, name: "A" });
  await run("add_marker", { time: 6, name: "B" });
  await run("add_marker", { time: 6, name: "B" }); // unchanged: already there? (a duplicate marker is still a change)
  const rec = useMacros.getState().draft.length;
  const saved = useMacros.getState().stop("Two markers")!;
  check("macro: recording keeps the calls that changed something", rec >= 2 && saved.steps.every((s) => s.kind === "tool" && s.tool === "add_marker") && saved.name === "Two markers", saved);
  check("macro: not recording any more", !useMacros.getState().recording && useMacros.getState().draft.length === 0);
  await run("add_marker", { time: 9 });
  check("macro: nothing is recorded when not recording", useMacros.getState().macros[0].steps.length === saved.steps.length);
  const pastBefore = st().past.length;
  const cnt = tl().markers.length;
  const r = await playMacro(saved);
  check("macro: play applies every step as ONE undo step", r.ok && tl().markers.length === cnt + saved.steps.length && st().past.length === pastBefore + 1, [r, tl().markers.length - cnt, st().past.length - pastBefore]);
  check("macro: playing is not recorded", useMacros.getState().macros.length === 1);
  st().undo();
  check("macro: undo takes the whole macro back", tl().markers.length === cnt);
  const bad = sanitizeMacro({ name: "Old", steps: [{ kind: "tool", tool: "not_a_tool", args: {} }] }, id)!;
  const pr = await playMacro(bad);
  check("macro: a step this version lacks is named, nothing runs", !pr.ok && pr.message.includes("not_a_tool") && missingSteps(bad).length === 1);
  // a failing step stops the macro
  const failing = sanitizeMacro({ name: "Fails", steps: [{ kind: "tool", tool: "trim_clip", args: { clip: "nope", edge: "start" } }] }, id)!;
  check("macro: a step that fails stops and says why", !(await playMacro(failing)).ok);
  store.start();
  const pr2 = await playMacro(saved);
  check("macro: cannot play while recording", !pr2.ok && pr2.message.includes("Stop recording"));
  useMacros.getState().discard();
  void markers0;
}

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
