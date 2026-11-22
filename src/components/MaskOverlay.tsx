import { useRef } from "react";
import { create } from "zustand";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { editTimeline } from "../timeline/ui";
import * as FX from "../timeline/effects";
import { usePlayhead } from "./usePlayhead";
import { paramsAt } from "../lib/effects";
import { DEFAULT_PATH, smoothSegments, type Pt } from "../lib/masks";
import { boxHandles, dragBox, hitHandle, insertPoint, isPathShape, movePoint, pathHandles, pathKeysAfterEdit, removePoint } from "../lib/maskEdit";
import { trackerOffset } from "../lib/track/tracker";
import type { Key } from "../lib/keyframes/engine";
import type { ParamKey } from "../model/types";

/** Which mask effect is being edited on the viewer. */
export const useMaskUi = create<{ clipId: string | null; fxId: string | null; set: (clipId: string | null, fxId: string | null) => void }>((set) => ({ clipId: null, fxId: null, set: (clipId, fxId) => set({ clipId, fxId }) }));

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * The mask editor on the viewer (phase 22): the shape is drawn over the picture and edited where it is. Polygon and
 * bezier shapes have a handle per point (drag to move, click an empty spot to add, double-click a point to remove it);
 * a rectangle or ellipse has its centre and the middle of each edge. With point keyframes on the shape, an edit writes
 * a key at the playhead, so the shape can change over time point by point.
 */
export default function MaskOverlay() {
  const { clipId, fxId, set } = useMaskUi();
  const doc = useProject((s) => s.doc);
  const now = usePlayhead();
  const drag = useRef<string | null>(null);
  const clip = clipId ? activeTimeline(doc).clips.find((c) => c.id === clipId) : undefined;
  const fx = clip?.effects.find((e) => e.id === fxId);
  if (!clip || !fx || fx.type !== "mask") return null;

  const rel = now - clip.start;
  const p = paramsAt(fx, rel);
  const shape = String(p.shape ?? "ellipse");
  const tr = p.follow === true && clip.trackers?.[0]?.samples.length ? trackerOffset(clip.trackers[0], rel) : { x: 0, y: 0 };
  const off = { x: num(p.offsetX, 0) / 100 + tr.x, y: num(p.offsetY, 0) / 100 + tr.y };
  const points: Pt[] = Array.isArray(p.path) && (p.path as Pt[]).length >= 3 ? (p.path as Pt[]) : DEFAULT_PATH;
  const centre = (p.center as { x: number; y: number } | undefined) ?? { x: 0.5, y: 0.5 };
  const box = { center: centre, width: num(p.width, 60), height: num(p.height, 60) };
  const handles = isPathShape(shape) ? pathHandles(points, off) : boxHandles(box, off);
  const keyed = !!fx.keys?.path?.length;

  const writeParams = (patch: Record<string, unknown>) => editTimeline((t) => FX.updateEffect(t, clip.id, fx.id, { params: patch }), `mask:${fx.id}`);
  const writePath = (pts: Pt[], countChanged: boolean) => {
    if (!keyed) return writeParams({ path: pts });
    const keys = pathKeysAfterEdit(fx.keys!.path as Key[], Math.max(0, rel), pts, countChanged) as ParamKey[];
    editTimeline((t) => FX.updateEffect(t, clip.id, fx.id, { params: { path: pts }, keys: { ...(fx.keys ?? {}), path: keys } }), `mask:${fx.id}`);
  };
  const frac = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  // the outline, in a 0..100 box that stretches with the picture
  const X = (v: number) => (v + off.x) * 100;
  const Y = (v: number) => (v + off.y) * 100;
  let d = "";
  if (isPathShape(shape)) {
    if (shape === "bezier") {
      const s = smoothSegments(points, true);
      if (s) d = `M${X(s.start[0])} ${Y(s.start[1])} ` + s.segs.map((g) => `C${X(g.c1[0])} ${Y(g.c1[1])} ${X(g.c2[0])} ${Y(g.c2[1])} ${X(g.to[0])} ${Y(g.to[1])}`).join(" ") + " Z";
    } else d = `M${points.map((q) => `${X(q[0])} ${Y(q[1])}`).join(" L")} Z`;
  } else {
    const cx = (centre.x + off.x) * 100, cy = (centre.y + off.y) * 100, hw = box.width / 2, hh = box.height / 2;
    d = shape === "rectangle" ? `M${cx - hw} ${cy - hh} H${cx + hw} V${cy + hh} H${cx - hw} Z` : `M${cx - hw} ${cy} A${hw} ${hh} 0 1 0 ${cx + hw} ${cy} A${hw} ${hh} 0 1 0 ${cx - hw} ${cy} Z`;
  }

  return (
    <div
      className="absolute inset-0 z-20 cursor-crosshair touch-none"
      role="application"
      aria-label="Mask editor: drag the handles. In a polygon or bezier shape, click an empty spot to add a point and double-click a point to remove it."
      onPointerDown={(e) => {
        e.stopPropagation();
        const pos = frac(e);
        const hit = hitHandle(handles, pos, 0.025);
        if (hit) drag.current = hit.id;
        else if (isPathShape(shape)) {
          const ins = insertPoint(points, pos, off);
          drag.current = `p${ins.index}`;
          writePath(ins.points, true);
        } else return;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const id = drag.current;
        if (!id) return;
        const pos = frac(e);
        if (isPathShape(shape)) writePath(movePoint(points, Number(id.slice(1)), pos, off), false);
        else writeParams(dragBox(id, pos, box, off));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={(e) => {
        const hit = hitHandle(handles, frac(e), 0.025);
        if (hit && hit.kind === "point") writePath(removePoint(points, Number(hit.id.slice(1))), points.length > 3);
      }}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <path d={d} fill="rgb(250 204 21 / 0.12)" stroke="#facc15" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray={keyed ? undefined : "4 3"} />
      </svg>
      {handles.map((h) => (
        <span key={h.id} className={`pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 border border-black ${h.kind === "centre" ? "rounded-full bg-yellow-300" : h.kind === "edge" ? "bg-white" : "rounded-sm bg-yellow-200"}`} style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%` }} />
      ))}
      <button className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-[11px] text-white hover:bg-black" onPointerDown={(e) => e.stopPropagation()} onClick={() => set(null, null)}>
        Done
      </button>
      {keyed && <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-yellow-300">Keyframed: edits are keys at the playhead</span>}
    </div>
  );
}
