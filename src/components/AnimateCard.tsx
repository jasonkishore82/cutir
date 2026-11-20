import { Card, Slider } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { seek } from "../lib/transport";
import { lanesOf, laneValue, removeLaneKey, setLaneKey, clearLane, type LaneInfo } from "../lib/keyframes/lanes";
import { EASE_NAMES, type Key, type KeyMode } from "../lib/keyframes/engine";
import { shapeLaneKeys } from "../lib/keyframes/lanes";
import { focusClip, useKeyframeUi, toggleLane } from "../lib/keyframes/ui";
import { editTimeline, useTimelineUi } from "../timeline/ui";
import { usePlayhead } from "./usePlayhead";

/**
 * Every animatable value of the selected clip (placement, volume, each effect param), each with a keyframe button.
 * With keys, the slider edits the key at the playhead (adding one when there is none). Colour and point params are
 * keyframed from the Effects tab; here they only show their key count.
 */
export default function AnimateCard() {
  const selected = useTimelineUi((s) => s.selected);
  const doc = useProject((s) => s.doc);
  const { autoKey, shownLanes, curves, showPath } = useKeyframeUi();
  const now = usePlayhead();
  const tl = activeTimeline(doc);
  const clip = focusClip(tl, selected);
  if (!clip) return null;
  const lanes = lanesOf(clip, doc);
  if (!lanes.length) return null;
  const rel = now - clip.start;
  const inside = rel >= 0 && rel <= clip.duration;
  const groups = [...new Set(lanes.map((l) => l.group))];
  const anyKeys = lanes.some((l) => l.keys.length);
  const btn = "rounded px-1 text-[11px] hover:bg-white/10";

  const keyAt = (l: LaneInfo) => l.keys.find((k) => Math.abs(k.t - rel) <= 0.02);
  const write = (l: LaneInfo, v: number) => {
    const stored = v / l.factor;
    if (l.keys.length || autoKey) {
      if (!inside) return;
      editTimeline((t) => setLaneKey(t, clip.id, l.id, rel, stored), `lane:${clip.id}:${l.key}`);
      return;
    }
    // no keys and no auto-key: the plain value
    const id = l.id;
    editTimeline(
      (t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clip.id) return c;
          if (id.kind === "clip") return id.name === "volume" ? { ...c, volume: stored } : { ...c, transform: { ...(c.transform ?? {}), [id.name]: stored } };
          return { ...c, effects: c.effects.map((f) => (f.id === id.fxId ? { ...f, params: { ...f.params, [id.param]: stored } } : f)) };
        }),
      }),
      `lane:${clip.id}:${l.key}`
    );
  };

  return (
    <Card title="Animate" hint="Any value can change over time. ◆ adds a keyframe at the playhead; with keyframes the slider edits the one under the playhead.">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-gray-300">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={autoKey} onChange={(e) => useKeyframeUi.setState({ autoKey: e.target.checked })} />
          Auto-key
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={showPath} onChange={(e) => useKeyframeUi.setState({ showPath: e.target.checked })} />
          Motion path
        </label>
        <button className={`ml-auto rounded-md border px-2 py-0.5 text-[11px] ${curves ? "border-accent text-accent" : "border-edge text-gray-400 hover:bg-raised"}`} onClick={() => useKeyframeUi.setState({ curves: !curves })} aria-pressed={curves}>
          Curve editor
        </button>
      </div>
      {!inside && anyKeys && <p className="text-[11px] text-yellow-400">The playhead is outside this clip: move it inside to add or edit keyframes.</p>}
      {groups.map((g) => (
        <div key={g} className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-gray-600">{g}</p>
          {lanes
            .filter((l) => l.group === g)
            .map((l) => {
              const v = laneValue(l, Math.max(0, Math.min(clip.duration, rel)));
              const k = keyAt(l);
              const shownIn = !shownLanes.length ? l.keys.length > 0 : shownLanes.includes(l.key);
              const numeric = l.valueKind === "number" || l.valueKind === "angle";
              return (
                <div key={l.key} className="flex items-end gap-1">
                  <div className="min-w-0 flex-1">
                    {numeric ? (
                      <Slider label={l.label} value={Math.round((typeof v === "number" ? v : 0) * l.factor * 100) / 100} min={l.min} max={l.max} step={l.step} unit={l.unit} onChange={(n) => write(l, n)} />
                    ) : (
                      <p className="text-[12px] text-gray-300">
                        {l.label} <span className="text-gray-500">({l.valueKind}: keyframe it from the Effects tab)</span>
                      </p>
                    )}
                  </div>
                  <button
                    className={`${btn} ${k ? "text-yellow-300" : l.keys.length ? "text-yellow-300/50" : "text-gray-500"}`}
                    disabled={!inside}
                    title={k ? "Remove the keyframe at the playhead" : l.keys.length ? `${l.keys.length} keyframes. Add one at the playhead` : "Add a keyframe at the playhead"}
                    onClick={() => editTimeline((t) => (k ? removeLaneKey(t, clip.id, l.id, rel) : setLaneKey(t, clip.id, l.id, rel, v)))}
                  >
                    {k ? "◆" : "◇"}
                  </button>
                  {l.keys.length > 0 && (
                    <>
                      <button className={`${btn} text-gray-500`} title="Previous keyframe" onClick={() => {
                        const prev = [...l.keys].reverse().find((x) => x.t < rel - 0.02);
                        if (prev) seek(clip.start + prev.t);
                      }}>‹</button>
                      <button className={`${btn} text-gray-500`} title="Next keyframe" onClick={() => {
                        const nx = l.keys.find((x) => x.t > rel + 0.02);
                        if (nx) seek(clip.start + nx.t);
                      }}>›</button>
                      <button className={`${btn} ${shownIn ? "text-accent" : "text-gray-500"}`} title="Show this lane on the timeline and in the curve editor" aria-pressed={shownIn} onClick={() => toggleLane(l.key)}>
                        ▤
                      </button>
                      <button className={`${btn} text-gray-500 hover:!text-red-400`} title="Remove all keyframes of this value" onClick={() => editTimeline((t) => clearLane(t, clip.id, l.id))}>
                        ✕
                      </button>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      ))}
      {anyKeys && <EaseRow clipId={clip.id} lanes={lanes} rel={rel} />}
    </Card>
  );
}

/** Set the shape of the keyframe under the playhead (or of every key when none is there) on every lane with keys. */
function EaseRow({ clipId, lanes, rel }: { clipId: string; lanes: LaneInfo[]; rel: number }) {
  const apply = (mode: KeyMode, easing?: Key["easing"]) =>
    editTimeline((t) => lanes.filter((l) => l.keys.length).reduce((acc, l) => shapeLaneKeys(acc, clipId, l.id, l.keys.some((k) => Math.abs(k.t - rel) <= 0.02) ? [rel] : [], mode, easing), t));
  const btn = "rounded border border-edge px-1.5 py-0.5 text-[10px] text-gray-300 hover:bg-raised";
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wide text-gray-600">Ease (keyframe at the playhead, or all)</p>
      <div className="flex flex-wrap gap-1">
        <button className={btn} onClick={() => apply("hold")}>Hold</button>
        <button className={btn} onClick={() => apply("bezier")}>Bezier</button>
        {EASE_NAMES.map((e) => (
          <button key={e} className={btn} onClick={() => apply(e === "linear" ? "linear" : "ease", e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
