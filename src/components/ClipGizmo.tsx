import { useRef } from "react";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import type { Timeline } from "../model/types";
import { seek, usePlayback } from "../lib/transport";
import { fitSize, transformOf } from "../render/compositor";
import { setLaneKey, writePlacement } from "../lib/keyframes/lanes";
import { focusClip, useKeyframeUi } from "../lib/keyframes/ui";
import { useTimelineUi } from "../timeline/ui";
import * as E from "../timeline/engine";
import { usePlayhead } from "./usePlayhead";

type Drag = { kind: "move" | "scale" | "rotate" | "path"; x0: number; y0: number; tl0: Timeline; moved: boolean; at?: number };

/**
 * On-viewer handles for the selected picture clip (phase 18): drag the box to move it, a corner to scale, the knob to
 * rotate (Shift: 15 degree steps). With auto-key on, or when the value already has keys, each change writes a
 * keyframe at the playhead. The motion path shows where the clip travels; drag its points to move those keys.
 */
export default function ClipGizmo({ w, h }: { w: number; h: number }) {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const { autoKey, showPath } = useKeyframeUi();
  const playing = usePlayback((s) => s.playing);
  const now = usePlayhead();
  const drag = useRef<Drag | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const tl = activeTimeline(doc);
  const clip = focusClip(tl, selected);
  const media = clip && doc.media.find((m) => m.id === clip.mediaId);
  if (!clip || !media || (media.kind !== "video" && media.kind !== "image") || E.isLocked(tl, clip.trackId)) return null;

  const rel = now - clip.start;
  const inside = rel >= 0 && rel <= clip.duration;
  const tf = transformOf(clip, now);
  const size = fitSize(media.width ?? 16, media.height ?? 9, w, h, tf.fit);
  const bw = size.w * tf.scale;
  const bh = size.h * tf.scale;
  const cx = tf.x * w;
  const cy = tf.y * h;

  // motion path: where the centre goes over the clip, plus a point per position key
  const pathKeys = [...new Set([...(clip.anim?.x ?? []), ...(clip.anim?.y ?? [])].map((k) => Math.round(k.t * 1000) / 1000))].sort((a, b) => a - b);
  const path: string[] = [];
  if (showPath && pathKeys.length > 1) {
    const n = Math.min(240, Math.max(20, Math.round(clip.duration * 30)));
    for (let i = 0; i <= n; i++) {
      const p = transformOf(clip, clip.start + (clip.duration * i) / n);
      path.push(`${(p.x * w).toFixed(1)},${(p.y * h).toFixed(1)}`);
    }
  }

  const pt = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const begin = (e: React.PointerEvent, kind: Drag["kind"], at?: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = pt(e);
    drag.current = { kind, x0: p.x, y0: p.y, tl0: tl, moved: false, at };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pt(e);
    if (!d.moved) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) < 2) return;
      d.moved = true;
      useProject.getState().beginGesture();
    }
    const c0 = d.tl0.clips.find((c) => c.id === clip.id)!;
    const t0 = transformOf(c0, now);
    let next = d.tl0;
    if (d.kind === "move") {
      const nx = t0.x + (p.x - d.x0) / w;
      const ny = t0.y + (p.y - d.y0) / h;
      next = writePlacement(next, clip.id, "x", round(nx), rel, autoKey);
      next = writePlacement(next, clip.id, "y", round(ny), rel, autoKey);
    } else if (d.kind === "scale") {
      const ox = t0.x * w;
      const oy = t0.y * h;
      const f = Math.hypot(p.x - ox, p.y - oy) / Math.max(1, Math.hypot(d.x0 - ox, d.y0 - oy));
      next = writePlacement(next, clip.id, "scale", round(Math.max(0.01, Math.min(10, t0.scale * f))), rel, autoKey);
    } else if (d.kind === "rotate") {
      const ox = t0.x * w;
      const oy = t0.y * h;
      const a = (Math.atan2(p.y - oy, p.x - ox) - Math.atan2(d.y0 - oy, d.x0 - ox)) * (180 / Math.PI);
      let r = t0.rotation + a;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      next = writePlacement(next, clip.id, "rotation", Math.round(r * 10) / 10, rel, autoKey);
    } else if (d.kind === "path" && d.at !== undefined) {
      // move the position key at that time (adds the other axis there if only one had a key)
      const k = transformOf(c0, clip.start + d.at);
      next = setLaneKey(next, clip.id, { kind: "clip", name: "x" }, d.at, round(k.x + (p.x - d.x0) / w));
      next = setLaneKey(next, clip.id, { kind: "clip", name: "y" }, d.at, round(k.y + (p.y - d.y0) / h));
    }
    useProject.getState().editDoc((x) => E.onActive(x, () => next));
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) useProject.getState().endGesture();
    else if (d?.kind === "path" && d.at !== undefined) seek(clip.start + d.at);
  };

  const canEdit = inside && !playing;
  const corner = (sx: number, sy: number) => (
    <rect key={`${sx}${sy}`} x={(sx * bw) / 2 - 4} y={(sy * bh) / 2 - 4} width={8} height={8} fill="white" stroke="#5b9dff" className="cursor-nwse-resize" onPointerDown={(e) => begin(e, "scale")} />
  );

  return (
    <svg ref={svg} width={w} height={h} className="pointer-events-none absolute inset-0 z-[15] overflow-visible" onPointerMove={move} onPointerUp={end} onPointerCancel={end} aria-label="Clip placement handles">
      {path.length > 1 && (
        <g>
          <polyline points={path.join(" ")} fill="none" stroke="#facc15" strokeOpacity="0.8" strokeWidth="1.5" strokeDasharray="4 3" />
          {pathKeys.map((t) => {
            const p = transformOf(clip, clip.start + t);
            return (
              <circle
                key={t}
                cx={p.x * w}
                cy={p.y * h}
                r={Math.abs(t - rel) <= 0.02 ? 5.5 : 4}
                fill={Math.abs(t - rel) <= 0.02 ? "#facc15" : "white"}
                stroke="#facc15"
                className="pointer-events-auto cursor-move"
                onPointerDown={(e) => begin(e, "path", t)}
              >
                <title>{`Position key at ${t.toFixed(2)} s: drag to move it, click to jump there`}</title>
              </circle>
            );
          })}
        </g>
      )}
      {canEdit && (
        <g transform={`translate(${cx} ${cy}) rotate(${tf.rotation})`}>
          <rect
            x={-bw / 2}
            y={-bh / 2}
            width={bw}
            height={bh}
            fill="transparent"
            stroke="#5b9dff"
            strokeWidth="1.5"
            className="pointer-events-auto cursor-move"
            onPointerDown={(e) => begin(e, "move")}
          >
            <title>{autoKey ? "Drag to move (auto-key writes a keyframe)" : "Drag to move"}</title>
          </rect>
          <g className="pointer-events-auto">
            {corner(-1, -1)}
            {corner(1, -1)}
            {corner(-1, 1)}
            {corner(1, 1)}
            <line x1={0} y1={-bh / 2} x2={0} y2={-bh / 2 - 22} stroke="#5b9dff" />
            <circle cx={0} cy={-bh / 2 - 22} r={5} fill="white" stroke="#5b9dff" className="cursor-grab" onPointerDown={(e) => begin(e, "rotate")}>
              <title>Drag to rotate (Shift: 15 degree steps)</title>
            </circle>
          </g>
          {autoKey && <circle cx={bw / 2 - 8} cy={-bh / 2 + 8} r={4} fill="#ef4444"><title>Auto-key is on</title></circle>}
        </g>
      )}
    </svg>
  );
}

const round = (n: number) => Math.round(n * 10000) / 10000;
