import { useEffect, useRef, useState } from "react";
import { useProject, type Transform } from "../store/project";
import { activeLinesAt, getLineBounds, hitTestLine, type LineBounds } from "../lib/renderer";
import { getTime } from "../lib/transport";
import { transformOf, writeLineTransform } from "../lib/transform";

const SNAP_PX = 6;
const MARGIN = 0.05;
const MOVE_THRESHOLD = 3;
const ROTATE_GAP = 26;

type Mode = "move" | "scale" | "rotate";
type Drag = {
  mode: Mode;
  id: string;
  x0: number;
  y0: number;
  b0: LineBounds;
  tf0: Transform;
  ang0: number;
  dist0: number;
  moved: boolean;
  /** Every line that moves together when several are selected. */
  group: { id: string; b0: LineBounds }[];
  collapseTo?: string;
};

/** Snap one axis: centre of the block to the canvas centre, or its edges to the 5% margins. */
function snapAxis(c: number, half: number, size: number) {
  const tries = [
    { target: size / 2, at: c },
    { target: size * MARGIN, at: c - half },
    { target: size * (1 - MARGIN), at: c + half },
  ];
  let best: { diff: number; guide: number } | null = null;
  for (const t of tries) {
    const diff = t.target - t.at;
    if (Math.abs(diff) <= SNAP_PX && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, guide: t.target };
  }
  return best ? { v: c + best.diff, guide: best.guide } : { v: c, guide: undefined };
}

/** Place several lines in one undo step. */
function moveLines(moves: { id: string; x: number; y: number }[], key?: string) {
  const by = new Map(moves.map((m) => [m.id, m]));
  useProject.getState().update(
    (p) => ({
      ...p,
      lines: p.lines.map((l) => {
        const m = by.get(l.id);
        if (!m) return l;
        return { ...l, styleOverride: { ...l.styleOverride, transform: { ...l.styleOverride?.transform, x: m.x, y: m.y } } };
      }),
    }),
    key
  );
}

const rotate = (x: number, y: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
};

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
};

/**
 * Selection box and handles over the preview. Click a line to select it, drag to move, drag a corner to scale,
 * drag the round handle to rotate. Everything lives in the line's own style override, so one drag is one undo step.
 */
