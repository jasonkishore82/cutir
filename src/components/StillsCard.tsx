import { Card } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { scopeSource } from "../lib/scopes";
import { gradeOf, useStills } from "../lib/stills";
import { useTimelineUi, editTimeline } from "../timeline/ui";
import * as FX from "../timeline/effects";

const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40";

/** Stills gallery: save the frame in the viewer with its grade, compare a still with the live frame, and apply its grade to a clip. */
export default function StillsCard() {
  const { stills, compare, add, remove, rename, setCompare } = useStills();
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const tl = activeTimeline(doc);
  const targets = FX.effectTargets(tl, doc, selected);
  const clip = targets.length === 1 ? tl.clips.find((c) => c.id === targets[0]) : undefined;

  const save = () => {
    const src = scopeSource.canvas;
    if (!src || !src.width) return;
    const small = document.createElement("canvas");
    small.width = 480;
    small.height = Math.max(1, Math.round((480 * src.height) / src.width));
    small.getContext("2d")!.drawImage(src, 0, 0, small.width, small.height);
    add({ name: `Still ${stills.length + 1}`, url: small.toDataURL("image/jpeg", 0.85), grade: clip ? gradeOf(clip.effects) : [] });
  };

  return (
    <Card title="Stills" hint="Save the frame in the viewer with its grade, then compare it with the live frame or give its grade to another clip.">
      <div className="flex flex-wrap gap-1">
        <button className={btn} onClick={save}>Save still</button>
        {(["wipe"] as const).map((m) => (
          <button key={m} className={`rounded-md px-2 py-0.5 text-[11px] ${compare.mode === m ? "bg-accent/25 text-accent" : "text-gray-400 hover:bg-white/10"}`} disabled={!compare.id} aria-pressed={compare.mode === m} onClick={() => setCompare({ mode: compare.mode === m ? "off" : m })}>
            Wipe (drag the divider to 50% for a split)
          </button>
        ))}
      </div>
      {compare.mode !== "off" && <input type="range" min={0} max={100} value={Math.round(compare.pos * 100)} onChange={(e) => setCompare({ pos: Number(e.target.value) / 100 })} aria-label="Compare divider" className="w-full" />}
      {stills.length === 0 && <p className="text-[12px] text-gray-500">No stills yet.</p>}
      <div className="grid grid-cols-2 gap-2">
        {stills.map((s) => (
          <div key={s.id} className={`space-y-1 rounded-lg border p-1 ${compare.id === s.id ? "border-accent" : "border-edge"}`}>
            <button className="block w-full" onClick={() => setCompare({ id: s.id, mode: compare.mode === "off" ? "wipe" : compare.mode })} title="Compare with the viewer">
              <img src={s.url} alt={s.name} className="w-full rounded" />
            </button>
            <input className="field !py-0.5 text-[11px]" value={s.name} onChange={(e) => rename(s.id, e.target.value)} aria-label="Still name" />
            <div className="flex gap-1">
              <button className={btn} disabled={!clip || !s.grade.length} title={clip ? "Add this still's colour effects to the selected clip" : "Select one clip"} onClick={() => clip && editTimeline((t) => FX.applyStackTo(t, [clip.id], s.grade, "append"))}>Apply grade</button>
              <button className={btn} onClick={() => remove(s.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
