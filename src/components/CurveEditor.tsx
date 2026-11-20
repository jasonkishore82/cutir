import { useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { getTime, seek } from "../lib/transport";
import { EASE_NAMES, evalLane, modeOf, type Key, type KeyMode } from "../lib/keyframes/engine";
import { replaceLane, shapeLaneKeys, type LaneInfo } from "../lib/keyframes/lanes";
import { focusClip, isSelected, selectKey, useKeyframeUi, type KeySel } from "../lib/keyframes/ui";
import { editTimeline, useTimelineUi } from "../timeline/ui";
import { usePlayhead } from "./usePlayhead";
import { shownLanes } from "./KeyLane";

const PAD = { l: 44, r: 10, t: 10, b: 18 };
const COLOURS = ["#5b9dff", "#f59e0b", "#34d399", "#f472b6", "#a78bfa", "#fb7185", "#22d3ee", "#facc15"];

/**
 * The curve editor (phase 18): value over time for the shown lanes of the selected clip. Drag keys (Shift: snap),
 * drag bezier handles, scroll to zoom time, Fit, lock axes, and an ease menu for the selected keys.
 */
export default function CurveEditor() {
  const doc = useProject((s) => s.doc);
  const selectedClips = useTimelineUi((s) => s.selected);
  const { shownLanes: chosen, selected } = useKeyframeUi();
  const now = usePlayhead();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 180 });
  const [view, setView] = useState<{ t0: number; t1: number } | null>(null);
  const [lock, setLock] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const [range, setRange] = useState<{ lo: number; hi: number } | null>(null);
  const drag = useRef<{ kind: "key" | "out" | "in"; lane: LaneInfo; key: Key; x0: number; y0: number; keys0: Key[]; moved: boolean } | null>(null);

  const tl = activeTimeline(doc);
  const clip = focusClip(tl, selectedClips);
  const ready = !!clip;
  const lanes = useMemo(() => (clip ? shownLanes(clip, doc, chosen).filter((l) => l.valueKind === "number" || l.valueKind === "angle") : []), [clip, doc, chosen]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ready, chosen.length]); // the graph box only exists once there is something to draw

  if (!clip) return <div className="grid h-full place-items-center text-[12px] text-gray-500">Select one clip to edit its curves.</div>;
  if (!lanes.length) return <div className="grid h-full place-items-center text-[12px] text-gray-500">No keyframes on this clip yet. Add some in the Animate card (Motion tab), or tick lanes to show with ▤.</div>;

  // axes: time inside the clip, value in the lanes' shown units (each lane normalised to 0..1 of its own range so several can share the graph)
  const t0 = view?.t0 ?? 0;
  const t1 = view?.t1 ?? clip.duration;
  const gw = size.w - PAD.l - PAD.r;
  const gh = size.h - PAD.t - PAD.b;
  const norm = (l: LaneInfo, v: number) => {
    const lo = range?.lo ?? l.min;
    const hi = range?.hi ?? l.max;
    return (v * l.factor - lo) / Math.max(1e-6, hi - lo);
  };
  const denorm = (l: LaneInfo, n: number) => {
    const lo = range?.lo ?? l.min;
    const hi = range?.hi ?? l.max;
    return (lo + n * (hi - lo)) / l.factor;
  };
  const X = (t: number) => PAD.l + ((t - t0) / Math.max(1e-6, t1 - t0)) * gw;
  const Y = (n: number) => PAD.t + (1 - n) * gh;
  const tOf = (x: number) => t0 + ((x - PAD.l) / gw) * (t1 - t0);
  const nOf = (y: number) => 1 - (y - PAD.t) / gh;

  const path = (l: LaneInfo) => {
    const pts: string[] = [];
    const n = Math.max(2, Math.round(gw / 2));
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      const v = evalLane(l.keys, t, l.base, l.valueKind);
      pts.push(`${X(t).toFixed(1)},${Y(norm(l, typeof v === "number" ? v : 0)).toFixed(1)}`);
    }
    return pts.join(" ");
  };

  const onKeyDown = (e: React.PointerEvent, lane: LaneInfo, key: Key, kind: "key" | "out" | "in") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (kind === "key") {
      const sel: KeySel = { clipId: clip.id, laneKey: lane.key, t: key.t };
      if (e.shiftKey || e.ctrlKey) selectKey(sel, true);
      else if (!isSelected(selected, clip.id, lane.key, key.t)) selectKey(sel);
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, lane, key, x0: e.clientX, y0: e.clientY, keys0: lane.keys, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
      d.moved = true;
      useProject.getState().beginGesture();
    }
    const dt = lock.x ? 0 : ((e.clientX - d.x0) / gw) * (t1 - t0);
    const dn = lock.y ? 0 : -(e.clientY - d.y0) / gh;
    const i = d.keys0.indexOf(d.key);
    let keys: Key[];
    if (d.kind === "key") {
      let t = Math.max(0, Math.min(clip.duration, d.key.t + dt));
      if (e.shiftKey) {
        const stops = [getTime() - clip.start, 0, clip.duration, ...d.keys0.filter((k) => k !== d.key).map((k) => k.t)];
        const near = stops.find((s) => Math.abs(s - t) < (8 / gw) * (t1 - t0));
        if (near !== undefined) t = near;
      }
      const v0 = typeof d.key.v === "number" ? d.key.v : 0;
      const v = denorm(d.lane, norm(d.lane, v0) + dn);
      keys = d.keys0.map((k) => (k === d.key ? { ...k, t: Math.round(t * 1000) / 1000, v: Math.round(v * 10000) / 10000 } : k));
    } else {
      // handles: time fraction of the span to the neighbour, value fraction of the value difference
      const nb = d.kind === "out" ? d.keys0[i + 1] : d.keys0[i - 1];
      if (!nb) return;
      const span = Math.abs(nb.t - d.key.t) || 1e-6;
      const dv = (typeof nb.v === "number" ? nb.v : 0) - (typeof d.key.v === "number" ? d.key.v : 0);
      const h0 = (d.kind === "out" ? d.key.out : d.key.in) ?? [0.33, 0.33];
      const sign = d.kind === "out" ? 1 : -1;
      const ft = Math.max(0, Math.min(1, h0[0] + (sign * dt) / span));
      const fv = dv !== 0 ? h0[1] + (denorm(d.lane, dn) - denorm(d.lane, 0)) / dv : h0[1];
      keys = d.keys0.map((k) => (k === d.key ? { ...k, mode: "bezier" as const, [d.kind]: [ft, fv] } : k));
    }
    useProject.getState().editDoc((doc2) => ({ ...doc2, timelines: doc2.timelines.map((x) => (x.id === tl.id ? replaceLane(x, clip.id, d.lane.id, keys) : x)) }));
    if (d.kind === "key") useKeyframeUi.setState({ selected: [{ clipId: clip.id, laneKey: d.lane.key, t: keys[i].t }] });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) useProject.getState().endGesture();
  };

  const applyShape = (mode: KeyMode, easing?: Key["easing"]) => {
    const sel = selected.filter((s) => s.clipId === clip.id);
    editTimeline((t) => lanes.reduce((acc, l) => {
      const times = sel.filter((s) => s.laneKey === l.key).map((s) => s.t);
      return times.length ? shapeLaneKeys(acc, clip.id, l.id, times, mode, easing) : acc;
    }, t));
  };
  const fit = () => {
    setView(null);
    const vals = lanes.flatMap((l) => l.keys.map((k) => (typeof k.v === "number" ? k.v * l.factor : 0)));
    if (vals.length) {
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const pad = (hi - lo || 10) * 0.15;
      setRange({ lo: lo - pad, hi: hi + pad });
    } else setRange(null);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const t = tOf(e.clientX - box.current!.getBoundingClientRect().left);
    const f = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    setView({ t0: Math.max(0, t - (t - t0) * f), t1: Math.min(clip.duration, t + (t1 - t) * f) });
  };

  const btn = (on = false) => `rounded border px-1.5 py-0.5 text-[10px] ${on ? "border-accent text-accent" : "border-edge text-gray-400 hover:bg-raised"}`;
  const anySel = selected.some((s) => s.clipId === clip.id);
  // (not a hook: this runs after the early returns above)
  const ticks: number[] = [];
  const step = t1 - t0 > 20 ? 5 : t1 - t0 > 8 ? 2 : t1 - t0 > 3 ? 1 : 0.5;
  for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-6; t += step) ticks.push(+t.toFixed(3));

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-edge px-2 py-1 text-[11px] text-gray-400">
        <span className="mr-1 text-gray-300">Curves</span>
        {lanes.map((l, i) => (
          <span key={l.key} className="flex items-center gap-1" style={{ color: COLOURS[i % COLOURS.length] }}>
            ● {l.group !== "Placement" && l.group !== "Sound" ? `${l.group}: ` : ""}{l.label}
          </span>
        ))}
        <span className="flex-1" />
        <button className={btn()} onClick={fit} title="Fit the keyframes in view">Fit</button>
        <button className={btn(lock.x)} aria-pressed={lock.x} onClick={() => setLock((l) => ({ ...l, x: !l.x }))} title="Lock time while dragging">Lock time</button>
        <button className={btn(lock.y)} aria-pressed={lock.y} onClick={() => setLock((l) => ({ ...l, y: !l.y }))} title="Lock value while dragging">Lock value</button>
        <span className="mx-1 text-gray-600">|</span>
        <span className={anySel ? "" : "opacity-40"}>Ease:</span>
        <button className={btn()} disabled={!anySel} onClick={() => applyShape("hold")}>hold</button>
        <button className={btn()} disabled={!anySel} onClick={() => applyShape("bezier")}>bezier</button>
        {EASE_NAMES.map((e) => (
          <button key={e} className={btn()} disabled={!anySel} onClick={() => applyShape(e === "linear" ? "linear" : "ease", e)}>
            {e}
          </button>
        ))}
        <span className="ml-2 text-gray-600">Ctrl+wheel zooms time · Shift snaps</span>
      </div>
      <div
        ref={box}
        className="relative min-h-0 flex-1 select-none"
        onWheel={onWheel}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={(e) => {
          // double-click on the graph (not on a key or handle): add a key on the first lane at that point
          const tag = (e.target as Element).tagName.toLowerCase();
          if (tag === "rect" || tag === "circle") return;
          const r = box.current!.getBoundingClientRect();
          const t = Math.max(0, Math.min(clip.duration, tOf(e.clientX - r.left)));
          const l = lanes[0];
          const v = denorm(l, Math.max(0, Math.min(1, nOf(e.clientY - r.top))));
          editTimeline((x) => replaceLane(x, clip.id, l.id, [...l.keys.filter((k) => Math.abs(k.t - t) > 0.02), { t, v, mode: "ease", easing: "ease-in-out" }]));
        }}
      >
        <svg width={size.w} height={size.h} className="absolute inset-0">
          {/* grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((n) => (
            <g key={n}>
              <line x1={PAD.l} x2={size.w - PAD.r} y1={Y(n)} y2={Y(n)} stroke="rgb(var(--edge))" strokeWidth="1" />
              <text x={PAD.l - 4} y={Y(n) + 3} textAnchor="end" fontSize="9" fill="rgb(var(--gray-500))">
                {(() => {
                  const l = lanes[0];
                  const lo = range?.lo ?? l.min;
                  const hi = range?.hi ?? l.max;
                  return `${Math.round((lo + n * (hi - lo)) * 10) / 10}${lanes.length === 1 ? l.unit : ""}`;
                })()}
              </text>
            </g>
          ))}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={X(t)} x2={X(t)} y1={PAD.t} y2={size.h - PAD.b} stroke="rgb(var(--edge))" strokeWidth="1" />
              <text x={X(t)} y={size.h - 5} textAnchor="middle" fontSize="9" fill="rgb(var(--gray-500))">{t}s</text>
            </g>
          ))}
          {/* playhead */}
          {now >= clip.start && now <= clip.start + clip.duration && <line x1={X(now - clip.start)} x2={X(now - clip.start)} y1={PAD.t} y2={size.h - PAD.b} stroke="#facc15" strokeWidth="1" />}
          {/* curves */}
          {lanes.map((l, i) => (
            <g key={l.key}>
              <polyline points={path(l)} fill="none" stroke={COLOURS[i % COLOURS.length]} strokeWidth="1.5" />
              {l.keys.map((k, j) => {
                const v = typeof k.v === "number" ? k.v : 0;
                const x = X(k.t);
                const y = Y(norm(l, v));
                const on = isSelected(selected, clip.id, l.key, k.t);
                const bez = modeOf(k) === "bezier";
                const next = l.keys[j + 1];
                const prev = l.keys[j - 1];
                const handle = (kind: "out" | "in", nb: Key | undefined, h: [number, number] | undefined) => {
                  if (!bez || !nb) return null;
                  const hh = h ?? [0.33, 0.33];
                  const nbv = typeof nb.v === "number" ? nb.v : 0;
                  const sign = kind === "out" ? 1 : -1;
                  const hx = X(k.t + sign * hh[0] * Math.abs(nb.t - k.t));
                  const hy = Y(norm(l, v + hh[1] * (nbv - v)));
                  return (
                    <g key={kind}>
                      <line x1={x} y1={y} x2={hx} y2={hy} stroke={COLOURS[i % COLOURS.length]} strokeOpacity="0.6" strokeWidth="1" />
                      <circle cx={hx} cy={hy} r="3.5" fill="white" stroke={COLOURS[i % COLOURS.length]} className="cursor-move" onPointerDown={(e) => onKeyDown(e, l, k, kind)} />
                    </g>
                  );
                };
                return (
                  <g key={k.t}>
                    {handle("out", next, k.out)}
                    {handle("in", prev, k.in)}
                    <rect
                      x={x - 4.5}
                      y={y - 4.5}
                      width="9"
                      height="9"
                      transform={`rotate(45 ${x} ${y})`}
                      fill={on ? "#facc15" : "white"}
                      stroke={on ? "white" : COLOURS[i % COLOURS.length]}
                      strokeWidth="1.5"
                      className="cursor-move"
                      onPointerDown={(e) => onKeyDown(e, l, k, "key")}
                      onDoubleClick={() => seek(clip.start + k.t)}
                    >
                      <title>{`${l.label} ${Math.round(v * l.factor * 100) / 100}${l.unit} at ${k.t.toFixed(2)} s (${modeOf(k)}${k.easing ? ` ${k.easing}` : ""})`}</title>
                    </rect>
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
