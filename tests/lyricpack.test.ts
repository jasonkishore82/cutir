// Phase 19 rest: the lyric pack (subtitle track -> animated titles) and saved multi-clip templates.
import { viewToDoc } from "../src/model/convert";
import { defaultProject } from "../src/store/project";
import type { Clip, Timeline } from "../src/model/types";
import * as E from "../src/timeline/engine";
import { LYRIC_PACKS, lineTitle, lyricClips, lyricsToTitles, packById, removeLyricTitles } from "../src/lib/lyricPack";
import { addGeneratorClips, buildTemplate } from "../src/lib/titleTemplates";
import { buildUserTemplate, captureTemplate, deleteTemplate, loadTemplates, saveTemplate, templateFields } from "../src/lib/userTemplates";
import { applyCalls } from "../src/lib/tools/index";
import { useProject } from "../src/store/project";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
};

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

/* a timeline with a subtitle track of three synced lines */
const base = viewToDoc(defaultProject());
let tl: Timeline = base.timelines[0];
const sub = E.addTrack(tl, "subtitle");
tl = sub.tl;
const line = (id: string, start: number, duration: number, text: string): Clip => ({ id, trackId: sub.id, start, duration, sourceIn: 0, sourceOut: duration, speed: 1, enabled: true, effects: [], keyframes: {}, text: { text } });
tl = { ...tl, clips: [...tl.clips.filter((c) => c.trackId !== sub.id), line("l1", 1, 3, "Hello darkness my old friend"), line("l2", 4.5, 2, "I have come to talk"), line("l3", 7, 0.4, "again"), line("blank", 8, 1, "   ")] };

/* ---------- lyric pack ---------- */
check("six lyric packs", LYRIC_PACKS.length === 6 && LYRIC_PACKS.every((p) => packById(p.id) === p));
check("blank lines are not lyric lines", lyricClips(tl, sub.id).map((c) => c.id).join() === "l1,l2,l3");

const karaoke = packById("karaoke")!;
const r = lyricsToTitles(tl, sub.id, karaoke);
const gen = r.tl.clips.filter((c) => c.trackId === r.trackId);
check("one title per line, timed like the line", r.created === 3 && gen.length === 3 && gen[0].start === 1 && gen[0].duration === 3 && gen[1].start === 4.5, gen.map((c) => [c.start, c.duration]));
check("titles carry the words and the pack animation", gen[0].generator?.type === "title" && gen[0].generator.title.text === "Hello darkness my old friend" && gen[0].generator.title.animator.preset === "karaoke-fill" && gen[0].generator.title.animator.unit === "word");
check("the source lines are switched off but kept", ["l1", "l2", "l3"].every((id) => r.tl.clips.find((c) => c.id === id)?.enabled === false) && r.tl.clips.find((c) => c.id === "blank")?.enabled === true);
const track = r.tl.tracks.find((t) => t.id === r.trackId)!;
check("the new video track is bound to the subtitle track", track.kind === "video" && track.lyricsOf === sub.id && track.name === "Lyrics: Karaoke fill", track);
check("the sweep fits a short line", (gen[2].generator as { title: { animator: { duration: number } } }).title.animator.duration <= 0.4 * karaoke.animator.share + 1e-9);
check("a short line's fade-out is at most a third of it", (gen[2].generator as { title: { animator: { outDuration: number } } }).title.animator.outDuration <= 0.4 / 3 + 1e-9);

// retime a line, convert again with another pack: the titles are replaced, not doubled, on the same track
const retimed: Timeline = { ...r.tl, clips: r.tl.clips.map((c) => (c.id === "l2" ? { ...c, start: 5, duration: 1.5 } : c)) };
const again = lyricsToTitles(retimed, sub.id, packById("wave")!);
const gen2 = again.tl.clips.filter((c) => c.trackId === again.trackId);
check("converting again reuses the track and replaces the titles", again.trackId === r.trackId && gen2.length === 3 && again.tl.tracks.length === r.tl.tracks.length, [again.trackId, gen2.length]);
check("the titles follow the retime and the new pack", gen2.find((c) => c.name?.includes("I have"))?.start === 5 && gen2[0].generator?.type === "title" && gen2[0].generator.title.animator.preset === "wave");
check("a hand-made clip on the generated track is kept", (() => {
  const mine: Clip = { id: "mine", trackId: r.trackId, name: "My logo", start: 0, duration: 2, sourceIn: 0, sourceOut: 2, speed: 1, enabled: true, effects: [], keyframes: {} };
  const out = lyricsToTitles({ ...r.tl, clips: [...r.tl.clips, mine] }, sub.id, karaoke);
  return out.tl.clips.some((c) => c.id === "mine");
})());

