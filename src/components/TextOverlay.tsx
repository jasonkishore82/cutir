import { useEffect, useRef, useState } from "react";
import { useProject, type Transform } from "../store/project";
import { activeLinesAt, getLineBounds, getWordBounds, hitTestLine, hitTestWord, type LineBounds, type WordBounds } from "../lib/renderer";
import { getTime } from "../lib/transport";
import { transformOf, writeLineTransform } from "../lib/transform";
import { evalKeyframes, keyAt, keyedProps, setKeyAt, useKeyUi, type KeyValues } from "../lib/keyframes";
import type { LyricLine, Project } from "../store/project";
import { setWordKeyAt, wordKeyTarget, wordTransformOf, writeWordTransform, type WordTransform } from "./wordEdit";

/**
 * Whether a change to this line at `now` edits keyframes rather than its resting transform: yes when the playhead is
 * on one of its keyframes, or when auto-key is on and the playhead is inside the line.
 */
function keyTarget(line: LyricLine | undefined, now: number): { t: number; v: KeyValues } | null {
  if (!line || now < line.start || now > line.end) return null;
  const t = now - line.start;
  if (!keyAt(line, t) && !useKeyUi.getState().autoKey) return null;
  return { t, v: evalKeyframes(line.keyframes, t) };
}

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
  /** Every line that moves together when several are selected. `kx`/`ky` = keyframe offset in pixels at drag start. */
  group: Member[];
  collapseTo?: string;
  /** Set when this drag edits a keyframe instead of the resting transform. */
  key: { t: number; v: KeyValues } | null;
};

type Member = { id: string; b0: LineBounds; kx: number; ky: number };

/** A drag on one selected word: edits its own transform (or its keyframes), relative to where the line puts it. */
type WordDrag = {
  mode: Mode;
  lineId: string;
  index: number;
  x0: number;
  y0: number;
  b0: WordBounds;
  tf0: WordTransform;
  ang0: number;
  dist0: number;
  moved: boolean;
  key: { t: number; v: KeyValues } | null;
};

/** A line's box at the playhead plus its keyframe offset in pixels (so a resting move can subtract it). */
function memberOf(id: string, w: number, h: number): Member | null {
  const p = useProject.getState().project;
  const line = p.lines.find((l) => l.id === id);
  if (!line) return null;
  const now = getTime();
  const b0 = getLineBounds(p, line, w, h, now);
  if (!b0) return null;
  const k = evalKeyframes(line.keyframes, now - line.start);
  return { id, b0, kx: k.x * w, ky: k.y * h };
}