export default function TextOverlay({ w, h }: { w: number; h: number }) {
  const project = useProject((s) => s.project);
  const selectedId = useProject((s) => s.selectedLineId);
  const selectedIds = useProject((s) => s.selectedIds);
  const [time, setTime] = useState(() => getTime());
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  /* follow the playhead so the box tracks text while playing */
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const loop = () => {
      const t = getTime();
      if (t !== last) {
        last = t;
        setTime(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const shownNow = activeLinesAt(project, time).filter((a) => selectedIds.includes(a.line.id) && !a.locked);
  const single = selectedIds.length === 1;
  const active = single && selectedId ? shownNow.find((a) => a.line.id === selectedId) : undefined;
  const b = active ? getLineBounds(project, active.line, w, h) : null;
  const others = single ? [] : shownNow.map((a) => ({ id: a.line.id, b: getLineBounds(project, a.line, w, h) })).filter((x): x is { id: string; b: LineBounds } => !!x.b);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const startDrag = (e: React.PointerEvent, mode: Mode, id: string, b0: LineBounds, group: { id: string; b0: LineBounds }[] = [{ id, b0 }], collapseTo?: string) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const p0 = local(e);
    const d: Drag = {
      mode,
      id,
      x0: p0.x,
      y0: p0.y,
      b0,
      tf0: transformOf(id),
      ang0: Math.atan2(p0.y - b0.cy, p0.x - b0.cx),
      dist0: Math.max(1, Math.hypot(p0.x - b0.cx, p0.y - b0.cy)),
      moved: false,
      group,
      collapseTo,
    };
    drag.current = d;

    const move = (ev: PointerEvent) => {
      const p = local(ev);
      if (!d.moved) {
        if (Math.hypot(p.x - d.x0, p.y - d.y0) < MOVE_THRESHOLD) return;
        d.moved = true;
        useProject.getState().beginGesture(); // everything until release is one undo step
      }
      if (d.mode === "move") {
        let dx = p.x - d.x0;
        let dy = p.y - d.y0;
        let g: { x?: number; y?: number } = {};
        if (!ev.altKey) {
          // snap the whole group by its outer box
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const m of d.group) {
            const a = (m.b0.rotation * Math.PI) / 180;
            const hw = Math.abs(Math.cos(a)) * m.b0.halfW + Math.abs(Math.sin(a)) * m.b0.halfH;
            const hh = Math.abs(Math.sin(a)) * m.b0.halfW + Math.abs(Math.cos(a)) * m.b0.halfH;
            minX = Math.min(minX, m.b0.cx - hw);
            maxX = Math.max(maxX, m.b0.cx + hw);
            minY = Math.min(minY, m.b0.cy - hh);
            maxY = Math.max(maxY, m.b0.cy + hh);
          }
          const sx = snapAxis((minX + maxX) / 2 + dx, (maxX - minX) / 2, w);
          const sy = snapAxis((minY + maxY) / 2 + dy, (maxY - minY) / 2, h);
          dx = sx.v - (minX + maxX) / 2;
          dy = sy.v - (minY + maxY) / 2;
          g = { x: sx.guide, y: sy.guide };
        }
        setGuides(g);
        moveLines(d.group.map((m) => ({ id: m.id, x: (m.b0.cx + dx) / w, y: (m.b0.cy + dy) / h })));
      } else if (d.mode === "scale") {
        const dist = Math.hypot(p.x - d.b0.cx, p.y - d.b0.cy);
        writeLineTransform(d.id, { scale: Math.min(8, Math.max(0.1, d.tf0.scale * (dist / d.dist0))) });
      } else {
        const ang = Math.atan2(p.y - d.b0.cy, p.x - d.b0.cx);
        let rot = d.tf0.rotation + ((ang - d.ang0) * 180) / Math.PI;
        if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
        rot = ((((rot + 180) % 360) + 360) % 360) - 180;
        writeLineTransform(d.id, { rotation: Math.round(rot * 10) / 10 });
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (d.moved) useProject.getState().endGesture();
      else if (d.collapseTo) useProject.getState().select(d.collapseTo);
      drag.current = null;
      setGuides({});
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onStageDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.focus({ preventScroll: true });
    const p = local(e);
    const st = useProject.getState();
    const hit = hitTestLine(st.project, getTime(), w, h, p.x, p.y);
    if (!hit) {
      st.select(null);
      return;
    }
    if (e.shiftKey) {
      st.select(hit.id, true);
      return;
    }
    const inGroup = st.selectedIds.length > 1 && st.selectedIds.includes(hit.id);
    if (!inGroup) st.select(hit.id);
    const ids = inGroup ? st.selectedIds : [hit.id];
    const group = ids
      .map((id) => {
        const line = st.project.lines.find((l) => l.id === id);
        const gb = line ? getLineBounds(st.project, line, w, h) : null;
        return gb ? { id, b0: gb } : null;
      })
      .filter((x): x is { id: string; b0: LineBounds } => !!x);
    const bounds = group.find((m) => m.id === hit.id)?.b0;
    if (bounds) startDrag(e, "move", hit.id, bounds, group, inGroup ? hit.id : undefined);
  };

  const onStageMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) return;
    const p = local(e);
    const st = useProject.getState();
    e.currentTarget.style.cursor = hitTestLine(st.project, getTime(), w, h, p.x, p.y) ? "move" : "default";
  };

  /* arrow keys nudge by 1px, Shift for 10px */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTyping(e.target) || (!b && !others.length)) return;
    if (e.key === "Escape") {
      useProject.getState().select(null);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
    if (!d) return;
    e.preventDefault();
    const st = useProject.getState();
    const moves = st.selectedIds
      .map((id) => {
        const line = st.project.lines.find((l) => l.id === id);
        const lb = line ? getLineBounds(st.project, line, w, h) : null;
        return lb ? { id, x: (lb.cx + d[0]) / w, y: (lb.cy + d[1]) / h } : null;
      })
      .filter((x): x is { id: string; x: number; y: number } => !!x);
    moveLines(moves, `nudge-pos:${st.selectedIds.join(",")}`);
  };

  const corner = (sx: number, sy: number) => {
    const r = rotate(sx * b!.halfW, sy * b!.halfH, b!.rotation);
    return { x: b!.cx + r.x, y: b!.cy + r.y };
  };
  const handleBox = "absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border-[1.5px] border-accent bg-white shadow";

  return (
    <div
      ref={stage}
      data-text-stage
      tabIndex={0}
      aria-label="Text on the video. Click a line to select it, drag to move, arrow keys to nudge."
      onPointerDown={onStageDown}
      onPointerMove={onStageMove}
      onKeyDown={onKeyDown}
      className="absolute inset-0 touch-none rounded-lg outline-none"
    >
      {guides.x !== undefined && <span className="pointer-events-none absolute inset-y-0 w-px bg-accent/80" style={{ left: guides.x }} />}
      {guides.y !== undefined && <span className="pointer-events-none absolute inset-x-0 h-px bg-accent/80" style={{ top: guides.y }} />}

      {others.map((o) => (
        <div
          key={o.id}
          className="pointer-events-none absolute rounded-[3px] border-[1.5px] border-dashed border-accent"
          style={{ left: o.b.cx - o.b.halfW, top: o.b.cy - o.b.halfH, width: o.b.halfW * 2, height: o.b.halfH * 2, transform: `rotate(${o.b.rotation}deg)` }}
        />
      ))}

      {b && active && (
        <>
          <div
            className="pointer-events-none absolute rounded-[3px] border-[1.5px] border-accent"
            style={{ left: b.cx - b.halfW, top: b.cy - b.halfH, width: b.halfW * 2, height: b.halfH * 2, transform: `rotate(${b.rotation}deg)` }}
          />
          {([[-1, -1, "nwse-resize"], [1, -1, "nesw-resize"], [1, 1, "nwse-resize"], [-1, 1, "nesw-resize"]] as const).map(([sx, sy, cursor]) => {
            const c = corner(sx, sy);
            return (
              <div
                key={`${sx}${sy}`}
                role="slider"
                aria-label="Scale text"
                aria-valuenow={Math.round(transformOf(active.line.id).scale * 100)}
                className={handleBox}
                style={{ left: c.x, top: c.y, cursor }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 0) startDrag(e, "scale", active.line.id, b);
                }}
              />
            );
          })}
          {(() => {
            const top = corner(0, -1);
            const a = rotate(0, -ROTATE_GAP, b.rotation);
            const hx = top.x + a.x;
            const hy = top.y + a.y;
            return (
              <>
                <svg className="pointer-events-none absolute inset-0 overflow-visible" width={w} height={h} aria-hidden>
                  <line x1={top.x} y1={top.y} x2={hx} y2={hy} stroke="rgb(91 157 255)" strokeWidth="1.5" />
                </svg>
                <div
                  role="slider"
                  aria-label="Rotate text"
                  aria-valuenow={Math.round(b.rotation)}
                  className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-accent bg-white shadow"
                  style={{ left: hx, top: hy, cursor: "grab" }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.button === 0) startDrag(e, "rotate", active.line.id, b);
                  }}
                />
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
