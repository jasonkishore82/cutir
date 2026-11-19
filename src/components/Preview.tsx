import { Icon } from "./ui";
import TextOverlay from "./TextOverlay";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../store/project";
import { ensureFont } from "../lib/fonts";
import { ASPECT_RATIO, type MediaSource } from "../lib/renderer";
import { getTime, pause, seek, setFallbackDuration, setLoop, setSongMuted, setSource, shuttle, tick, toggle, usePlayback } from "../lib/transport";
import { activeVisuals, needsAt, renderFrame, visualMediaIds, type PreviewEffect } from "../render/compositor";
import { defaultParams, getEffect } from "../lib/effects";
import { useTimelineUi } from "../timeline/ui";
import { closeUnused, exactFrames, liveFrames, reopenPlayback, setFileResolver, sourceStates, stats } from "../render/sources";
import { FrameCache, affectedRanges, useCacheInfo } from "../render/cache";
import { fileFor, onVariantsChanged, proxySettings, variantFor } from "../lib/proxy";
import { DEFAULT_CACHE, type ProjectDoc } from "../model/types";
import { AudioMixer, songAudible } from "../render/audio";
import { activeTimeline } from "../model/convert";
import { timelineEnd } from "../timeline/engine";
import { useMedia } from "../store/media";

/** Pictures and sound of timeline clips come from the media pool. */
const poolOf = (mediaId: string) => useProject.getState().doc.media.find((m) => m.id === mediaId)?.poolId;
setFileResolver(async (mediaId, purpose) => {
  const pool = poolOf(mediaId);
  return pool ? fileFor(pool, purpose) : null; // proxies for playback when allowed; originals for export
});

/* ---------- effect hover preview (phase 17) ---------- */

let previewKey = "";
let previewValue: PreviewEffect | undefined;
/** The effect hovered in the Effects panel, applied to the selected clips (viewer only, never saved or cached). */
function previewEffect(): PreviewEffect | undefined {
  const ui = useTimelineUi.getState();
  const id = ui.previewEffect;
  const key = id && ui.selected.length ? `${id}|${ui.selected.join(",")}` : "";
  if (key !== previewKey) {
    previewKey = key;
    const def = id ? getEffect(id) : undefined;
    previewValue = key && def ? { clipIds: new Set(ui.selected), effect: { id: "preview", type: def.id, enabled: true, params: defaultParams(def.params) } } : undefined;
  }
  return previewValue;
}

/* ---------- render cache (phase 16) ---------- */

const cacheSettings = (doc: ProjectDoc = useProject.getState().doc) => ({ ...DEFAULT_CACHE, ...(doc.settings.renderCache ?? {}) });
const frameCache = new FrameCache(DEFAULT_CACHE.sizeMB * 1024 * 1024);
let cacheVersion = 0;
let cacheSize = "";
const slowFrames = new Set<number>();
const pending = new Set<number>();
let viewSize = { w: 0, h: 0 };
/** The viewer's lyric background (image or video element), so pre-rendered frames match. */
let liveBg: MediaSource | undefined;

export function clearRenderCache() {
  frameCache.clear();
  slowFrames.clear();
  cacheVersion++;
  publishCache();
}

function publishCache() {
  const fps = useProject.getState().doc.settings.fps;
  useCacheInfo.setState({ ranges: frameCache.ranges(fps), frames: frameCache.size, mb: Math.round(frameCache.bytes / 1048576) });
}

/** Render the in/out range (or the given span) into the cache now, at the viewer's size. Returns frames added. */
export async function prerenderRange(a: number, b: number, onProgress?: (f: number) => void): Promise<number> {
  const st = useProject.getState();
  const fps = st.doc.settings.fps;
  if (!viewSize.w || cacheSettings().mode === "off") return 0;
  if (liveBg instanceof HTMLVideoElement) throw new Error("Pre-rendering is not available while the lyric background is a video; play the range once instead.");
  const canvas = document.createElement("canvas");
  canvas.width = viewSize.w;
  canvas.height = viewSize.h;
  const ctx = canvas.getContext("2d")!;
  const frames = exactFrames("playback");
  const first = Math.ceil(a * fps);
  const last = Math.floor(b * fps);
  const version = cacheVersion;
  let added = 0;
  for (let i = first; i <= last; i++) {
    if (version !== cacheVersion) break; // the project changed meanwhile
    if (frameCache.has(i)) continue;
    const t = i / fps;
    const { doc, project } = useProject.getState();
    if (!activeVisuals(activeTimeline(doc), doc, t).length) continue;
    await frames.prepare(needsAt(doc, t));
    renderFrame(ctx, doc, project, t, canvas.width, canvas.height, { bg: liveBg }, frames);
    frameCache.put(i, await createImageBitmap(canvas));
    added++;
    if (i % 10 === 0) {
      onProgress?.((i - first) / Math.max(1, last - first));
      publishCache();
    }
  }
  publishCache();
  return added;
}