const back = removeLyricTitles(again.tl, sub.id);
check("back to subtitles removes the titles and switches the lines on", !back.clips.some((c) => c.trackId === again.trackId && c.name?.startsWith("Lyrics: ")) && ["l1", "l2", "l3"].every((id) => back.clips.find((c) => c.id === id)?.enabled === true));
check("removing when nothing was made changes nothing", removeLyricTitles(tl, sub.id) === tl);

const vid = tl.tracks.find((t) => t.kind === "video")!;
check("a video track is refused with a clear message", (() => { try { lyricsToTitles(tl, vid.id, karaoke); return false; } catch (e) { return /not a subtitle track/.test((e as Error).message); } })());
check("an empty subtitle track is refused", (() => { const e = E.addTrack(tl, "subtitle"); try { lyricsToTitles(e.tl, e.id, karaoke); return false; } catch (x) { return /no lines/.test((x as Error).message); } })());
check("lineTitle never makes a sweep longer than the line", lineTitle("x", 0.2, karaoke).animator.duration <= 0.2);

/* ---------- the chat tool ---------- */
useProject.getState().loadDoc({ ...base, timelines: [tl, ...base.timelines.slice(1)], activeTimelineId: tl.id });
const t1 = await applyCalls([{ tool: "lyrics_to_titles", args: { pack: "Word pop" } }]);
check("tool: converts the first subtitle track with lyrics", t1.results[0].ok && /3 lyric lines/.test(t1.results[0].summary), t1.results[0]);
const t2 = await applyCalls([{ tool: "lyrics_to_titles", args: { pack: "nonsense" } }]);
check("tool: an unknown pack lists the packs", !t2.results[0].ok && /karaoke/.test(t2.results[0].summary), t2.results[0]);

/* ---------- saved multi-clip templates ---------- */
let doc2 = viewToDoc(defaultProject());
let tl2 = doc2.timelines[0];
const built = addGeneratorClips(tl2, buildTemplate("lower-third", { name: "Ana Ruiz", role: "Editor" }), 10);
tl2 = built.tl;
check("the lower third made two clips to save", built.ids.length === 2);
const ut = captureTemplate(tl2, built.ids, "My lower third");
check("captured: two clips, one text field, times relative to the first", ut.clips.length === 2 && ut.fields.length === 1 && ut.clips.every((c) => c.delay >= 0) && Math.min(...ut.clips.map((c) => c.delay)) === 0, ut);
check("the field defaults to the saved words", templateFields(ut)[0].default === "Ana Ruiz\nEditor");
check("an empty name is refused", (() => { try { captureTemplate(tl2, built.ids, " "); return false; } catch { return true; } })());
check("a selection without generators is refused", (() => { try { captureTemplate(tl2, tl2.clips.filter((c) => !c.generator).map((c) => c.id), "x"); return false; } catch (e) { return /select at least one/.test((e as Error).message); } })());

const store = memory();
saveTemplate(ut, store);
check("saved and loaded back", loadTemplates(store).length === 1 && loadTemplates(store)[0].name === "My lower third");
check("saving the same name replaces it", saveTemplate({ ...ut, id: "other" }, store).length === 1);
check("junk in storage is ignored", loadTemplates({ getItem: () => "{not json", setItem: () => {} }).length === 0 && loadTemplates({ getItem: () => JSON.stringify([{ id: 1 }, null]), setItem: () => {} }).length === 0);

const plans = buildUserTemplate(ut, { t1: "Bo Chen\nDirector" });
const titlePlan = plans.find((p) => p.generator.type === "title")!;
check("new words replace the old, and styled ranges are dropped", titlePlan.generator.type === "title" && titlePlan.generator.title.text === "Bo Chen\nDirector" && titlePlan.generator.title.runs.length === 0);
check("with the saved words the styled ranges stay", (() => { const p = buildUserTemplate(ut).find((x) => x.generator.type === "title")!; return p.generator.type === "title" && p.generator.title.runs.length === 1; })());
check("the saved template is not changed by building", ut.clips.find((c) => c.generator.type === "title")!.generator.type === "title" && (ut.clips.find((c) => c.generator.type === "title")!.generator as { title: { text: string } }).title.text === "Ana Ruiz\nEditor");
const placed = addGeneratorClips(tl2, plans, 30);
const added = placed.tl.clips.filter((c) => placed.ids.includes(c.id));
check("added back at the playhead with the same spacing and stacking", added.length === 2 && Math.min(...added.map((c) => c.start)) === 30 && new Set(added.map((c) => c.trackId)).size === 2, added.map((c) => [c.start, c.trackId]));
check("delete removes it", deleteTemplate(ut.id, store).length === 1 && deleteTemplate("other", store).length === 0);

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
