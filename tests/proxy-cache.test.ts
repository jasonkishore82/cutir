// Phase 16: proxy choices (src/lib/proxy.ts) and the render cache (src/render/cache.ts).
import { proxyHeight, variantFor, wantsProxy } from "../src/lib/proxy";
import { FrameCache, affectedRanges, mergeRanges } from "../src/render/cache";
import { DEFAULT_PROXY, type Clip, type ProjectDoc } from "../src/model/types";
import { defaultProject } from "../src/store/project";
import { viewToDoc } from "../src/model/convert";
import * as E from "../src/timeline/engine";
import type { MediaItem } from "../src/store/media";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
}

/* ---------- proxies ---------- */
check("proxy size: half of 2160p", proxyHeight(2160, "half") === 1080);
check("proxy size: quarter of 2160p", proxyHeight(2160, "quarter") === 540);
check("proxy size: fixed 720p", proxyHeight(2160, "720") === 720);
check("a proxy is never larger than the source", proxyHeight(720, "1080") === 720);
check("proxy heights are even", proxyHeight(1001, "half") % 2 === 0);
const item = (p: Partial<MediaItem>): MediaItem => ({ id: "x", name: "x.mp4", kind: "video", mime: "", size: 1, lastModified: 0, addedAt: 0, ...p });
check("4K wants a proxy, 1080p does not", wantsProxy(item({ width: 3840, height: 2160 })) && !wantsProxy(item({ width: 1920, height: 1080 })));
const withProxy = item({ proxy: { height: 1080, size: 1 }, optimized: { size: 1 } });
const s = DEFAULT_PROXY;
check("playback uses the proxy", variantFor(withProxy, "playback", s) === "proxy");
check("then the optimized copy", variantFor(item({ optimized: { size: 1 } }), "playback", s) === "optimized");
check("proxies off: the original plays", variantFor(withProxy, "playback", { ...s, use: false }) === "original");
check("export uses the original by default", variantFor(withProxy, "export", s) === "original");
check("export from proxies when chosen", variantFor(withProxy, "export", { ...s, exportFromProxies: true }) === "proxy");
check("images always use the original", variantFor({ ...withProxy, kind: "image" }, "playback", s) === "original");

/* ---------- the frame cache ---------- */
let closed = 0;
const bmp = (w = 100, h = 100) => ({ width: w, height: h, close: () => void closed++ });
{
  const c = new FrameCache<ReturnType<typeof bmp>>(100 * 100 * 4 * 3); // room for 3 frames
  for (let i = 0; i < 5; i++) c.put(i, bmp());
  check("the cache stays under its size", c.size === 3 && c.bytes <= c.limitBytes);
  check("the oldest frames go first and are released", !c.has(0) && !c.has(1) && c.has(4) && closed === 2);
  c.get(2); // used recently
  c.put(5, bmp());
  check("recently used frames are kept", c.has(2) && !c.has(3));
  c.setLimit(100 * 100 * 4);
  check("a smaller limit trims at once", c.size === 1);
  c.put(9, bmp(10000, 10000));
  check("a frame bigger than the whole cache is not kept", !c.has(9));
}
{
  const c = new FrameCache<ReturnType<typeof bmp>>(1e9);
  for (let i = 0; i < 300; i++) c.put(i, bmp(10, 10)); // 10 s at 30 fps
  c.invalidate([[2, 4]], 30);
  check("invalidating a range drops only its frames", !c.has(60) && !c.has(120) && c.has(59) && c.has(121) && c.size === 300 - 61);
  check("cached ranges for the ruler", JSON.stringify(c.ranges(30).map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])) === JSON.stringify([[0, 2], [4.033, 10]]), c.ranges(30)); // frames 0-59 cover 0-2 s
  c.invalidate("all", 30);
  check("invalidating everything clears", c.size === 0 && c.bytes === 0);
}
check("ranges merge when they overlap", JSON.stringify(mergeRanges([[5, 6], [1, 3], [2, 4]])) === JSON.stringify([[1, 4], [5, 6]]));

