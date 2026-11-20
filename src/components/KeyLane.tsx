import { useRef, useState } from "react";
import { useProject } from "../store/project";
import type { Clip, ProjectDoc } from "../model/types";
import { getTime, seek } from "../lib/transport";
import { lanesOf, moveLaneKeys, removeLaneKey, type LaneInfo } from "../lib/keyframes/lanes";
import { isSelected, selectKey, useKeyframeUi, type KeySel } from "../lib/keyframes/ui";
import { editTimeline, tlNow } from "../timeline/ui";
import * as E from "../timeline/engine";

export const LANE_H = 14;

/** Lanes shown for a clip: the chosen ones, or every lane that has keys. */
export function shownLanes(clip: Clip, doc: ProjectDoc, chosen: string[]): LaneInfo[] {
  const all = lanesOf(clip, doc);
  return chosen.length ? all.filter((l) => chosen.includes(l.key)) : all.filter((l) => l.keys.length);
}

/**
 * Keyframe lanes drawn under a selected clip on the timeline (phase 18): one row per shown lane with a diamond per
 * key. Click selects (Shift adds), drag retimes the selected keys (Shift snaps to the playhead and other keys),
 * double-click jumps the playhead, right-click removes.
 */
export default function KeyLane({ clip, lanes, pps, snapping }: { clip: Clip; lanes: LaneInfo[]; pps: number; snapping: boolean }) {
  const selected = useKeyframeUi((s) => s.selected);
  const drag = useRef<{ x0: number; moved: boolean; keys: KeySel[]; tl0: ReturnType<typeof tlNow> } | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const down = (e: React.PointerEvent, lane: LaneInfo, t: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const sel: KeySel = { clipId: clip.id, laneKey: lane.key, t };
    const already = isSelected(selected, clip.id, lane.key, t);
    if (e.shiftKey || e.ctrlKey || e.metaKey) selectKey(sel, true);
    else if (!already) selectKey(sel);
    const keys = useKeyframeUi.getState().selected.filter((k) => k.clipId === clip.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x0: e.clientX, moved: false, keys, tl0: tlNow() };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x0) < 3) return;
      d.moved = true;
      useProject.getState().beginGesture();
    }
    let dt = (e.clientX - d.x0) / pps;
    if (snapping !== e.shiftKey) {
      // snap the first dragged key to the playhead, clip edges and other keys of the clip
      const first = Math.min(...d.keys.map((k) => k.t));
      const others = lanesOf(clip, useProject.getState().doc)
        .flatMap((l) => l.keys.map((k) => k.t))
        .filter((t) => !d.keys.some((k) => Math.abs(k.t - t) <= 0.02));
      const pts = [getTime() - clip.start, 0, clip.duration, ...others];
      const r = E.snapDelta([first], dt, pts, 8 / pps);
      dt = r.dt;
    }
    const byLane = new Map<string, number[]>();
    for (const k of d.keys) byLane.set(k.laneKey, [...(byLane.get(k.laneKey) ?? []), k.t]);
    useProject.getState().editDoc((doc) =>
      E.onActive(doc, () => {
        let t = d.tl0;
        for (const l of lanesOf(clip, doc)) {
          const ts = byLane.get(l.key);
          if (ts) t = moveLaneKeys(t, clip.id, l.id, ts, dt);
        }
        return t;
      })
    );
    useKeyframeUi.setState({ selected: d.keys.map((k) => ({ ...k, t: Math.max(0, k.t + dt) })) });
    drag.current = { ...d, keys: d.keys }; // original times stay as the drag reference
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) useProject.getState().endGesture();
  };

  return (
    <div className="absolute" style={{ top: "100%", left: clip.start * pps, width: Math.max(2, clip.duration * pps) }}>
      {lanes.map((lane, row) => (
        <div key={lane.key} className="relative border-t border-edge/60 bg-black/20" style={{ height: LANE_H }} title={lane.label}>
          <span className="pointer-events-none absolute left-1 top-0 text-[8px] leading-[14px] text-gray-500">{lane.label}</span>
          {lane.keys.map((k) => {
            const on = isSelected(selected, clip.id, lane.key, k.t);
            const id = `${lane.key}:${k.t}`;
            return (
              <span
                key={id}
                role="button"
                aria-label={`${lane.label} keyframe at ${k.t.toFixed(2)} s`}
                className={`absolute top-[3px] h-2 w-2 rotate-45 cursor-ew-resize border ${on ? "border-white bg-yellow-400" : hover === id ? "border-accent bg-white" : "border-gray-400 bg-gray-200"}`}
                style={{ left: k.t * pps - 4, zIndex: 6 }}
                onPointerDown={(e) => down(e, lane, k.t)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onPointerEnter={() => setHover(id)}
                onPointerLeave={() => setHover(null)}
                onDoubleClick={(e) => (e.stopPropagation(), seek(clip.start + k.t))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  editTimeline((t) => removeLaneKey(t, clip.id, lane.id, k.t));
                }}
                data-row={row}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
