import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui";
import { createPortal } from "react-dom";
import WaveSurfer from "wavesurfer.js";
import { layerIdOf, linesOfLayer, orderByLayers, uid, useProject, type Layer, type LyricLine, type Position, type TransitionType } from "../store/project";
import { addLayer, moveLayer, moveLineToLayer, removeLayer, updateLayer, updateLayerStyle } from "../store/layers";
import { getTime, play, seek, setLoop, usePlayback, pause } from "../lib/transport";
import { addKeyAtPlayhead, copyKey, pasteKey, removeKey, splitKeyframes, updateKey, useKeyUi } from "../lib/keyframes";
import { EASING_NAMES, TRANSITIONS, TRANSITION_NAMES } from "../lib/animations";
import TrackLanes, { energyPath } from "./TrackLanes";
import CurveEditor from "./CurveEditor";
import { useKeyframeUi } from "../lib/keyframes/ui";
import { keyframePasteApplies } from "../lib/keyframes/commands";
import { activeTimeline, beatsOf } from "../model/convert";
import { isBeat } from "../model/types";
import * as TE from "../timeline/engine";
import { beatSnapOn, timecode, useTimelineUi } from "../timeline/ui";
import { handleTimelineKey, loopRange, sourceEdit, sourceEditProblem, SOURCE_EDITS } from "../timeline/commands";
import { useMedia } from "../store/media";
import { useCacheInfo } from "../render/cache";

const SNAP = 0.05;
const MIN_LEN = 0.1;
const WAVE_H = 56;
const RULER_H = 18;
const LANE_H = 44;
const GUTTER = 176; // width of the fixed layer-header column
const MAX_LAYERS = 8;
const SNAP_PX = 8; // beat snapping reach, in pixels

const snap = (t: number) => Math.round(Math.round(t / SNAP) * SNAP * 100) / 100;
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
};

type Drag = { id: string; mode: "move" | "l" | "r"; x0: number; start: number; end: number };
type KeyDrag = { lineId: string; id: string; x0: number; time0: number; dur: number; moved: boolean };

/* ---------- line operations (shared by the context menu and keyboard shortcuts) ---------- */

let clipboard: LyricLine | null = null; // the last copied block (in memory only)
const store = () => useProject.getState();

function duplicateLine(id: string) {
  const l = store().project.lines.find((x) => x.id === id);
  if (!l) return;
  const len = l.end - l.start;
  // the copy sits right after the original, in the same layer
  const copy: LyricLine = { ...l, id: uid(), start: snap(l.end), end: snap(l.end + len), words: undefined };
  store().update((p) => ({ ...p, lines: p.lines.flatMap((x) => (x.id === id ? [x, { ...copy, layerId: layerIdOf(p, l) }] : [x])) }));
  store().select(copy.id);
}

function copyLine(id: string) {
  const l = store().project.lines.find((x) => x.id === id);
  if (l) clipboard = { ...l };
}

/** Paste the copied block into a layer, starting at time t. Returns the new id. */
function pasteLine(layerId: string, t: number): string | null {
  if (!clipboard) return null;
  const len = clipboard.end - clipboard.start;
  const line: LyricLine = { ...clipboard, id: uid(), start: snap(t), end: snap(t + len), layerId, words: undefined };
  store().update((p) => orderByLayers({ ...p, lines: [...p.lines, line] }));
  store().select(line.id);
  store().setActiveLayer(layerId);
  return line.id;
}

function addTextLine(layerId: string, t: number): string {
  const line: LyricLine = { id: uid(), text: "New text", start: snap(t), end: snap(t + 3), layerId };
  store().update((p) => orderByLayers({ ...p, lines: [...p.lines, line] }));
  store().select(line.id);
  store().setActiveLayer(layerId);
  return line.id;
}

function deleteLine(id: string) {
  store().update((p) => ({ ...p, lines: p.lines.filter((x) => x.id !== id) }));
  if (store().selectedLineId === id) store().select(null);
}

/** Cut a block in two at time t; the words are divided in proportion to where the cut falls. */
function splitLineAt(id: string, t: number) {
  const l = store().project.lines.find((x) => x.id === id);
  if (!l || t <= l.start + MIN_LEN || t >= l.end - MIN_LEN) return;
  const words = l.text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return;
  const k = Math.min(words.length - 1, Math.max(1, Math.round((words.length * (t - l.start)) / (l.end - l.start))));
  const cut = snap(t);
  const [k1, k2] = splitKeyframes(l.keyframes, cut - l.start);
  const second: LyricLine = { ...l, id: uid(), text: words.slice(k).join(" "), start: cut, end: l.end, words: undefined, keyframes: k2 };
  store().update((p) => ({
    ...p,
    lines: p.lines.flatMap((x) => (x.id === id ? [{ ...l, text: words.slice(0, k).join(" "), end: cut, words: undefined, keyframes: k1 }, second] : [x])),
  }));
  store().select(second.id);
}

function setLineEdge(id: string, edge: "start" | "end", t: number) {
  const l = store().project.lines.find((x) => x.id === id);
  if (!l) return;
  const v = snap(t);
  if (edge === "start" && v < l.end - MIN_LEN) store().updateLine(id, { start: Math.max(0, v) });
  if (edge === "end" && v > l.start + MIN_LEN) store().updateLine(id, { end: v });
}

/** The next line on the same layer (by start time), if any. */
function nextOnLayer(p: { layers: Layer[]; lines: LyricLine[] }, l: LyricLine): LyricLine | undefined {
  const lid = layerIdOf(p, l);
  return p.lines
    .filter((x) => x.id !== l.id && layerIdOf(p, x) === lid && x.start >= l.start)
    .sort((a, b) => a.start - b.start)[0];
}

function setLineTransition(id: string, type: TransitionType | null) {
  store().update((p) => ({
    ...p,
    lines: p.lines.map((x) => {
      if (x.id !== id) return x;
      if (type === null) {
        const { transition: _t, ...rest } = x;
        void _t;
        return rest;
      }
      return { ...x, transition: { type, ms: x.transition?.ms ?? p.transition.ms } };
    }),
  }));
}

/* ---------- right-click menu ---------- */

