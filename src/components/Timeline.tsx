import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { useProject } from "../store/project";
import { getTime, play, seek, usePlayback, pause } from "../lib/transport";

const SNAP = 0.05;
const MIN_LEN = 0.1;
const WAVE_H = 56;
const RULER_H = 18;

const snap = (t: number) => Math.round(Math.round(t / SNAP) * SNAP * 100) / 100;
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
};

type Drag = { id: string; mode: "move" | "l" | "r"; x0: number; start: number; end: number };

export default function Timeline() {
  const lines = useProject((s) => s.project.lines);
  const audioUrl = useProject((s) => s.project.audio?.url);
  const selected = useProject((s) => s.selectedLineId);
  const syncMode = useProject((s) => s.syncMode);
  const syncIndex = useProject((s) => s.syncIndex);
  const select = useProject((s) => s.select);
  const duration = usePlayback((s) => s.duration);
  const loop = usePlayback((s) => s.loop);

  const [pps, setPps] = useState(80); // pixels per second
  const scrollRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const drag = useRef<Drag | null>(null);
  const endSet = useRef<Set<string>>(new Set()); // lines whose end was set with Enter in this sync pass

  const total = useMemo(
    () => Math.max(duration, lines.reduce((m, l) => Math.max(m, l.end), 0) + 2, 10),
    [duration, lines]
  );
  const width = Math.ceil(total * pps);

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
      const head = headRef.current;
      const sc = scrollRef.current;
      if (head) head.style.transform = `translateX(${t * pps}px)`;
      if (sc && usePlayback.getState().playing) {
        const x = t * pps;
        if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 40);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pps]);

  /* ---------- seeking by dragging on ruler / waveform ---------- */
  const seekFromEvent = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(Math.max(0, (e.clientX - rect.left) / pps));
  };
  const onScrubDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  };
  const onScrubMove = (e: React.PointerEvent) => {
    if (e.buttons & 1) seekFromEvent(e);
  };

  /* ---------- block dragging / resizing ---------- */
  const onBlockDown = (e: React.PointerEvent, id: string, mode: Drag["mode"]) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const line = useProject.getState().project.lines.find((l) => l.id === id);
    if (!line) return;
    select(id);
    if (useProject.getState().syncMode) {
      const idx = useProject.getState().project.lines.findIndex((l) => l.id === id);
      useProject.getState().setSyncIndex(idx);
    }
    drag.current = { id, mode, x0: e.clientX, start: line.start, end: line.end };
    useProject.getState().beginGesture();
  };
  const onBlockMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x0) / pps;
    let start = d.start;
    let end = d.end;
    if (d.mode === "move") {
      const len = d.end - d.start;
      start = Math.max(0, snap(d.start + dt));
      end = snap(start + len);
    } else if (d.mode === "l") {
      start = Math.min(Math.max(0, snap(d.start + dt)), d.end - MIN_LEN);
    } else {
      end = Math.max(snap(d.end + dt), d.start + MIN_LEN);
    }
    useProject.getState().updateLine(d.id, { start, end });
  };
  const onBlockUp = () => {
    if (!drag.current) return;
    drag.current = null;
    useProject.getState().endGesture();
  };

  /* ---------- tap-to-sync ---------- */
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
        const lines = st.project.lines;
        if (e.code === "Space") {
          e.preventDefault();
          const i = st.syncIndex;
          if (i >= lines.length) return;
          const t = snap(getTime());
          st.beginGesture();
          // close the previous line if the user did not press Enter for it
          const prev = lines[i - 1];
          if (prev && !endSet.current.has(prev.id)) {
            st.updateLine(prev.id, { end: Math.max(prev.start + MIN_LEN, snap(t - SNAP)) });
          }
          const cur = lines[i];
          // keep an existing end if it is still after the tap, otherwise default to 3s
          const end = cur.end > t + MIN_LEN ? cur.end : snap(t + 3);
          st.updateLine(cur.id, { start: t, end });
          st.endGesture();
          st.select(cur.id);
          st.setSyncIndex(i + 1);
        } else if (e.code === "Enter") {
          e.preventDefault();
          const cur = lines[st.syncIndex - 1];
          if (!cur) return;
          const t = snap(getTime());
          st.updateLine(cur.id, { end: Math.max(cur.start + MIN_LEN, t) });
          endSet.current.add(cur.id);
        }
        return;
      }

      /* arrow keys nudge the selected line */
      if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && st.selectedLineId) {
        const l = st.project.lines.find((x) => x.id === st.selectedLineId);
        if (!l) return;
        e.preventDefault();
        const d = e.code === "ArrowLeft" ? -SNAP : SNAP;
        const start = Math.max(0, snap(l.start + d));
        const end = snap(l.end + (start - l.start));
        st.updateLine(l.id, { start, end }, `nudge:${l.id}`);
      }
    };
    // capture phase so sync-mode Space wins over the preview's play/pause handler
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [stopSync]);

  const ticks = useMemo(() => {
    const step = pps >= 120 ? 1 : pps >= 50 ? 5 : pps >= 25 ? 10 : 30;
    return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  }, [pps, total]);

  const current = syncMode ? lines[syncIndex] : undefined;
  const btn = "px-2 py-0.5 text-xs rounded border border-edge hover:bg-edge";

  return (
    <div className="h-full flex flex-col">
      <div className="h-8 shrink-0 flex items-center gap-3 px-3 border-b border-edge text-xs">
        {syncMode ? (
          <button className={`${btn} border-accent text-accent`} onClick={stopSync}>Stop sync (Esc)</button>
        ) : (
          <button className={btn} onClick={startSync} disabled={!lines.length}>Tap to sync</button>
        )}
        <span className="text-gray-500 truncate flex-1">
          {syncMode
            ? current
              ? `Space = start of line ${syncIndex + 1}: "${current.text}"  |  Enter = end of line ${syncIndex}`
              : "All lines tapped. Enter closes the last line, Esc to finish."
            : "Drag blocks to move, edges to resize (snaps to 0.05s). Arrow keys nudge the selected line."}
        </span>
        <label className="flex items-center gap-2 text-gray-500">
          Zoom
          <input type="range" min={20} max={300} value={pps} onChange={(e) => setPps(Number(e.target.value))} className="w-24 accent-[#e0709a]" />
        </label>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden relative">
        <div className="relative" style={{ width, height: "100%" }}>
          {/* ruler + waveform: scrub area */}
          <div onPointerDown={onScrubDown} onPointerMove={onScrubMove} className="cursor-col-resize select-none">
            <div className="relative border-b border-edge" style={{ height: RULER_H }}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 text-[10px] text-gray-500 border-l border-edge pl-1 h-full" style={{ left: t * pps }}>
                  {Math.floor(t / 60)}:{String(t % 60).padStart(2, "0")}
                </span>
              ))}
            </div>
            <div ref={waveRef} style={{ height: WAVE_H, width }} className={audioUrl ? "" : "flex items-center px-3 text-xs text-gray-600"}>
              {!audioUrl && "Upload audio to see the waveform"}
            </div>
          </div>

          {/* loop region */}
          {loop && (
            <div className="absolute top-0 bottom-0 bg-accent/10 pointer-events-none" style={{ left: loop.start * pps, width: (loop.end - loop.start) * pps }} />
          )}

          {/* lyric blocks */}
          <div className="relative" style={{ height: 44 }}>
            {lines.map((l, i) => (
              <div
                key={l.id}
                onPointerDown={(e) => onBlockDown(e, l.id, "move")}
                onPointerMove={onBlockMove}
                onPointerUp={onBlockUp}
                onPointerCancel={onBlockUp}
                className={`absolute top-1 h-9 rounded border text-[11px] leading-9 px-2 truncate cursor-grab active:cursor-grabbing select-none touch-none ${
                  selected === l.id ? "bg-accent/40 border-accent text-white" : "bg-edge/80 border-gray-600 text-gray-300"
                } ${syncMode && i === syncIndex ? "ring-2 ring-yellow-400" : ""}`}
                style={{ left: l.start * pps, width: Math.max(6, (l.end - l.start) * pps) }}
                title={`${i + 1} | ${l.start.toFixed(2)}-${l.end.toFixed(2)} | ${l.text}`}
              >
                <span
                  className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize"
                  onPointerDown={(e) => onBlockDown(e, l.id, "l")}
                  onPointerMove={onBlockMove}
                  onPointerUp={onBlockUp}
                />
                {i + 1}. {l.text}
                <span
                  className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize"
                  onPointerDown={(e) => onBlockDown(e, l.id, "r")}
                  onPointerMove={onBlockMove}
                  onPointerUp={onBlockUp}
                />
              </div>
            ))}
          </div>

          {/* playhead */}
          <div ref={headRef} className="absolute top-0 bottom-0 left-0 w-px bg-yellow-400 pointer-events-none z-10" />
        </div>
      </div>
    </div>
  );
}