/** The x / y path a line's keyframes trace across its life, sampled for the preview. Null when it does not move. */
function motionPath(project: Project, line: LyricLine, w: number, h: number) {
  const props = keyedProps(line.keyframes);
  if (!props.includes("x") && !props.includes("y")) return null;
  const rest = getLineBounds(project, line, w, h);
  if (!rest) return null;
  const dur = line.end - line.start;
  const pts: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const k = evalKeyframes(line.keyframes, (dur * i) / 60);
    pts.push(`${(rest.cx + k.x * w).toFixed(1)},${(rest.cy + k.y * h).toFixed(1)}`);
  }
  const keys = (line.keyframes ?? []).map((kf) => {
    const k = evalKeyframes(line.keyframes, kf.time);
    return { x: rest.cx + k.x * w, y: rest.cy + k.y * h };
  });
  return { points: pts.join(" "), keys };
}

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

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

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
  const drag = useRef<Drag | WordDrag | null>(null);
  const selectedWord = useProject((s) => s.selectedWord);

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
  const b = active ? getLineBounds(project, active.line, w, h, time) : null;
  const others = single ? [] : shownNow.map((a) => ({ id: a.line.id, b: getLineBounds(project, a.line, w, h, time) })).filter((x): x is { id: string; b: LineBounds } => !!x.b);
  const showPath = useKeyUi((s) => s.showPath);
  /* a single word picked on the selected line (double-click): its box replaces the line's handles */
  const wordSel = active && selectedWord?.lineId === active.line.id ? selectedWord : null;
  const wb = wordSel && active ? getWordBounds(project, active.line, w, h, time).find((x) => x.index === wordSel.index) ?? null : null;
  const path = active && showPath && !wordSel ? motionPath(project, active.line, w, h) : null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const startDrag = (e: React.PointerEvent, mode: Mode, id: string, b0: LineBounds, group?: Member[], collapseTo?: string) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const p0 = local(e);
    const members = group ?? [memberOf(id, w, h)].filter((m): m is Member => !!m);
    // one line: keyframes may be the target; several lines always move their resting placement
    const key = members.length <= 1 ? keyTarget(useProject.getState().project.lines.find((l) => l.id === id), getTime()) : null;
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
      group: members,
      collapseTo,
      key,
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
        if (d.key) setKeyAt(d.id, d.key.t, { x: d.key.v.x + dx / w, y: d.key.v.y + dy / h });
        else moveLines(d.group.map((m) => ({ id: m.id, x: (m.b0.cx - m.kx + dx) / w, y: (m.b0.cy - m.ky + dy) / h })));
      } else if (d.mode === "scale") {
        const ratio = Math.hypot(p.x - d.b0.cx, p.y - d.b0.cy) / d.dist0;
        if (d.key) setKeyAt(d.id, d.key.t, { scale: Math.min(8, Math.max(0.05, d.key.v.scale * ratio)) });
        else writeLineTransform(d.id, { scale: Math.min(8, Math.max(0.1, d.tf0.scale * ratio)) });
      } else {
        const ang = Math.atan2(p.y - d.b0.cy, p.x - d.b0.cx);
        let rot = (d.key ? d.key.v.rotation : d.tf0.rotation) + ((ang - d.ang0) * 180) / Math.PI;
        if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
        if (d.key) setKeyAt(d.id, d.key.t, { rotation: Math.round(rot * 10) / 10 });
        else {
          rot = ((((rot + 180) % 360) + 360) % 360) - 180;
          writeLineTransform(d.id, { rotation: Math.round(rot * 10) / 10 });
        }
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

  const startWordDrag = (e: React.PointerEvent, mode: Mode, lineId: string, index: number, b0: WordBounds) => {
    const el = e.currentTarget as HTMLElement;
    const line = useProject.getState().project.lines.find((l) => l.id === lineId);
    if (!line) return;
    el.setPointerCapture(e.pointerId);
    const p0 = local(e);
    const d: WordDrag = {
      mode,
      lineId,
      index,
      x0: p0.x,
      y0: p0.y,
      b0,
      tf0: wordTransformOf(line.wordOverrides?.[index]),
      ang0: Math.atan2(p0.y - b0.cy, p0.x - b0.cx),
      dist0: Math.max(1, Math.hypot(p0.x - b0.cx, p0.y - b0.cy)),
      moved: false,
      key: wordKeyTarget(line, index, getTime(), useKeyUi.getState().autoKey),
    };
    drag.current = d;
    const ck = `word:${lineId}:${index}:${mode}`;

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
          const sx = snapAxis(d.b0.cx + dx, d.b0.halfW, w);
          const sy = snapAxis(d.b0.cy + dy, d.b0.halfH, h);
          dx = sx.v - d.b0.cx;
          dy = sy.v - d.b0.cy;
          g = { x: sx.guide, y: sy.guide };
        }
        setGuides(g);
        if (d.key) setWordKeyAt(lineId, index, d.key.t, { x: d.key.v.x + dx / w, y: d.key.v.y + dy / h }, ck);
        else writeWordTransform(lineId, index, { x: round4(d.tf0.x + dx / w), y: round4(d.tf0.y + dy / h) }, ck);
      } else if (d.mode === "scale") {
        const ratio = Math.hypot(p.x - d.b0.cx, p.y - d.b0.cy) / d.dist0;
        if (d.key) setWordKeyAt(lineId, index, d.key.t, { scale: Math.min(8, Math.max(0.05, d.key.v.scale * ratio)) }, ck);
        else writeWordTransform(lineId, index, { scale: round4(Math.min(8, Math.max(0.1, d.tf0.scale * ratio))) }, ck);
      } else {
        const ang = Math.atan2(p.y - d.b0.cy, p.x - d.b0.cx);
        let rot = (d.key ? d.key.v.rotation : d.tf0.rotation) + ((ang - d.ang0) * 180) / Math.PI;
        if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
        if (d.key) setWordKeyAt(lineId, index, d.key.t, { rotation: Math.round(rot * 10) / 10 }, ck);
        else {
          rot = ((((rot + 180) % 360) + 360) % 360) - 180;
          writeWordTransform(lineId, index, { rotation: Math.round(rot * 10) / 10 }, ck);
        }
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (d.moved) useProject.getState().endGesture();
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
    const now = getTime();
    const hit = hitTestLine(st.project, now, w, h, p.x, p.y);
    /* a word is picked: drag it when grabbed; other clicks on its line do nothing (double-click switches word) */
    const sw = st.selectedWord;
    if (sw && !e.shiftKey && hit?.id === sw.lineId) {
      const on = hitTestWord(st.project, hit, now, w, h, p.x, p.y);
      if (on?.index === sw.index) startWordDrag(e, "move", sw.lineId, sw.index, on);
      return;
    }
    if (sw) st.selectWord(null); // clicking off the line goes back to whole lines
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
    const group = ids.map((id) => memberOf(id, w, h)).filter((x): x is Member => !!x);
    const bounds = group.find((m) => m.id === hit.id)?.b0;
    if (bounds) startDrag(e, "move", hit.id, bounds, group, inGroup ? hit.id : undefined);
  };

  const onStageMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) return;
    const p = local(e);
    const st = useProject.getState();
    const now = getTime();
    const hit = hitTestLine(st.project, now, w, h, p.x, p.y);
    const sw = st.selectedWord;
    if (sw && hit?.id === sw.lineId) {
      e.currentTarget.style.cursor = hitTestWord(st.project, hit, now, w, h, p.x, p.y)?.index === sw.index ? "move" : "default";
      return;
    }
    e.currentTarget.style.cursor = hit ? "move" : "default";
  };

  /* double-click a selected line to pick the word under the pointer; double-click another word to switch */
  const onStageDouble = (e: React.MouseEvent<HTMLDivElement>) => {
    const p = local(e);
    const st = useProject.getState();
    const now = getTime();
    const hit = hitTestLine(st.project, now, w, h, p.x, p.y); // skips locked layers
    if (!hit || !st.selectedIds.includes(hit.id)) return;
    const word = hitTestWord(st.project, hit, now, w, h, p.x, p.y);
    if (word) st.selectWord({ lineId: hit.id, index: word.index });
  };

  /* arrow keys nudge by 1px, Shift for 10px */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const st = useProject.getState();
    if (e.key === "Escape" && st.selectedWord) {
      st.selectWord(null); // back to the whole line
      return;
    }
    if (!b && !others.length) return;
    if (e.key === "Escape") {
      st.select(null);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
    if (!d) return;
    e.preventDefault();
    /* a picked word: nudge the word (its keyframe when the playhead is on one) */
    if (wordSel && active) {
      const { lineId, index } = wordSel;
      const key = wordKeyTarget(active.line, index, getTime(), useKeyUi.getState().autoKey);
      if (key) setWordKeyAt(lineId, index, key.t, { x: key.v.x + d[0] / w, y: key.v.y + d[1] / h }, `nudge-wkey:${lineId}:${index}`);
      else {
        const tf = wordTransformOf(active.line.wordOverrides?.[index]);
        writeWordTransform(lineId, index, { x: round4(tf.x + d[0] / w), y: round4(tf.y + d[1] / h) }, `nudge-word:${lineId}:${index}`);
      }
      return;
    }
    // one line on a keyframe (or with auto-key): nudge the keyframe
    const one = st.selectedIds.length === 1 ? st.project.lines.find((l) => l.id === st.selectedIds[0]) : undefined;
    const key = keyTarget(one, getTime());
    if (one && key) {
      setKeyAt(one.id, key.t, { x: key.v.x + d[0] / w, y: key.v.y + d[1] / h }, `nudge-key:${one.id}`);
      return;
    }
    const moves = st.selectedIds
      .map((id) => {
        const line = st.project.lines.find((l) => l.id === id);
        const lb = line ? getLineBounds(st.project, line, w, h) : null;
        return lb ? { id, x: (lb.cx + d[0]) / w, y: (lb.cy + d[1]) / h } : null;
      })
      .filter((x): x is { id: string; x: number; y: number } => !!x);
    moveLines(moves, `nudge-pos:${st.selectedIds.join(",")}`);
  };


  const handleBox = "absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border-[1.5px] border-accent bg-white shadow";

  /** Box, corner scale handles and the rotate handle for a line or a word. */
  const handles = (box: LineBounds, what: string, scaleNow: number, onDown: (e: React.PointerEvent, mode: Mode) => void) => {
    const corner = (sx: number, sy: number) => {
      const r = rotate(sx * box.halfW, sy * box.halfH, box.rotation);
      return { x: box.cx + r.x, y: box.cy + r.y };
    };
    const top = corner(0, -1);
    const a = rotate(0, -ROTATE_GAP, box.rotation);
    const hx = top.x + a.x;
    const hy = top.y + a.y;
    return (
      <>
        <div
          className="pointer-events-none absolute rounded-[3px] border-[1.5px] border-accent"
          style={{ left: box.cx - box.halfW, top: box.cy - box.halfH, width: box.halfW * 2, height: box.halfH * 2, transform: `rotate(${box.rotation}deg)` }}
        />
        {([[-1, -1, "nwse-resize"], [1, -1, "nesw-resize"], [1, 1, "nwse-resize"], [-1, 1, "nesw-resize"]] as const).map(([sx, sy, cursor]) => {
          const c = corner(sx, sy);
          return (
            <div
              key={`${sx}${sy}`}
              role="slider"
              aria-label={`Scale ${what}`}
              aria-valuenow={Math.round(scaleNow * 100)}
              className={handleBox}
              style={{ left: c.x, top: c.y, cursor }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button === 0) onDown(e, "scale");
              }}
            />
          );
        })}
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={w} height={h} aria-hidden>
          <line x1={top.x} y1={top.y} x2={hx} y2={hy} stroke="rgb(91 157 255)" strokeWidth="1.5" />
        </svg>
        <div
          role="slider"
          aria-label={`Rotate ${what}`}
          aria-valuenow={Math.round(box.rotation)}
          className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-accent bg-white shadow"
          style={{ left: hx, top: hy, cursor: "grab" }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button === 0) onDown(e, "rotate");
          }}
        />
      </>
    );
  };

  return (
    <div
      ref={stage}
      data-text-stage
      tabIndex={0}
      aria-label="Text on the video. Click a line to select it, drag to move, arrow keys to nudge. Double-click a selected line to pick one word, Escape to go back to the line."
      onPointerDown={onStageDown}
      onPointerMove={onStageMove}
      onDoubleClick={onStageDouble}
      onKeyDown={onKeyDown}
      className="absolute inset-0 touch-none rounded-lg outline-none"
    >
      {guides.x !== undefined && <span className="pointer-events-none absolute inset-y-0 w-px bg-accent/80" style={{ left: guides.x }} />}
      {guides.y !== undefined && <span className="pointer-events-none absolute inset-x-0 h-px bg-accent/80" style={{ top: guides.y }} />}

      {path && (
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={w} height={h} aria-hidden>
          <polyline points={path.points} fill="none" stroke="rgb(var(--accent))" strokeOpacity="0.75" strokeWidth="1.5" strokeDasharray="4 4" />
          {path.keys.map((k, i) => (
            <rect key={i} x={k.x - 4} y={k.y - 4} width="8" height="8" transform={`rotate(45 ${k.x} ${k.y})`} fill="white" stroke="rgb(var(--accent))" strokeWidth="1.5" />
          ))}
        </svg>
      )}

      {others.map((o) => (
        <div
          key={o.id}
          className="pointer-events-none absolute rounded-[3px] border-[1.5px] border-dashed border-accent"
          style={{ left: o.b.cx - o.b.halfW, top: o.b.cy - o.b.halfH, width: o.b.halfW * 2, height: o.b.halfH * 2, transform: `rotate(${o.b.rotation}deg)` }}
        />
      ))}

      {b && active && !wordSel && handles(b, "text", transformOf(active.line.id).scale, (e, mode) => startDrag(e, mode, active.line.id, b))}

      {b && active && wordSel && (
        <>
          {/* the word's line stays outlined faintly; the word gets the handles (none until its box is known) */}
          <div
            className="pointer-events-none absolute rounded-[3px] border border-dashed border-accent/60"
            style={{ left: b.cx - b.halfW, top: b.cy - b.halfH, width: b.halfW * 2, height: b.halfH * 2, transform: `rotate(${b.rotation}deg)` }}
          />
          {wb && handles(wb, "word", wordTransformOf(active.line.wordOverrides?.[wordSel.index]).scale, (e, mode) => startWordDrag(e, mode, wordSel.lineId, wordSel.index, wb))}
        </>
      )}
    </div>
  );
}
