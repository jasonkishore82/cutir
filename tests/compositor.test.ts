// Phase 15: compositor and audio rules (src/render/compositor.ts, src/render/audio.ts).
import { activeVisuals, compositeVisuals, fitSize, needsAt, sourceTime, BLEND_OP } from "../src/render/compositor";
import { activeAudio, audible, mixInputs, songAudible } from "../src/render/audio";
import type { Clip, ProjectDoc, Track } from "../src/model/types";
import type { FrameProvider, Picture } from "../src/render/sources";
import { DEFAULT_STYLE } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const track = (id: string, kind: Track["kind"], extra: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, locked: false, solo: false, height: 44, hidden: false, ...extra });
const clip = (id: string, trackId: string, mediaId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id, trackId, mediaId, start, duration, sourceIn: 2, sourceOut: 2 + duration, speed: 1, enabled: true, effects: [], keyframes: {}, ...extra,
});

function doc(): ProjectDoc {
  return {
    schemaVersion: 2,
    settings: { aspect: "16:9", width: 1920, height: 1080, fps: 30, colorSpace: "rec709", sampleRate: 48000 },
    media: [
      { id: "vid", name: "v.mp4", kind: "video", fileKey: "m/1", poolId: "p1" },
      { id: "img", name: "i.png", kind: "image", fileKey: "m/2", poolId: "p2" },
      { id: "snd", name: "s.wav", kind: "audio", fileKey: "m/3", poolId: "p3" },
    ],
    bins: [],
    activeTimelineId: "t",
    timelines: [
      {
        id: "t", name: "t", markers: [], textStyle: DEFAULT_STYLE, transition: { type: "none", ms: 400 },
        tracks: [track("v-bg", "video"), track("V1", "video"), track("V2", "video"), track("V3", "video", { hidden: true }), track("S", "subtitle"), track("a-song", "audio"), track("A1", "audio"), track("A2", "audio")],
        clips: [
          { ...clip("c-bg", "v-bg", "", 0, 0), mediaId: undefined, fill: true, generator: { type: "gradient", colors: ["#000", "#fff"], angle: 0, noise: false } },
          clip("top", "V2", "img", 0, 10, { transform: { x: 0.25, y: 0.25, scale: 0.5, rotation: 15, opacity: 0.8, blend: "screen" } }),
          clip("base", "V1", "vid", 0, 10, { speed: 2 }),
          clip("hidden", "V3", "vid", 0, 10),
          clip("off", "V1", "vid", 10, 5, { enabled: false }),
          { ...clip("c-song", "a-song", "snd", 0, 0), fill: true },
          clip("fx", "A1", "snd", 1, 3, { volume: 0.5 }),
          clip("vo", "A2", "snd", 2, 4),
        ],
      },
    ],
  };
}

/* ---------- what is drawn ---------- */
{
  const d = doc();
  const tl = d.timelines[0];
  const at = activeVisuals(tl, d, 5).map((x) => x.clip.id);
  check("pictures at t: bottom track first, hidden tracks and fill clips left out", at.join() === "base,top", at);
  check("disabled clips are not drawn", activeVisuals(tl, d, 12).length === 0);
  check("kinds come from the media", activeVisuals(tl, d, 5).map((x) => x.kind).join() === "video,image");
  check("source time follows speed", near(sourceTime(tl.clips.find((c) => c.id === "base")!, 3), 2 + 3 * 2));
  check("export asks for exactly those pictures", JSON.stringify(needsAt(d, 3)) === JSON.stringify([{ mediaId: "vid", kind: "video", sourceTime: 8 }, { mediaId: "img", kind: "image", sourceTime: 5 }]));
  check("fit inside", JSON.stringify(fitSize(1000, 1000, 1920, 1080, "contain")) === JSON.stringify({ w: 1080, h: 1080 }));
  check("fill and crop", JSON.stringify(fitSize(1000, 1000, 1920, 1080, "cover")) === JSON.stringify({ w: 1920, h: 1920 }));
  check("stretch", JSON.stringify(fitSize(1000, 500, 1920, 1080, "fill")) === JSON.stringify({ w: 1920, h: 1080 }));
}