type MenuItem = { label: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean } | "sep";

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // keep the menu inside the window
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);

  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[300] min-w-[210px] rounded-md border border-edge bg-panel py-1 text-xs shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="my-1 border-t border-edge" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
            className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left hover:bg-edge disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent ${it.danger ? "text-red-400" : "text-gray-200"}`}
          >
            <span>{it.label}</span>
            {it.hint && <span className="text-[11px] text-gray-500">{it.hint}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  );
}

/* ---------- small icons ---------- */

const Eye = ({ on }: { on: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    {on ? <circle cx="12" cy="12" r="3" /> : <path d="M3 3l18 18" />}
  </svg>
);
const Lock = ({ on }: { on: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d={on ? "M8 11V7a4 4 0 018 0v4" : "M8 11V7a4 4 0 017.5-2"} />
  </svg>
);

/* ---------- one layer's header cell (the fixed left column) ---------- */

function LayerHeader({ layer, index, count, active }: { layer: Layer; index: number; count: number; active: boolean }) {
  const st = useProject.getState;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(layer.name);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null); // where the settings popup floats
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // the popup is rendered in document.body so no lane header can paint over it; close it on outside click or scroll
  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popRef.current?.contains(t)) setMenu(null);
    };
    const close = () => setMenu(null);
    window.addEventListener("mousedown", off);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);

  const commit = () => {
    setRenaming(false);
    const n = name.trim();
    if (n && n !== layer.name) st().update((p) => updateLayer(p, layer.id, { name: n }));
    else setName(layer.name);
  };

  const icon = "h-6 w-6 flex items-center justify-center rounded text-gray-400 hover:bg-edge hover:text-gray-100";
  const style = layer.style ?? {};

  return (
    <div
      ref={ref}
      data-gutter
      onClick={() => st().setActiveLayer(layer.id)}
      className={`relative flex h-full items-center gap-1 border-l-2 pl-1.5 pr-1 ${active ? "border-l-accent bg-accent/10" : "border-l-transparent"}`}
    >
      {renaming ? (
        <input
          autoFocus
          className="field !py-0 !text-xs min-w-0 flex-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") (setName(layer.name), setRenaming(false));
          }}
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate text-xs ${layer.visible ? "text-gray-200" : "text-gray-600 line-through"}`}
          title={`${layer.name} (double-click to rename)`}
          onDoubleClick={() => (setName(layer.name), setRenaming(true))}
        >
          {layer.name}
        </span>
      )}

      <button className={icon} title={layer.visible ? "Hide layer" : "Show layer"} aria-label={layer.visible ? "Hide layer" : "Show layer"} onClick={(e) => (e.stopPropagation(), st().update((p) => updateLayer(p, layer.id, { visible: !layer.visible })))}>
        <Eye on={layer.visible} />
      </button>
      <button className={`${icon} ${layer.locked ? "text-accent" : ""}`} title={layer.locked ? "Unlock layer" : "Lock layer"} aria-label={layer.locked ? "Unlock layer" : "Lock layer"} onClick={(e) => (e.stopPropagation(), st().update((p) => updateLayer(p, layer.id, { locked: !layer.locked })))}>
        <Lock on={layer.locked} />
      </button>
      <button className={icon} title="Layer style and order" aria-label="Layer settings" onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }));
      }}>
        <Icon name="dots" className="h-4 w-4" />
      </button>

      {menu && createPortal(
        <div
          ref={popRef}
          className="fixed z-[200] w-56 space-y-2.5 rounded border border-edge bg-panel p-3 text-xs shadow-xl"
          style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 236)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 320)) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="font-medium text-gray-200">{layer.name} style</div>
          <label className="block">
            <span className="label">Position</span>
            <select className="field" value={style.position ?? ""} onChange={(e) => st().update((p) => updateLayerStyle(p, layer.id, { position: (e.target.value || undefined) as Position | undefined }))}>
              <option value="">Same as project</option>
              <option value="top">Top</option>
              <option value="center">Center</option>
              <option value="bottom">Bottom</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Size: {style.fontSize ?? "project"}</span>
            <input
              type="range"
              min={16}
              max={240}
              value={style.fontSize ?? st().project.style.fontSize}
              className="w-full accent-accent"
              onChange={(e) => st().update((p) => updateLayerStyle(p, layer.id, { fontSize: Number(e.target.value) }), `layer-size:${layer.id}`)}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="label !mb-0">Color</span>
            <input type="color" value={style.color ?? st().project.style.color} onChange={(e) => st().update((p) => updateLayerStyle(p, layer.id, { color: e.target.value }), `layer-color:${layer.id}`)} />
            {style.color && (
              <button className="text-[11px] text-gray-500 hover:text-gray-200" onClick={() => st().update((p) => updateLayerStyle(p, layer.id, { color: undefined }))}>reset</button>
            )}
          </label>
          <div className="flex items-center gap-1 border-t border-edge pt-2">
            <button className="rounded border border-edge px-2 py-1 hover:bg-edge disabled:opacity-40" disabled={index === 0} onClick={() => st().update((p) => moveLayer(p, layer.id, -1))}>Down</button>
            <button className="rounded border border-edge px-2 py-1 hover:bg-edge disabled:opacity-40" disabled={index === count - 1} onClick={() => st().update((p) => moveLayer(p, layer.id, 1))}>Up</button>
            <span className="flex-1" />
            <button
              className={`rounded border px-2 py-1 disabled:opacity-40 ${confirm ? "border-red-600 bg-red-700 text-white" : "border-edge text-red-400 hover:bg-edge"}`}
              disabled={count <= 1}
              onClick={() => {
                if (!confirm) return setConfirm(true);
                st().update((p) => removeLayer(p, layer.id));
                setMenu(null);
              }}
              title={count <= 1 ? "A project needs at least one layer" : "Delete this layer and its lines (Ctrl+Z undoes it)"}
            >
              {confirm ? "Really delete?" : "Delete"}
            </button>
          </div>
          <p className="text-[10px] text-gray-500">"Up" draws this layer above the others.</p>
        </div>,
        document.body
      )}
    </div>
  );
}

/* ---------- the timeline ---------- */

