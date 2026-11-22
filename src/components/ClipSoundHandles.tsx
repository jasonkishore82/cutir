import { useState } from "react";
import type { Clip } from "../model/types";
import { editTimeline } from "../timeline/ui";
import { fadeFromPx, fadePath, fracToGain, gainLabel, gainToFrac } from "../lib/audio/clipEdit";

/**
 * Drag handles drawn on a selected audio clip (phase 21): a fade handle at each top corner and a gain line across the
 * clip. They write the same fields as the Audio tab (fadeIn, fadeOut, volume), so both stay in step and undo works.
 */
export default function ClipSoundHandles({ clip, pps, height }: { clip: Clip; pps: number; height: number }) {
  const [drag, setDrag] = useState<string | null>(null);
  const width = clip.duration * pps;
  if (width < 36 || height < 26) return null;
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  const gain = clip.volume ?? 1;
  const set = (p: Partial<Clip>, key: string) => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, ...p } : c)) }), key);

  /** Follow the pointer until it is released: `move` gets the pointer relative to the clip's box. */
  const track = (e: React.PointerEvent, label: string, move: (x: number, y: number, w: number, h: number) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const box = (e.currentTarget as HTMLElement).closest("[data-clip-id]")!.getBoundingClientRect();
    setDrag(label);
    const mv = (ev: PointerEvent) => move(ev.clientX - box.left, ev.clientY - box.top, box.width, box.height);
    const up = () => {
      setDrag(null);
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const y = gainToFrac(gain) * height;
  const knob = "absolute z-[4] h-2.5 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-sm border border-black/60 bg-white shadow";
  return (
    <>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={height} aria-hidden>
        {fadeIn > 0 && <path d={fadePath("in", 0, fadeIn * pps, height)} fill="none" stroke="rgb(255 255 255 / 0.8)" strokeWidth={1} />}
        {fadeOut > 0 && <path d={fadePath("out", width - fadeOut * pps, fadeOut * pps, height)} fill="none" stroke="rgb(255 255 255 / 0.8)" strokeWidth={1} />}
      </svg>
      <div
        className="absolute left-0 right-0 z-[3] h-2 -translate-y-1/2 cursor-ns-resize"
        style={{ top: y }}
        role="slider"
        aria-label="Clip gain"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={gain}
        aria-valuetext={gainLabel(gain)}
        title={`Clip gain ${gainLabel(gain)}. Drag up or down; it snaps to 0 dB.`}
        onPointerDown={(e) => track(e, "gain", (_x, py, _w, h) => set({ volume: fracToGain(py / h) }, `gain:${clip.id}`))}
        onDoubleClick={(e) => (e.stopPropagation(), set({ volume: undefined }, `gain:${clip.id}`))}
      >
        <div className={`absolute left-0 right-0 top-1/2 h-px ${gain === 1 ? "bg-white/40" : "bg-yellow-300"}`} />
      </div>
      <span className={knob} style={{ left: Math.max(5, fadeIn * pps), top: 1 }} role="slider" aria-label="Fade in" aria-valuenow={fadeIn} title={`Fade in ${fadeIn.toFixed(2)} s. Drag to change; double-click to remove.`} onPointerDown={(e) => track(e, "fade in", (px) => set({ fadeIn: fadeFromPx(px, pps, clip.duration, fadeOut) || undefined }, `fi:${clip.id}`))} onDoubleClick={(e) => (e.stopPropagation(), set({ fadeIn: undefined }, `fi:${clip.id}`))} />
      <span className={knob} style={{ left: Math.min(width - 5, width - fadeOut * pps), top: 1 }} role="slider" aria-label="Fade out" aria-valuenow={fadeOut} title={`Fade out ${fadeOut.toFixed(2)} s. Drag to change; double-click to remove.`} onPointerDown={(e) => track(e, "fade out", (px, _y, w) => set({ fadeOut: fadeFromPx(w - px, pps, clip.duration, fadeIn) || undefined }, `fo:${clip.id}`))} onDoubleClick={(e) => (e.stopPropagation(), set({ fadeOut: undefined }, `fo:${clip.id}`))} />
      {drag && (
        <span className="pointer-events-none absolute left-1 top-4 z-[5] rounded bg-black/80 px-1 text-[10px] text-white" role="status">
          {drag === "gain" ? gainLabel(gain) : drag === "fade in" ? `Fade in ${fadeIn.toFixed(2)} s` : `Fade out ${fadeOut.toFixed(2)} s`}
        </span>
      )}
    </>
  );
}