/* ---------- viewer and export draw the same frame ---------- */
type Op = [string, ...unknown[]];
function recorder(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get: (_t, k: string) => (k in state ? state[k] : (...a: unknown[]) => ops.push([k, ...a.map((x) => (typeof x === "object" ? (x as { id?: string }).id ?? "obj" : x))])),
      set: (_t, k: string, v) => {
        state[k] = v;
        ops.push([`set ${k}`, v]);
        return true;
      },
    }
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}
const pic = (id: string, w: number, h: number) => ({ id, width: w, height: h }) as unknown as Picture;
const pictures: Record<string, Picture> = { vid: pic("frame-vid", 1280, 720), img: pic("frame-img", 800, 800) };
{
  const d = doc();
  // the live provider (viewer) and the exact provider (export) end up with the same pictures for the same t
  const live: FrameProvider = { picture: (id) => pictures[id] ?? null };
  const exact: FrameProvider = { picture: (id, _k, st) => (st >= 0 ? pictures[id] : null) };
  const a = recorder();
  const b = recorder();
  const missA = compositeVisuals(a.ctx, d, 4, 1920, 1080, live);
  const missB = compositeVisuals(b.ctx, d, 4, 1920, 1080, exact);
  check("viewer and export issue identical drawing commands", JSON.stringify(a.ops) === JSON.stringify(b.ops) && missA === 0 && missB === 0);
  const draws = a.ops.filter((o) => o[0] === "drawImage").map((o) => o[1]);
  check("both layers drawn, bottom first", draws.join() === "frame-vid,frame-img", draws);
  check("blend mode and opacity applied", a.ops.some((o) => o[0] === "set globalCompositeOperation" && o[1] === BLEND_OP.screen) && a.ops.some((o) => o[0] === "set globalAlpha" && o[1] === 0.8));
  check("transform applied (position, rotation, scale)", a.ops.some((o) => o[0] === "translate" && o[1] === 480 && o[2] === 270) && a.ops.some((o) => o[0] === "scale" && o[1] === 0.5));
  const none: FrameProvider = { picture: () => null };
  check("a picture still decoding is skipped and counted", compositeVisuals(recorder().ctx, d, 4, 1920, 1080, none) === 2);
  // four layers, as in the phase goal
  const four = doc();
  four.timelines[0].tracks.push(track("V4", "video"), track("V5", "video"));
  four.timelines[0].clips.push(clip("l3", "V4", "img", 0, 10, { transform: { scale: 0.3 } }), clip("l4", "V5", "vid", 0, 10, { transform: { rotation: -10 } }));
  const r = recorder();
  compositeVisuals(r.ctx, four, 2, 1920, 1080, live);
  check("four layers with transforms composite in order", r.ops.filter((o) => o[0] === "drawImage").length === 4);
}

/* ---------- sound ---------- */
{
  const d = doc();
  const tl = d.timelines[0];
  const c = (id: string) => tl.clips.find((x) => x.id === id)!;
  check("audio clips are heard", audible(tl, c("fx")) && audible(tl, c("vo")));
  check("only clips under the playhead play", activeAudio(tl, 1.5).map((x) => x.id).join() === "fx");
  const muted = { ...tl, tracks: tl.tracks.map((t) => (t.id === "A1" ? { ...t, muted: true } : t)) };
  check("a muted track is silent", !audible(muted, c("fx")) && audible(muted, c("vo")));
  const solo = { ...tl, tracks: tl.tracks.map((t) => (t.id === "A2" ? { ...t, solo: true } : t)) };
  check("solo silences the other audio tracks (the song too)", !audible(solo, c("fx")) && audible(solo, c("vo")) && !songAudible({ ...d, timelines: [solo] }));
  check("the song is heard by default", songAudible(d));
  const urls = (id: string) => (id === "snd" ? "blob:snd" : undefined);
  const inputs = mixInputs(d, "blob:song", 10, urls);
  check("export mix: song plus every audible clip", inputs.length === 3 && inputs[0].url === "blob:song" && inputs.some((i) => i.volume === 0.5 && i.start === 1 && i.sourceIn === 2));
  check("export mix leaves out muted tracks", mixInputs({ ...d, timelines: [muted] }, "blob:song", 10, urls).length === 2);
  check("clips past the end are cut to the export length", mixInputs(d, undefined, 3, urls).find((i) => i.start === 2)!.duration === 1);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
