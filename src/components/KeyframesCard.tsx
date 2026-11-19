import { useEffect, useState } from "react";
import { Card } from "./ui";
import { getTime, seek } from "../lib/transport";
import { EASING_NAMES } from "../lib/animations";
import {
  KEY_PROPS,
  addKeyAtPlayhead,
  clearKeys,
  evalKeyframes,
  keyAt,
  removeKey,
  setKeyAt,
  toggleKeyProp,
  updateKey,
  useKeyUi,
} from "../lib/keyframes";
import { layerIdOf, useProject, type Easing, type KeyProp } from "../store/project";

/** How each property is shown: stored value * factor = shown value. */
const FIELDS: Record<KeyProp, { label: string; unit: string; factor: number; step: number }> = {
  x: { label: "Move across", unit: "%", factor: 100, step: 0.5 },
  y: { label: "Move down", unit: "%", factor: 100, step: 0.5 },
  scale: { label: "Size", unit: "%", factor: 100, step: 1 },
  rotation: { label: "Rotation", unit: "deg", factor: 1, step: 1 },
  opacity: { label: "Opacity", unit: "%", factor: 100, step: 1 },
};

/** The playhead time, refreshed every frame while it changes. */
function usePlayhead(): number {
  const [t, setT] = useState(getTime);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setT((prev) => {
        const now = getTime();
        return Math.abs(now - prev) > 1e-4 ? now : prev;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return t;
}

/**
 * Keyframes of the selected line: add one at the playhead, edit the one under the playhead property by property,
 * and jump between them. Dragging the text on the preview edits keyframes too (see TextOverlay).
 */
export default function KeyframesCard() {
  const project = useProject((s) => s.project);
  const ids = useProject((s) => s.selectedIds);
  const { autoKey, showPath } = useKeyUi();
  const now = usePlayhead();

  if (ids.length !== 1) {
    return (
      <Card title="Keyframes" hint="Custom motion for one line: position, size, rotation and opacity over time.">
        <p className="text-[12px] text-gray-500">Select one line to add keyframes.</p>
      </Card>
    );
  }
  const line = project.lines.find((l) => l.id === ids[0]);
  if (!line) return null;
  const locked = !!project.layers.find((x) => x.id === layerIdOf(project, line))?.locked;
  const t = now - line.start;
  const inside = t >= 0 && t <= line.end - line.start;
  const here = inside ? keyAt(line, t) : undefined;
  const values = evalKeyframes(line.keyframes, here ? here.time : Math.max(0, t));
  const kfs = line.keyframes ?? [];
  const btn = "rounded-lg border border-edge bg-black/20 px-3 py-1.5 text-[12px] text-gray-300 hover:bg-raised hover:text-white disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <Card title="Keyframes" hint="Set the text at two points in time and it moves smoothly between them.">
      <div className="flex flex-wrap gap-1.5">
        <button className={btn} disabled={locked || !inside} onClick={() => addKeyAtPlayhead(line.id, getTime())} title={inside ? "Add a keyframe at the playhead (K)" : "Move the playhead inside this line first"}>
          Add keyframe <span className="text-gray-500">K</span>
        </button>
        {kfs.length > 0 && (
          <button className={btn} disabled={locked} onClick={() => clearKeys(line.id)}>
            Remove all
          </button>
        )}
      </div>

      <label className="flex items-start gap-2 text-[12px] text-gray-300">
        <input type="checkbox" className="mt-0.5" checked={autoKey} onChange={(e) => useKeyUi.setState({ autoKey: e.target.checked })} />
        <span>
          Auto-key
          <span className="block text-[11px] text-gray-500">Moving, scaling or rotating the text on the preview adds a keyframe at the playhead.</span>
        </span>
      </label>
      <label className="flex items-center gap-2 text-[12px] text-gray-300">
        <input type="checkbox" checked={showPath} onChange={(e) => useKeyUi.setState({ showPath: e.target.checked })} />
        Show motion path on the preview
      </label>

      {kfs.length > 0 && (
        <div className="flex flex-wrap gap-1" role="list" aria-label="Keyframes of this line">
          {kfs.map((k, i) => (
            <button
              key={k.id}
              role="listitem"
              className={`rounded-md border px-2 py-0.5 text-[11px] tabular-nums ${k.id === here?.id ? "border-accent bg-accent/20 text-gray-100" : "border-edge text-gray-400 hover:bg-raised"}`}
              onClick={() => {
                seek(line.start + k.time);
                useKeyUi.setState({ selected: { lineId: line.id, id: k.id } });
              }}
              title={`Go to keyframe ${i + 1}`}
            >
              ◆ {k.time.toFixed(2)}s
            </button>
          ))}
        </div>
      )}

      {here ? (
        <div className="space-y-2 rounded-lg border border-edge p-2.5">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-gray-200">Keyframe at {here.time.toFixed(2)}s</span>
            <button className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-40" disabled={locked} onClick={() => removeKey(line.id, here.id)}>
              Delete
            </button>
          </div>
          {KEY_PROPS.map((p) => {
            const f = FIELDS[p];
            const keyed = here.props[p] !== undefined;
            return (
              <div key={p} className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  aria-label={`Keyframe ${f.label}`}
                  title={keyed ? "Keyed here: click to stop keying it" : "Not keyed here: click to key the current value"}
                  checked={keyed}
                  disabled={locked}
                  onChange={(e) => toggleKeyProp(line.id, here.id, p, e.target.checked)}
                />
                <span className={`w-24 ${keyed ? "text-gray-200" : "text-gray-500"}`}>{f.label}</span>
                <input
                  type="number"
                  className="field !w-20 !py-1 tabular-nums"
                  step={f.step}
                  disabled={locked || !keyed}
                  value={Math.round(values[p] * f.factor * 10) / 10}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setKeyAt(line.id, here.time, { [p]: v / f.factor }, `kf:${here.id}:${p}`);
                  }}
                />
                <span className="text-gray-500">{f.unit}</span>
              </div>
            );
          })}
          <label className="flex items-center gap-2 text-[12px]">
            <span className="w-[7.5rem] text-gray-400">Easing to next</span>
            <select className="field !py-1" value={here.easing} disabled={locked} onChange={(e) => updateKey(line.id, here.id, { easing: e.target.value as Easing })}>
              {EASING_NAMES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <p className="text-[11px] text-gray-500">Move and size are offsets from the line's normal placement. Unticked properties carry on between the other keyframes.</p>
        </div>
      ) : (
        kfs.length > 0 && <p className="text-[11px] text-gray-500">Put the playhead on a keyframe (click one above or on the timeline) to edit it.</p>
      )}
    </Card>
  );
}