// a proxy appearing or going changes which file plays: reopen decoders, drop frames made from the old file
onVariantsChanged(() => {
  reopenPlayback();
  clearRenderCache();
});
const mixer = new AudioMixer((mediaId) => {
  const pool = poolOf(mediaId);
  return pool ? useMedia.getState().urls[pool] : undefined;
});

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};

export default function Preview() {
  const aspect = useProject((s) => s.project.aspect);
  const audioUrl = useProject((s) => s.project.audio?.url);
  const background = useProject((s) => s.project.background);
  const lines = useProject((s) => s.project.lines);
  const fontFamily = useProject((s) => s.project.style.fontFamily);
  const selectedId = useProject((s) => s.selectedLineId);

  const playing = usePlayback((s) => s.playing);
  const rate = usePlayback((s) => s.rate);
  const docEnd = useProject((s) => timelineEnd(activeTimeline(s.doc)));
  const doc = useProject((s) => s.doc);
  const [showStats, setShowStats] = useState(false);
  const [diag, setDiag] = useState({ fps: 0, dropped: 0, decoded: 0, cacheMB: 0, missing: 0 });
  const duration = usePlayback((s) => s.duration);
  const loop = usePlayback((s) => s.loop);

  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<MediaSource | undefined>(undefined);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [timeLabel, setTimeLabel] = useState("0:00.00");
  const [scrub, setScrub] = useState<number | null>(null);

  /* audio source follows the project */
  useEffect(() => setSource(audioUrl), [audioUrl]);

  /* without audio, playback length follows the lyrics and the timeline's clips */
  useEffect(() => {
    const lyricEnd = lines.length ? Math.max(...lines.map((l) => l.end)) + 1 : 0;
    setFallbackDuration(Math.max(lyricEnd, docEnd > 0 ? docEnd + 0.5 : 0));
  }, [lines, docEnd]);

  /* decoders stay open only for media still on a timeline; the song follows its track's mute and solo */
  const prevDoc = useRef(doc);
  useEffect(() => {
    closeUnused(visualMediaIds(doc));
    setSongMuted(!songAudible(doc));
    // render cache: drop exactly the frames this edit can change
    const before = prevDoc.current;
    prevDoc.current = doc;
    const set = cacheSettings(doc);
    frameCache.setLimit(set.sizeMB * 1024 * 1024);
    if (set.mode === "off") return void (frameCache.size && clearRenderCache());
    if (JSON.stringify(before.settings.proxy) !== JSON.stringify(doc.settings.proxy)) reopenPlayback();
    const changed = affectedRanges(before, doc);
    if (changed === "all" || changed.length) {
      frameCache.invalidate(changed, doc.settings.fps);
      cacheVersion++;
      publishCache();
    }
  }, [doc]);
  useEffect(() => () => mixer.stop(), []);

  /* make sure the chosen font is loaded; the frame loop picks it up once ready */
  useEffect(() => {
    ensureFont(fontFamily, lines.map((l) => l.text).join(" ")).catch(() => {}); // downloads Google fonts after a reload too
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontFamily, lines.length]);

  /* background image / video element */
  const bgUrl = background.type === "asset" ? background.asset?.url : undefined;
  const bgKind = background.type === "asset" ? background.asset?.kind : undefined;
  useEffect(() => {
    bgRef.current = undefined;
    if (!bgUrl) return;
    if (bgKind === "video") {
      const v = document.createElement("video");
      v.src = bgUrl;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      bgRef.current = v;
      return () => {
        v.pause();
        v.removeAttribute("src");
        v.load();
        if (bgRef.current === v) bgRef.current = undefined;
      };
    }
    const img = new Image();
    img.src = bgUrl;
    img.onload = () => (bgRef.current = img);
    return () => {
      img.onload = null;
      if (bgRef.current === img) bgRef.current = undefined;
    };
  }, [bgUrl, bgKind]);

  /* keep a looping background video moving with playback */
  useEffect(() => {
    const v = bgRef.current;
    if (v instanceof HTMLVideoElement) {
      if (playing) v.play().catch(() => {});
      else v.pause();
    }
  }, [playing, bgUrl, bgKind]);

  /* fit the canvas box to the container at the chosen aspect (letterboxed) */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      const r = ASPECT_RATIO[aspect];
      const w = Math.min(cw, ch * r);
      setBox({ w: Math.floor(w), h: Math.floor(w / r) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  /* the render loop: driven by audio.currentTime every animation frame */
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !box.w) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let lastLabel = "";
    let lastVideoSeek = -1;
    let frames = 0;
    let since = performance.now();
    let missing = 0;
    let suggested = false;
    let droppedAtStart = stats.dropped;
    viewSize = { w: canvas.width, h: canvas.height };
    const sizeKey = `${canvas.width}x${canvas.height}`;
    if (cacheSize !== sizeKey) {
      cacheSize = sizeKey; // cached frames are only valid at the size they were drawn
      clearRenderCache();
    }

    const frame = () => {
      tick();
      const t = getTime();

      const bg = bgRef.current;
      if (bg instanceof HTMLVideoElement && bg.duration > 0 && !usePlayback.getState().playing) {
        // paused: scrub the loop video to match the playhead
        const vt = t % bg.duration;
        if (Math.abs(vt - lastVideoSeek) > 0.04) {
          bg.currentTime = vt;
          lastVideoSeek = vt;
        }
      }

      const st = useProject.getState();
      const pb = usePlayback.getState();
      const live = pb.playing && pb.rate > 0;
      liveBg = bg;
      const cset = cacheSettings(st.doc);
      const fi = Math.round(t * st.doc.settings.fps);
      const preview = previewEffect();
      const cached = cset.mode !== "off" && !preview ? frameCache.get(fi) : undefined;
      if (cached) {
        ctx.drawImage(cached, 0, 0);
        missing = 0;
      } else {
        const dropped0 = stats.dropped;
        missing = renderFrame(ctx, st.doc, st.project, t, canvas.width, canvas.height, { bg }, liveFrames(live), preview);
        const heavy = !preview && cset.mode !== "off" && activeVisuals(activeTimeline(st.doc), st.doc, t).length > 0;
        if (heavy) {
          if (live && (missing > 0 || stats.dropped > dropped0)) slowFrames.add(fi); // did not play in real time
          const keep = cset.mode === "always" || slowFrames.has(fi);
          if (keep && missing === 0 && !pending.has(fi)) {
            pending.add(fi);
            const version = cacheVersion;
            void createImageBitmap(canvas).then((b) => {
              pending.delete(fi);
              if (version === cacheVersion) {
                frameCache.put(fi, b);
                slowFrames.delete(fi);
              } else b.close();
            });
          }
        }
      }
      mixer.update(st.doc, t, pb.playing, pb.rate);

      // diagnostics: frames drawn per second, decoder counters
      frames++;
      const now = performance.now();
      if (now - since >= 500) {
        const fps = Math.round((frames * 1000) / (now - since));
        frames = 0;
        since = now;
        setDiag({ fps, dropped: stats.dropped, decoded: stats.decoded, cacheMB: stats.cacheMB, missing });
        publishCache();
        // playback keeps dropping frames: suggest proxies once, if the project wants suggestions
        if (!suggested && usePlayback.getState().playing && stats.dropped - droppedAtStart > 15 && proxySettings().suggest) {
          const { doc } = useProject.getState();
          const used = new Set(activeTimeline(doc).clips.map((c) => doc.media.find((m) => m.id === c.mediaId)?.poolId).filter(Boolean));
          const lacking = useMedia.getState().items.filter((i) => used.has(i.id) && i.kind === "video" && variantFor(i, "playback", proxySettings()) === "original");
          if (lacking.length) {
            suggested = true;
            useMedia.setState({ notice: `Playback is dropping frames. Create proxies for ${lacking.length} clip${lacking.length === 1 ? "" : "s"} in the Media library ("Proxies for clips in use").` });
          }
        }
        if (!usePlayback.getState().playing) droppedAtStart = stats.dropped;
      }

      const label = fmt(t);
      if (label !== lastLabel) {
        lastLabel = label;
        setTimeLabel(label);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [box.w, box.h, dpr]);

  /* J K L shuttle (Shift: half speed). K with a lyric line selected adds a keyframe instead (handled first). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || useProject.getState().syncMode) return;
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
      const key = e.code === "KeyJ" ? "J" : e.code === "KeyK" ? "K" : e.code === "KeyL" ? "L" : null;
      if (!key) return;
      e.preventDefault();
      shuttle(key, e.shiftKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Space = play/pause (not while typing) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || useProject.getState().syncMode) return; // sync mode uses Space to tap
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName) || t.isContentEditable) {
        if (t.tagName !== "BUTTON" && !(t.tagName === "INPUT" && (t as HTMLInputElement).type === "range")) return;
        t.blur();
      }
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => () => pause(), []);

  const selected = useMemo(() => lines.find((l) => l.id === selectedId), [lines, selectedId]);
  const toggleLoop = () => {
    if (loop) return setLoop(null);
    if (selected) setLoop({ start: selected.start, end: selected.end });
    else if (duration > 0) setLoop({ start: 0, end: duration });
  };

  const round = "grid h-9 w-9 place-items-center rounded-full text-gray-300 hover:bg-white/10 hover:text-white";

  return (
    <div className="flex h-full flex-col">
      <div ref={boxRef} className="flex min-h-0 flex-1 items-center justify-center p-5">
        <div className="relative" style={{ width: box.w, height: box.h }}>
          <canvas
            ref={canvasRef}
            width={Math.round(box.w * dpr)}
            height={Math.round(box.h * dpr)}
            style={{ width: box.w, height: box.h }}
            className="rounded-lg shadow-2xl shadow-black/70 ring-1 ring-white/10"
          />
          {box.w > 0 && <TextOverlay w={box.w} h={box.h} />}
          {showStats && (
            <div className="pointer-events-none absolute left-2 top-2 z-20 space-y-0.5 rounded-md bg-black/75 px-2 py-1.5 font-mono text-[10px] leading-4 text-green-300" role="status" aria-label="Playback statistics">
              <div>{diag.fps} fps drawn · {diag.dropped} dropped</div>
              <div>{diag.decoded} decoded · cache {diag.cacheMB} MB</div>
              {diag.missing > 0 && <div className="text-yellow-300">{diag.missing} clip{diag.missing === 1 ? "" : "s"} still decoding</div>}
              {sourceStates().map((s) => (
                <div key={s.id} className={s.state.startsWith("failed") ? "text-red-300" : "text-gray-300"}>
                  {s.id}: {s.state}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mx-4 mb-4 flex h-12 shrink-0 items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.04] px-2.5">
        <button className={round} onClick={() => seek(0)} title="Back to start" aria-label="Back to start"><Icon name="skipBack" /></button>
        <button
          className="grid h-9 w-9 place-items-center rounded-full bg-white text-black hover:bg-gray-200"
          onClick={toggle}
          title="Play / pause (Space)"
          aria-label={playing ? "Pause" : "Play"}
        >
          <Icon name={playing ? "pause" : "play"} className="h-4 w-4" />
        </button>
        <span className="w-24 shrink-0 text-center text-xs tabular-nums text-gray-300">{timeLabel}</span>
        <input
          type="range"
          className="min-w-0 flex-1"
          aria-label="Seek"
          min={0}
          max={duration || 1}
          step={0.01}
          disabled={!duration}
          value={scrub ?? Math.min(getTime(), duration || 1)}
          onChange={(e) => {
            setScrub(Number(e.target.value));
            seek(Number(e.target.value));
          }}
          onPointerUp={() => setScrub(null)}
        />
        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-gray-500">{fmt(duration)}</span>
        {rate !== 1 && (
          <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[11px] tabular-nums text-accent" title="Shuttle speed (J K L)">
            {rate < 0 ? "◀" : "▶"} {Math.abs(rate)}x
          </span>
        )}
        <button
          className={`h-8 rounded-lg px-2 text-[11px] ${showStats ? "bg-accent/15 text-accent" : "text-gray-500 hover:bg-white/10 hover:text-white"}`}
          onClick={() => setShowStats((v) => !v)}
          aria-pressed={showStats}
          title="Show playback fps, dropped frames and decoder state"
        >
          Stats
        </button>
        <button
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs ${loop ? "bg-accent/15 text-accent" : "text-gray-400 hover:bg-white/10 hover:text-white"}`}
          onClick={toggleLoop}
          title={selected ? "Loop the selected line" : "Loop the whole song"}
          aria-pressed={!!loop}
        >
          <Icon name="loop" className="h-3.5 w-3.5" />
          Loop{loop ? ` ${loop.start.toFixed(1)} to ${loop.end.toFixed(1)}` : ""}
        </button>
      </div>
    </div>
  );
}
