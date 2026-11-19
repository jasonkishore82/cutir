import { Icon } from "./ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../store/project";
import { ensureFont } from "../lib/fonts";
import { ASPECT_RATIO, drawFrame, type MediaSource } from "../lib/renderer";
import { getTime, pause, seek, setFallbackDuration, setLoop, setSource, tick, toggle, usePlayback } from "../lib/transport";

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

  /* without audio, playback length follows the lyrics */
  useEffect(() => {
    setFallbackDuration(lines.length ? Math.max(...lines.map((l) => l.end)) + 1 : 0);
  }, [lines]);

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

      drawFrame(ctx, useProject.getState().project, t, canvas.width, canvas.height, { bg });

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
        <canvas
          ref={canvasRef}
          width={Math.round(box.w * dpr)}
          height={Math.round(box.h * dpr)}
          style={{ width: box.w, height: box.h }}
          className="rounded-lg shadow-2xl shadow-black/70 ring-1 ring-white/10"
        />
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
        <button
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs ${loop ? "bg-accent/15 text-accent" : "text-gray-400 hover:bg-white/10 hover:text-white"}`}
          onClick={toggleLoop}
          title={selected ? "Loop the selected line" : "Loop the whole song"}
          aria-pressed={!!loop}
        >
          <Icon name="loop" className="h-3.5 w-3.5" />
          Loop{loop ? ` ${loop.start.toFixed(1)}–${loop.end.toFixed(1)}` : ""}
        </button>
      </div>
    </div>
  );
}