/* ---------- what an edit invalidates ---------- */
function base(): ProjectDoc {
  let doc = viewToDoc({ ...defaultProject(), lines: [{ id: "l1", text: "hi", start: 10, end: 12, layerId: "main" }] });
  doc = E.onActive(doc, (t) => {
    const v = E.addTrack(t, "video", "V");
    const a = E.addTrack(v.tl, "audio", "A");
    const clip = (id: string, trackId: string, start: number, mediaId: string): Clip => ({ id, trackId, mediaId, start, duration: 2, sourceIn: 0, sourceOut: 2, speed: 1, enabled: true, effects: [], keyframes: {} });
    return { ...a.tl, clips: [...a.tl.clips, clip("v1", v.id, 2, "m1"), clip("v2", v.id, 20, "m2"), clip("a1", a.id, 0, "m3")] };
  });
  return { ...doc, media: [...doc.media, { id: "m1", name: "a.mp4", kind: "video", fileKey: "m/1" }, { id: "m2", name: "b.mp4", kind: "video", fileKey: "m/2" }, { id: "m3", name: "c.wav", kind: "audio", fileKey: "m/3" }] };
}
const d0 = base();
const moved = E.onActive(d0, (t) => E.moveClips(t, ["v1"], 3));
check("moving a clip: only its old and new spans", JSON.stringify(affectedRanges(d0, moved)) === JSON.stringify([[2, 4], [5, 7]]), affectedRanges(d0, moved));
const far = E.onActive(d0, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === "v2" ? { ...c, transform: { opacity: 0.5 } } : c)) }));
check("changing one clip leaves the rest cached", JSON.stringify(affectedRanges(d0, far)) === JSON.stringify([[20, 22]]));
const sound = E.onActive(d0, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === "a1" ? { ...c, volume: 0.2 } : c)) }));
check("sound changes keep every picture", JSON.stringify(affectedRanges(d0, sound)) === "[]");
const lyric = E.onActive(d0, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === "l1" ? { ...c, text: { ...c.text!, text: "hello" } } : c)) }));
check("a lyric line change: its span plus a margin for transitions", JSON.stringify(affectedRanges(d0, lyric)) === JSON.stringify([[8, 14]]));
const media = { ...d0, media: d0.media.map((m) => (m.id === "m2" ? { ...m, duration: 9 } : m)) };
check("a media change: the spans of clips using it", JSON.stringify(affectedRanges(d0, media)) === JSON.stringify([[20, 22]]));
check("track height changes keep the cache", JSON.stringify(affectedRanges(d0, E.onActive(d0, (t) => ({ ...t, tracks: t.tracks.map((x) => ({ ...x, height: 90 })) })))) === "[]");
check("hiding a track changes everything", affectedRanges(d0, E.onActive(d0, (t) => ({ ...t, tracks: t.tracks.map((x) => (x.name === "V" ? { ...x, hidden: true } : x)) }))) === "all");
check("the lyric style changes everything", affectedRanges(d0, E.onActive(d0, (t) => ({ ...t, textStyle: { ...t.textStyle, color: "#ff0000" } }))) === "all");
check("the lyric background changes everything", affectedRanges(d0, E.onActive(d0, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === "c-bg" ? { ...c, generator: { ...c.generator!, angle: 10 } } : c)) }))) === "all");
check("the aspect ratio changes everything", affectedRanges(d0, { ...d0, settings: { ...d0.settings, aspect: "9:16" } }) === "all");
check("switching proxies changes everything", affectedRanges(d0, { ...d0, settings: { ...d0.settings, proxy: { ...DEFAULT_PROXY, use: false } } }) === "all");
check("render cache settings alone change nothing", JSON.stringify(affectedRanges(d0, { ...d0, settings: { ...d0.settings, renderCache: { mode: "always", sizeMB: 128 } } })) === "[]");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