export default function Timeline() {
  const layers = useProject((s) => s.project.layers);
  const lines = useProject((s) => s.project.lines);
  const audioUrl = useProject((s) => s.project.audio?.url);
  const selectedIds = useProject((s) => s.selectedIds);
  const activeLayerId = useProject((s) => (s.project.layers.some((l) => l.id === s.activeLayerId) ? s.activeLayerId : s.project.layers[0].id));
  const syncMode = useProject((s) => s.syncMode);
  const syncIndex = useProject((s) => s.syncIndex);
  const duration = usePlayback((s) => s.duration);
  const loop = usePlayback((s) => s.loop);

  const [pps, setPps] = useState(80); // pixels per second
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true); // keep the playhead in view while playing
  const followRef = useRef(true);
  followRef.current = follow;
  const userScrollAt = useRef(0); // last time the USER scrolled; auto-follow backs off for a few seconds after
  const programmatic = useRef(false); // true while our own code moves scrollLeft
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const waveRef = useRef<HTMLDivElement>(null);
  const headTopRef = useRef<HTMLDivElement>(null);
  const headLanesRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const drag = useRef<Drag | null>(null);
  const endSet = useRef<Set<string>>(new Set()); // lines whose end was set with Enter in this sync pass
  const [editingId, setEditingId] = useState<string | null>(null);

  const docEnd = useProject((s) => TE.timelineEnd(activeTimeline(s.doc)));
  const tlMarkers = useProject((s) => activeTimeline(s.doc).markers);
  const tlIn = useProject((s) => activeTimeline(s.doc).inPoint);
  const tlOut = useProject((s) => activeTimeline(s.doc).outPoint);
  const fps = useProject((s) => s.doc.settings.fps);
  const tool = useTimelineUi((s) => s.tool);
  const cacheRanges = useCacheInfo((s) => s.ranges);
  const snapping = useTimelineUi((s) => s.snapping);
  const beatSnap = useTimelineUi((s) => s.beatSnap);
  const beats = useProject((s) => beatsOf(activeTimeline(s.doc)));
  const energy = useProject((s) => s.project.energy);
  const beatsRef = useRef(beats);
  beatsRef.current = beats;
  const sourceName = useMedia((s) => s.items.find((i) => i.id === useTimelineUi.getState().sourceId)?.name);
  useTimelineUi((s) => s.sourceId); // re-render when the source changes
  const total = useMemo(
    () => Math.max(duration, lines.reduce((m, l) => Math.max(m, l.end), 0) + 2, docEnd + 2, 10),
    [duration, lines, docEnd]
  );

  /* multi-track shortcuts (tools, markers, in/out, blade, nudge, source edits); after the lyric shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleTimelineKey(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const width = Math.ceil(total * pps);

  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? layers[0];
  const globalIndex = useMemo(() => new Map(lines.map((l, i) => [l.id, i])), [lines]);

  /* ---------- waveform (wavesurfer renders only; our transport owns playback) ---------- */
  useEffect(() => {
    wsRef.current?.destroy();
    wsRef.current = null;
    if (!audioUrl || !waveRef.current) return;
    const ws = WaveSurfer.create({
      container: waveRef.current,
      url: audioUrl,
      height: WAVE_H,
      waveColor: "#5b6577",
      progressColor: "#5b6577",
      cursorWidth: 0,
      interact: false,
      hideScrollbar: true,
      autoScroll: false,
      autoCenter: false,
      minPxPerSec: pps,
    });
    ws.setMuted(true);
    wsRef.current = ws;
    return () => {
      ws.destroy();
      if (wsRef.current === ws) wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  useEffect(() => {
    try {
      wsRef.current?.zoom(pps);
    } catch {
      /* not decoded yet; minPxPerSec was applied at creation */
    }
  }, [pps]);

  /* ---------- playhead: driven from the same clock as the preview ---------- */
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const t = getTime();
      const tx = `translateX(${t * pps}px)`;
      if (headTopRef.current) headTopRef.current.style.transform = tx;
      if (headLanesRef.current) headLanesRef.current.style.transform = tx;

      // follow the playhead, but never fight the user: back off for 4s after they scroll by hand
      const sc = scrollRef.current;
      if (sc && followRef.current && usePlayback.getState().playing && Date.now() - userScrollAt.current > 4000) {
        const x = t * pps; // position inside the time area (the layer column is not part of it)
        if (x > sc.scrollLeft + sc.clientWidth - GUTTER - 40 || x < sc.scrollLeft) {
          const target = Math.max(0, Math.round(x - 40));
          if (target !== Math.round(sc.scrollLeft)) {
            programmatic.current = true;
            sc.scrollLeft = target;
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pps]);

  /* ---------- mouse wheel: sideways, Ctrl+wheel zooms around the cursor, Shift/over the layer column = up/down ---------- */
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userScrollAt.current = Date.now();
      const overGutter = !!(e.target as HTMLElement).closest?.("[data-gutter]");
      if (e.shiftKey || overGutter) {
        sc.scrollTop += e.deltaY;
      } else if (e.ctrlKey || e.metaKey) {
        const rect = sc.getBoundingClientRect();
        const cursorX = Math.max(GUTTER, e.clientX - rect.left); // measured from the time area's left edge below
        const timeAtCursor = (sc.scrollLeft + cursorX - GUTTER) / ppsRef.current;
        const next = Math.min(300, Math.max(4, Math.round(ppsRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
        setPps(next);
        requestAnimationFrame(() => {
          programmatic.current = true;
          sc.scrollLeft = Math.max(0, timeAtCursor * next - (cursorX - GUTTER));
        });
      } else {
        sc.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      }
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, []);

  /* ---------- visible time window (beat ticks and the energy curve draw only what is in view) ---------- */
  const [view, setView] = useState({ t0: 0, t1: 60 });
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const update = () => {
      const v = { t0: Math.max(0, sc.scrollLeft / pps - 1), t1: (sc.scrollLeft + sc.clientWidth) / pps + 1 };
      setView(v);
      useTimelineUi.setState({ view: v });
    };
    update();
    sc.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      sc.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [pps]);

  /** Snap a time to the nearest beat within reach, when beat snapping is on (Alt flips snapping). */
  const toBeat = (t: number, alt: boolean) => (beatSnapOn(alt) ? TE.snapToBeat(beatsRef.current, t, SNAP_PX / ppsRef.current) : t);

  const fitToView = () => {
    const sc = scrollRef.current;
    if (!sc) return;
    setPps(Math.min(300, Math.max(4, Math.floor((sc.clientWidth - GUTTER - 16) / Math.max(total, 1)))));
    requestAnimationFrame(() => {
      programmatic.current = true;
      sc.scrollLeft = 0;
    });
  };

  /* ---------- seeking by dragging on ruler / waveform ---------- */
  const seekFromEvent = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect(); // left edge = time 0
    seek(Math.max(0, toBeat((e.clientX - rect.left) / pps, e.altKey)));
  };
  const onScrubDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  };
  const onScrubMove = (e: React.PointerEvent) => {
    if (e.buttons & 1) seekFromEvent(e);
  };

  /* ---------- block dragging / resizing (and dragging between layers) ---------- */
  const onBlockDown = (e: React.PointerEvent, id: string, mode: Drag["mode"]) => {
    e.stopPropagation();
    const st = useProject.getState();
    const line = st.project.lines.find((l) => l.id === id);
    if (!line) return;
    const layerId = layerIdOf(st.project, line);
    if (e.shiftKey) {
      st.select(id, true); // Shift-click adds to or removes from the selection
      return;
    }
    st.select(id);
    st.setActiveLayer(layerId);
    if (st.project.layers.find((l) => l.id === layerId)?.locked) return; // locked layers can be selected, not changed
    e.currentTarget.setPointerCapture(e.pointerId);
    if (st.syncMode) st.setSyncIndex(linesOfLayer(st.project, layerId).findIndex((l) => l.id === id));
    drag.current = { id, mode, x0: e.clientX, start: line.start, end: line.end };
    st.beginGesture();
  };
  const onBlockMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x0) / pps;
    let start = d.start;
    let end = d.end;
    // an edge near a beat lands on it (beat snapping on), else times keep to the 0.05 s grid
    const edge = (t: number) => {
      const b = toBeat(t, e.altKey);
      return b !== t ? b : snap(t);
    };
    if (d.mode === "move") {
      const len = d.end - d.start;
      const s0 = d.start + dt;
      const bs = toBeat(s0, e.altKey);
      const be = toBeat(s0 + len, e.altKey) - len;
      // whichever edge is closer to a beat wins; with no beat in reach keep to the grid
      const onBeat = bs !== s0 || be !== s0;
      const pick = !onBeat ? snap(s0) : bs === s0 ? be : be === s0 ? bs : Math.abs(bs - s0) <= Math.abs(be - s0) ? bs : be;
      start = Math.max(0, pick);
      end = onBeat ? start + len : snap(start + len);
    } else if (d.mode === "l") {
      start = Math.min(Math.max(0, edge(d.start + dt)), d.end - MIN_LEN);
    } else {
      end = Math.max(edge(d.end + dt), d.start + MIN_LEN);
    }
    const st = useProject.getState();
    st.updateLine(d.id, { start, end });

    // dragging a block up/down into another lane moves it to that layer
    if (d.mode === "move" && lanesRef.current) {
      const top = lanesRef.current.getBoundingClientRect().top;
      const li = Math.floor((e.clientY - top) / LANE_H);
      const target = st.project.layers[li];
      const line = st.project.lines.find((l) => l.id === d.id);
      if (target && line && !target.locked && layerIdOf(st.project, line) !== target.id) {
        st.update((p) => moveLineToLayer(p, d.id, target.id));
        st.setActiveLayer(target.id);
      }
    }
  };
  const onBlockUp = () => {
    if (!drag.current) return;
    drag.current = null;
    useProject.getState().endGesture();
  };

  /* ---------- transition markers between consecutive lines ---------- */
  const projTransition = useProject((s) => s.project.transition);
  const gapMarks = (layerLines: LyricLine[]) => {
    const sorted = [...layerLines].sort((a, b) => a.start - b.start);
    const out: { from: string; at: number; label: string; ms: number }[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const tr = a.transition ?? projTransition;
      const gap = b.start - a.end;
      if (tr.type === "none" || gap < -1e-6 || gap > tr.ms / 1000) continue; // only gaps where it actually plays
      out.push({ from: a.id, at: (a.end + b.start) / 2, label: TRANSITIONS[tr.type].label, ms: tr.ms });
    }
    return out;
  };

  /* ---------- keyframe diamonds: click to jump the playhead, drag to retime ---------- */
  const selKey = useKeyUi((s) => s.selected);
  const keyDrag = useRef<KeyDrag | null>(null);
  const onKeyDown = (e: React.PointerEvent, l: LyricLine, id: string, time0: number, locked: boolean) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = useProject.getState();
    st.select(l.id);
    useKeyUi.setState({ selected: { lineId: l.id, id } });
    if (locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    keyDrag.current = { lineId: l.id, id, x0: e.clientX, time0, dur: l.end - l.start, moved: false };
  };
  const onKeyMove = (e: React.PointerEvent) => {
    const d = keyDrag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x0) < 3) return;
      d.moved = true;
      useProject.getState().beginGesture();
    }
    const fps = useProject.getState().project.fps;
    const line = useProject.getState().project.lines.find((x) => x.id === d.lineId);
    const raw = d.time0 + (e.clientX - d.x0) / pps;
    const onBeat = line ? toBeat(line.start + raw, e.altKey) - line.start : raw; // beats are on the timeline's clock
    const t = Math.min(d.dur, Math.max(0, onBeat));
    updateKey(d.lineId, d.id, { time: onBeat !== raw ? t : Math.round(t * fps) / fps });
  };
  const onKeyUp = () => {
    const d = keyDrag.current;
    if (!d) return;
    keyDrag.current = null;
    if (d.moved) {
      useProject.getState().endGesture();
      // the playhead follows the keyframe to its new time (keyframes are re-sorted on every edit)
      const l = useProject.getState().project.lines.find((x) => x.id === d.lineId);
      const kf = l?.keyframes?.find((k) => k.id === d.id);
      if (l && kf) seek(l.start + kf.time);
    } else {
      const l = useProject.getState().project.lines.find((x) => x.id === d.lineId);
      if (l) seek(l.start + d.time0);
    }
  };

  /* ---------- add / edit text blocks ---------- */
  const addBlockAt = (layer: Layer, e: React.MouseEvent<HTMLDivElement>) => {
    if (layer.locked) return;
    const rect = e.currentTarget.getBoundingClientRect(); // left edge = time 0
    const t = Math.max(0, snap((e.clientX - rect.left) / pps));
    setEditingId(addTextLine(layer.id, t));
  };

  /* ---------- right-click menus ---------- */
  type Ctx = { x: number; y: number } & (
    | { kind: "block"; lineId: string }
    | { kind: "lane"; layerId: string; time: number }
    | { kind: "key"; lineId: string; keyId: string }
  );
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const closeCtx = useCallback(() => setCtx(null), []);

  const menuItems = (c: Ctx): MenuItem[] => {
    const p = useProject.getState().project;
    const now = getTime();

    if (c.kind === "key") {
      const l = p.lines.find((x) => x.id === c.lineId);
      const kf = l?.keyframes?.find((k) => k.id === c.keyId);
      if (!l || !kf) return [];
      const edit = !p.layers.find((x) => x.id === layerIdOf(p, l))?.locked;
      return [
        { label: "Go to keyframe", onClick: () => seek(l.start + kf.time) },
        "sep",
        ...EASING_NAMES.map((e) => ({ label: `${kf.easing === e ? "✓ " : "   "}Easing: ${e}`, disabled: !edit, onClick: () => updateKey(l.id, kf.id, { easing: e }) })),
        "sep",
        { label: "Copy keyframe", onClick: () => copyKey(l.id, kf.id) },
        { label: "Paste keyframe at playhead", disabled: !edit || !useKeyUi.getState().clipboard, onClick: () => pasteKey(l.id, now) },
        "sep",
        { label: "Delete keyframe", hint: "Del", danger: true, disabled: !edit, onClick: () => removeKey(l.id, kf.id) },
      ];
    }

    if (c.kind === "lane") {
      const layer = p.layers.find((l) => l.id === c.layerId);
      if (!layer) return [];
      const edit = !layer.locked;
      return [
        { label: "Add text here", hint: "Double-click", disabled: !edit, onClick: () => setEditingId(addTextLine(layer.id, c.time)) },
        { label: "Add text at playhead", disabled: !edit, onClick: () => setEditingId(addTextLine(layer.id, now)) },
        { label: "Paste", hint: "Ctrl+V", disabled: !edit || !clipboard, onClick: () => pasteLine(layer.id, c.time) },
        "sep",
        { label: layer.visible ? "Hide layer" : "Show layer", onClick: () => store().update((q) => updateLayer(q, layer.id, { visible: !layer.visible })) },
        { label: layer.locked ? "Unlock layer" : "Lock layer", onClick: () => store().update((q) => updateLayer(q, layer.id, { locked: !layer.locked })) },
      ];
    }

    const l = p.lines.find((x) => x.id === c.lineId);
    if (!l) return [];
    const layer = p.layers.find((x) => x.id === layerIdOf(p, l));
    const edit = !layer?.locked;
    const inside = now > l.start + MIN_LEN && now < l.end - MIN_LEN;
    const multiWord = l.text.split(/\s+/).filter(Boolean).length > 1;
    const targets = p.layers.filter((x) => x.id !== layer?.id && !x.locked);
    return [
      { label: "Edit text", hint: "Double-click", disabled: !edit, onClick: () => setEditingId(l.id) },
      { label: "Duplicate", hint: "Ctrl+D", disabled: !edit, onClick: () => duplicateLine(l.id) },
      { label: "Copy", hint: "Ctrl+C", onClick: () => copyLine(l.id) },
      "sep",
      { label: "Split at playhead", disabled: !edit || !inside || !multiWord, onClick: () => splitLineAt(l.id, now) },
      { label: "Add keyframe at playhead", hint: "K", disabled: !edit || now < l.start || now > l.end, onClick: () => addKeyAtPlayhead(l.id, now) },
      "sep",
      ...(() => {
        const next = nextOnLayer(p, l);
        const eff = l.transition ?? p.transition;
        const items: MenuItem[] = TRANSITION_NAMES.map((n) => ({
          label: `${eff.type === n ? "✓ " : "   "}To next line: ${n === "none" ? "cut" : TRANSITIONS[n].label}`,
          hint: !l.transition && n === p.transition.type ? "default" : undefined,
          disabled: !edit || !next,
          onClick: () => setLineTransition(l.id, n),
        }));
        if (l.transition) items.push({ label: "   Use the project default", disabled: !edit, onClick: () => setLineTransition(l.id, null) });
        return items;
      })(),
      { label: "Set start to playhead", disabled: !edit || now >= l.end - MIN_LEN, onClick: () => setLineEdge(l.id, "start", now) },
      { label: "Set end to playhead", disabled: !edit || now <= l.start + MIN_LEN, onClick: () => setLineEdge(l.id, "end", now) },
      "sep",
      { label: "Play from here", onClick: () => (seek(l.start), play()) },
      { label: "Loop this line", onClick: () => (setLoop({ start: l.start, end: l.end }), seek(l.start), play()) },
      ...(targets.length && edit
        ? ["sep" as const, ...targets.map((t) => ({ label: `Move to ${t.name}`, onClick: () => store().update((q) => moveLineToLayer(q, l.id, t.id)) }))]
        : []),
      "sep",
      { label: "Delete", hint: "Del", danger: true, disabled: !edit, onClick: () => deleteLine(l.id) },
    ];
  };

  const commitEdit = (id: string, text: string) => {
    setEditingId(null);
    const t = text.trim();
    const cur = useProject.getState().project.lines.find((l) => l.id === id);
    if (t && cur && t !== cur.text) useProject.getState().updateLine(id, { text: t, words: undefined });
  };

  const newLayer = () => {
    const st = useProject.getState();
    if (st.project.layers.length >= MAX_LAYERS) return;
    const r = addLayer(st.project);
    st.update(() => r.project);
    st.setActiveLayer(r.layer.id);
  };

  /* ---------- tap-to-sync (acts on the active layer) ---------- */
  const startSync = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    endSet.current.clear();
    useProject.getState().setSync(true, 0);
    seek(0);
    play();
  };
  const stopSync = useCallback(() => {
    useProject.getState().setSync(false);
    pause();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const st = useProject.getState();

      /* sync mode: Space = start of next line, Enter = end of current line, Esc = leave */
      if (st.syncMode) {
        if (e.code === "Escape") {
          e.preventDefault();
          stopSync();
          return;
        }
        const lid = st.project.layers.some((l) => l.id === st.activeLayerId) ? st.activeLayerId : st.project.layers[0].id;
        const layerLines = linesOfLayer(st.project, lid);
        if (e.code === "Space") {
          e.preventDefault();
          const i = st.syncIndex;
          if (i >= layerLines.length) return;
          const t = snap(getTime());
          st.beginGesture();
          // close the previous line if the user did not press Enter for it
          const prev = layerLines[i - 1];
          if (prev && !endSet.current.has(prev.id)) {
            st.updateLine(prev.id, { end: Math.max(prev.start + MIN_LEN, snap(t - SNAP)) });
          }
          const cur = layerLines[i];
          // keep an existing end if it is still after the tap, otherwise default to 3s
          const end = cur.end > t + MIN_LEN ? cur.end : snap(t + 3);
          st.updateLine(cur.id, { start: t, end });
          st.endGesture();
          st.select(cur.id);
          st.setSyncIndex(i + 1);
        } else if (e.code === "Enter") {
          e.preventDefault();
          const cur = layerLines[st.syncIndex - 1];
          if (!cur) return;
          const t = snap(getTime());
          st.updateLine(cur.id, { end: Math.max(cur.start + MIN_LEN, t) });
          endSet.current.add(cur.id);
        }
        return;
      }

      /* copy / paste / duplicate */
      const mod = e.ctrlKey || e.metaKey;
      const selected = st.selectedLineId ? st.project.lines.find((x) => x.id === st.selectedLineId) : undefined;
      if (mod && e.code === "KeyC" && selected) {
        copyLine(selected.id);
        return;
      }
      if (mod && e.code === "KeyV" && clipboard && !keyframePasteApplies()) {
        e.preventDefault();
        const lid = st.project.layers.some((l) => l.id === st.activeLayerId) ? st.activeLayerId : st.project.layers[0].id;
        if (!st.project.layers.find((l) => l.id === lid)?.locked) pasteLine(lid, getTime());
        return;
      }
      if (mod && e.code === "KeyD" && selected) {
        e.preventDefault();
        if (!st.project.layers.find((l) => l.id === layerIdOf(st.project, selected))?.locked) duplicateLine(selected.id);
        return;
      }

      /* arrow keys nudge the selected line; Delete removes it (or its selected keyframe); K adds a keyframe */
      const sel = selected;
      if (!sel) return;
      const layer = st.project.layers.find((l) => l.id === layerIdOf(st.project, sel));
      if (layer?.locked) return;
      if (e.code === "KeyK" && !mod && !e.altKey) {
        e.preventDefault();
        addKeyAtPlayhead(sel.id, getTime());
        return;
      }
      const selKey = useKeyUi.getState().selected;
      if ((e.code === "Delete" || e.code === "Backspace") && selKey?.lineId === sel.id && sel.keyframes?.some((k) => k.id === selKey.id)) {
        e.preventDefault();
        removeKey(sel.id, selKey.id);
        return;
      }
      if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        if (e.target instanceof HTMLElement && e.target.closest("[data-text-stage]")) return; // the preview moves the text instead
        e.preventDefault();
        const d = e.code === "ArrowLeft" ? -SNAP : SNAP;
        const start = Math.max(0, snap(sel.start + d));
        const end = snap(sel.end + (start - sel.start));
        st.updateLine(sel.id, { start, end }, `nudge:${sel.id}`);
      } else if (e.code === "Delete") {
        e.preventDefault();
        st.update((p) => ({ ...p, lines: p.lines.filter((x) => x.id !== sel.id) }));
        st.select(null);
      }
    };
    // capture phase so sync-mode Space wins over the preview's play/pause handler
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [stopSync]);

  // beat ticks in view, thinned so they never crowd (downbeats are kept longest)
  const beatTicks = useMemo(() => {
    const shown = TE.thinBeats(TE.inWindow(beats, view.t0, view.t1), pps);
    let beat = "";
    let down = "";
    for (const b of shown) {
      const x = (b.time * pps).toFixed(1);
      if (b.downbeat) down += `M${x},${RULER_H}V${RULER_H - 9}`;
      else beat += `M${x},${RULER_H}V${RULER_H - 4}`;
    }
    return { beat, down };
  }, [beats, view.t0, view.t1, pps]);
  const energyArea = useMemo(
    () => (energy ? energyPath(energy, { start: 0, duration: total, sourceIn: 0, speed: 1 }, view.t0, view.t1, pps, WAVE_H) : ""),
    [energy, view.t0, view.t1, pps, total]
  );

  const ticks = useMemo(() => {
    const step = pps >= 120 ? 1 : pps >= 50 ? 5 : pps >= 25 ? 10 : pps >= 10 ? 30 : 60;
    return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  }, [pps, total]);

  const activeLines = useMemo(() => lines.filter((l) => layerIdOf({ layers }, l) === activeLayer.id), [lines, layers, activeLayer.id]);
  const current = syncMode ? activeLines[syncIndex] : undefined;
  const btn = "px-2 py-0.5 text-xs rounded border border-edge hover:bg-edge";
  const lanesH = layers.length * LANE_H;
  const curvesOpen = useKeyframeUi((s) => s.curves);

  return (
    <div className="h-full flex flex-col">
      <div className="min-h-8 shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 border-b border-edge text-xs">
        {syncMode ? (
          <button className={`${btn} border-accent text-accent`} onClick={stopSync}>Stop sync (Esc)</button>
        ) : (
          <button className={btn} onClick={startSync} disabled={!activeLines.length} title={`Tap the start of each line of "${activeLayer.name}"`}>
            Tap to sync
          </button>
        )}
        <span className="text-gray-500 truncate flex-1 min-w-[160px]">
          {syncMode
            ? current
              ? `${activeLayer.name}: Space = start of line ${syncIndex + 1} "${current.text}"  |  Enter = end of the line before`
              : "All lines tapped. Enter closes the last line, Esc to finish."
            : "Drag blocks to move (up/down changes layer), edges to resize. Double-click empty space to add text, a block to edit it."}
        </span>
        <div role="toolbar" aria-label="Timeline tools" className="flex items-center gap-0.5 rounded-md border border-edge p-0.5">
          {(
            [
              ["select", "Select", "A"],
              ["trim", "Trim", "T"],
              ["blade", "Blade", "B"],
              ["hand", "Hand", "H"],
              ["zoom", "Zoom", "Z"],
            ] as const
          ).map(([id, name, key]) => (
            <button
              key={id}
              aria-pressed={tool === id}
              title={`${name} tool (${key})`}
              onClick={() => useTimelineUi.setState({ tool: id })}
              className={`rounded px-1.5 py-0.5 text-[11px] ${tool === id ? "bg-accent/25 text-accent" : "text-gray-400 hover:bg-white/10 hover:text-gray-100"}`}
            >
              {name}
            </button>
          ))}
          <button
            aria-pressed={snapping}
            title="Snapping (N). Hold Alt while dragging to flip it."
            onClick={() => useTimelineUi.setState({ snapping: !snapping })}
            className={`rounded px-1.5 py-0.5 text-[11px] ${snapping ? "bg-accent/25 text-accent" : "text-gray-400 hover:bg-white/10"}`}
          >
            Snap
          </button>
          <button
            aria-pressed={beatSnap}
            title={`Snap to beats (Shift+N): line edges, keyframes, clips and the playhead land on the nearest beat while snapping is on.${beats.length ? "" : " No beats detected yet."}`}
            onClick={() => useTimelineUi.setState({ beatSnap: !beatSnap })}
            className={`rounded px-1.5 py-0.5 text-[11px] ${beatSnap && snapping ? "bg-accent/25 text-accent" : beatSnap ? "text-accent/70 hover:bg-white/10" : "text-gray-400 hover:bg-white/10"}`}
          >
            Beats
          </button>
        </div>
        <div className="flex items-center gap-0.5" role="group" aria-label="Edit from the media library">
          {SOURCE_EDITS.map((s) => (
            <button
              key={s.id}
              className={`${btn} !px-1.5 text-[11px] disabled:opacity-40`}
              title={`${s.label} (${s.key})${sourceName ? `: ${sourceName}` : ""}. ${sourceEditProblem(s.id) || ""}`}
              onClick={() => {
                const msg = sourceEdit(s.id);
                if (msg) useMedia.setState({ notice: msg });
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        {tlIn !== undefined && tlOut !== undefined && (
          <button className={`${btn} text-[11px]`} onClick={() => loopRange(!loop)} title="Play the in/out range in a loop">
            {loop ? "Stop loop" : "Loop in/out"}
          </button>
        )}
        <label className="flex items-center gap-1.5 text-gray-500" title="Keep the playhead in view while playing">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-accent" />
          Follow
        </label>
        <button className={btn} onClick={fitToView} title="Zoom out to show the whole song">Fit</button>
        <label className="flex items-center gap-2 text-gray-500" title="Ctrl + mouse wheel also zooms">
          Zoom
          <input type="range" min={4} max={300} value={pps} onChange={(e) => setPps(Number(e.target.value))} className="w-24 accent-accent" />
        </label>
      </div>

      <div
        ref={scrollRef}
        className="timeline-scroll flex-1 min-h-0 overflow-scroll relative"
        onScroll={() => {
          // a scroll we did not cause (scrollbar drag, wheel, touch) pauses auto-follow
          if (programmatic.current) programmatic.current = false;
          else userScrollAt.current = Date.now();
        }}
      >
        <div className="relative" style={{ width: GUTTER + width, minHeight: "100%" }}>
          {/* top row: stays visible when the lanes scroll up/down */}
          <div className="sticky top-0 z-30 flex bg-panel">
            <div
              data-gutter
              className="sticky left-0 z-20 flex shrink-0 items-center justify-between border-b border-r border-edge bg-panel px-2"
              style={{ width: GUTTER, height: RULER_H + WAVE_H }}
            >
              <span className="text-[11px] uppercase tracking-wide text-gray-500">Layers</span>
              <button
                className={`${btn} disabled:opacity-40`}
                onClick={newLayer}
                disabled={layers.length >= MAX_LAYERS}
                title={layers.length >= MAX_LAYERS ? `Up to ${MAX_LAYERS} layers` : "Add a text layer"}
              >
                Add layer
              </button>
            </div>
            <div className="relative" style={{ width }}>
              <div onPointerDown={onScrubDown} onPointerMove={onScrubMove} className="cursor-col-resize select-none">
                <div className="relative border-b border-edge" style={{ height: RULER_H }}>
                  {ticks.map((t) => (
                    <span key={t} className="absolute top-0 text-[10px] text-gray-500 border-l border-edge pl-1 h-full" style={{ left: t * pps }}>
                      {pps >= 120 ? timecode(t, fps) : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`}
                    </span>
                  ))}
                  {cacheRanges.map(([a, b], i) => (
                    <span key={i} className="pointer-events-none absolute bottom-0 h-[3px] bg-green-500/80" style={{ left: a * pps, width: Math.max(1, (b - a) * pps) }} title="Rendered and cached" />
                  ))}
                  {tlIn !== undefined && (
                    <span className="absolute top-0 h-full border-l-2 border-accent" style={{ left: tlIn * pps }} title={`In ${timecode(tlIn, fps)} (I)`} />
                  )}
                  {tlOut !== undefined && (
                    <span className="absolute top-0 h-full border-r-2 border-accent" style={{ left: tlOut * pps - 2 }} title={`Out ${timecode(tlOut, fps)} (O)`} />
                  )}
                  {tlIn !== undefined && tlOut !== undefined && <span className="absolute top-0 h-full bg-accent/15" style={{ left: tlIn * pps, width: (tlOut - tlIn) * pps }} />}
                  {(beatTicks.beat || beatTicks.down) && (
                    <svg className="pointer-events-none absolute left-0 top-0" width={width} height={RULER_H} aria-hidden>
                      <path d={beatTicks.beat} style={{ stroke: "rgb(var(--white) / 0.28)", strokeWidth: 1 }} />
                      <path d={beatTicks.down} style={{ stroke: "rgb(var(--white) / 0.6)", strokeWidth: 1.5 }} />
                    </svg>
                  )}
                  {tlMarkers.filter((m) => !m.clipId && !isBeat(m)).map((m) => (
                    <button
                      key={m.id}
                      className="absolute top-0 z-10 h-0 w-0 -translate-x-[5px] border-x-[5px] border-t-[9px] border-x-transparent"
                      style={{ left: m.time * pps, borderTopColor: m.color }}
                      title={`${m.name || "Marker"} at ${timecode(m.time, fps)}${m.note ? `: ${m.note}` : ""}. Click to jump, right-click to delete.`}
                      aria-label={`Marker ${m.name}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => seek(m.time)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        useProject.getState().editDoc((d) => TE.onActive(d, (x) => TE.removeMarker(x, m.id)));
                      }}
                    />
                  ))}
                </div>
                <div className="relative" style={{ height: WAVE_H, width }}>
                  {audioUrl && energyArea && (
                    <svg className="pointer-events-none absolute left-0 top-0" width={width} height={WAVE_H} aria-hidden>
                      <path d={energyArea} style={{ fill: "rgb(var(--accent) / 0.12)", stroke: "rgb(var(--accent) / 0.3)", strokeWidth: 1 }} />
                    </svg>
                  )}
                  <div ref={waveRef} style={{ height: WAVE_H, width }} className={`relative ${audioUrl ? "" : "flex items-center px-3 text-xs text-gray-600"}`}>
                    {!audioUrl && "Upload audio to see the waveform"}
                  </div>
                </div>
              </div>
              {loop && <div className="absolute top-0 bottom-0 bg-accent/10 pointer-events-none" style={{ left: loop.start * pps, width: (loop.end - loop.start) * pps }} />}
              <div ref={headTopRef} className="absolute top-0 bottom-0 left-0 w-px bg-yellow-400 pointer-events-none z-10" />
            </div>
          </div>

          {/* layer lanes */}
          <div ref={lanesRef} className="relative" style={{ height: lanesH }}>
            {[...layers].map((layer, li) => {
              const layerLines = lines.filter((l) => layerIdOf({ layers }, l) === layer.id);
              return (
                <div key={layer.id} className="flex border-b border-edge" style={{ height: LANE_H }} data-testid="lane">
                  <div data-gutter className="sticky left-0 z-20 shrink-0 border-r border-edge bg-panel" style={{ width: GUTTER }}>
                    <LayerHeader layer={layer} index={li} count={layers.length} active={layer.id === activeLayer.id} />
                  </div>
                  <div
                    className={`relative ${layer.visible ? "" : "opacity-40"} ${layer.locked ? "bg-black/20" : ""}`}
                    style={{ width }}
                    onDoubleClick={(e) => e.target === e.currentTarget && addBlockAt(layer, e)}
                    onContextMenu={(e) => {
                      if (e.target !== e.currentTarget) return; // blocks have their own menu
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect(); // left edge = time 0
                      useProject.getState().setActiveLayer(layer.id);
                      setCtx({ kind: "lane", layerId: layer.id, time: Math.max(0, snap((e.clientX - rect.left) / pps)), x: e.clientX, y: e.clientY });
                    }}
                    onPointerDown={(e) => e.target === e.currentTarget && useProject.getState().setActiveLayer(layer.id)}
                  >
                    {layerLines.map((l, i) => {
                      const gi = globalIndex.get(l.id) ?? 0;
                      return [
                        <div
                          key={l.id}
                          onPointerDown={(e) => onBlockDown(e, l.id, "move")}
                          onPointerMove={onBlockMove}
                          onPointerUp={onBlockUp}
                          onPointerCancel={onBlockUp}
                          onDoubleClick={(e) => (e.stopPropagation(), !layer.locked && setEditingId(l.id))}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const st = useProject.getState();
                            st.select(l.id);
                            st.setActiveLayer(layer.id);
                            setCtx({ kind: "block", lineId: l.id, x: e.clientX, y: e.clientY });
                          }}
                          className={`absolute top-1 h-9 rounded border text-[11px] leading-9 px-2 truncate select-none touch-none ${layer.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"} ${
                            selectedIds.includes(l.id) ? "bg-accent/40 border-accent text-white" : "bg-edge/80 border-gray-600 text-gray-300"
                          } ${syncMode && layer.id === activeLayer.id && i === syncIndex ? "ring-2 ring-yellow-400" : ""}`}
                          style={{ left: l.start * pps, width: Math.max(6, (l.end - l.start) * pps) }}
                          title={`${gi + 1} | ${layer.name} | ${l.start.toFixed(2)}-${l.end.toFixed(2)} | ${l.text}`}
                        >
                          {!layer.locked && (
                            <span className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize" onPointerDown={(e) => onBlockDown(e, l.id, "l")} onPointerMove={onBlockMove} onPointerUp={onBlockUp} />
                          )}
                          {editingId === l.id ? (
                            <input
                              autoFocus
                              defaultValue={l.text}
                              className="absolute inset-y-1 left-1 right-1 rounded bg-bg px-1.5 text-[11px] text-white outline-none ring-1 ring-accent"
                              onPointerDown={(e) => e.stopPropagation()}
                              onBlur={(e) => commitEdit(l.id, e.currentTarget.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") e.currentTarget.blur();
                                if (e.key === "Escape") setEditingId(null);
                              }}
                            />
                          ) : (
                            <>{gi + 1}. {l.text}</>
                          )}
                          {!layer.locked && (
                            <span className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize" onPointerDown={(e) => onBlockDown(e, l.id, "r")} onPointerMove={onBlockMove} onPointerUp={onBlockUp} />
                          )}
                        </div>,
                        ...(l.keyframes ?? []).map((kf) => {
                          const on = selKey?.lineId === l.id && selKey.id === kf.id;
                          const lineSel = selectedIds.includes(l.id);
                          return (
                            <span
                              key={`${l.id}:${kf.id}`}
                              role="button"
                              aria-label={`Keyframe at ${kf.time.toFixed(2)} seconds into line ${gi + 1}`}
                              title={`Keyframe ${kf.time.toFixed(2)}s · ${Object.keys(kf.props).join(", ")} · ${kf.easing}. Drag to retime, right-click for options.`}
                              className={`absolute z-[5] h-2.5 w-2.5 rotate-45 rounded-[2px] border ${
                                on ? "border-white bg-yellow-400" : lineSel ? "border-accent bg-white" : "border-gray-500 bg-gray-300"
                              } ${layer.locked ? "" : "cursor-ew-resize"}`}
                              style={{ left: (l.start + kf.time) * pps - 5, top: 35 }}
                              onPointerDown={(e) => onKeyDown(e, l, kf.id, kf.time, layer.locked)}
                              onPointerMove={onKeyMove}
                              onPointerUp={onKeyUp}
                              onPointerCancel={onKeyUp}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                useProject.getState().select(l.id);
                                useKeyUi.setState({ selected: { lineId: l.id, id: kf.id } });
                                setCtx({ kind: "key", lineId: l.id, keyId: kf.id, x: e.clientX, y: e.clientY });
                              }}
                            />
                          );
                        }),
                      ];
                    })}
                    {gapMarks(layerLines).map((g) => (
                      <span
                        key={`gap:${g.from}`}
                        className="pointer-events-none absolute top-[13px] z-[4] -translate-x-1/2 rounded-full border border-accent/60 bg-panel px-1 text-[10px] leading-4 text-accent"
                        style={{ left: g.at * pps }}
                        title={`${g.label}, ${g.ms} ms`}
                        aria-label={`Transition: ${g.label}`}
                      >
                        ⇄
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* playhead + loop across the lanes (offset past the layer column) */}
            <div className="pointer-events-none absolute top-0 bottom-0 z-10" style={{ left: GUTTER, width }}>
              {loop && <div className="absolute top-0 bottom-0 bg-accent/10" style={{ left: loop.start * pps, width: (loop.end - loop.start) * pps }} />}
              <div ref={headLanesRef} className="absolute top-0 bottom-0 left-0 w-px bg-yellow-400" />
            </div>
          </div>

          {/* video and audio tracks of the timeline (phase 13) */}
          <TrackLanes pps={pps} width={width} gutter={GUTTER} scrollRef={scrollRef} setPps={setPps} />
        </div>
      </div>
      {curvesOpen && (
        <div className="relative h-[42%] min-h-[140px] shrink-0 border-t-2 border-edge bg-panel" data-testid="curve-editor">
          <button className="absolute right-1 top-1 z-10 rounded px-1 text-[11px] text-gray-500 hover:bg-white/10" title="Close the curve editor" onClick={() => useKeyframeUi.setState({ curves: false })}>
            ✕
          </button>
          <CurveEditor />
        </div>
      )}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={menuItems(ctx)} onClose={closeCtx} />}
    </div>
  );
}
