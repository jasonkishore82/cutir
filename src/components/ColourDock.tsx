import { Card } from "./ui";
import ScopesCard from "./ScopesCard";
import StillsCard from "./StillsCard";
import { EffectCard } from "./EffectsPanel";
import { useProject } from "../store/project";
import { useWorkspace } from "../store/workspace";
import { activeTimeline } from "../model/convert";
import { editTimeline, useTimelineUi } from "../timeline/ui";
import { GRADE_EFFECTS } from "../lib/stills";
import { getEffect } from "../lib/effects";
import * as FX from "../timeline/effects";

const btn = "rounded-md border border-edge px-2 py-1 text-[11px] text-gray-300 hover:bg-raised hover:text-white disabled:opacity-40";

/**
 * The colour dock (phase 20): scopes, the selected clip's grade controls (wheels, curves, LUT, colour space) and the
 * stills gallery in one panel beside the viewer, so grading never needs the inspector. It is part of the page layout:
 * the Color page opens with it, any page can show it (Layout presets, or the View command), and it resizes and hides
 * like the other panels.
 */
export default function ColourDock() {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const tl = activeTimeline(doc);
  const targets = FX.effectTargets(tl, doc, selected);
  const clip = targets.length === 1 ? tl.clips.find((c) => c.id === targets[0]) : undefined;
  const grade = clip && !clip.graph ? clip.effects.filter((e) => GRADE_EFFECTS.includes(e.type)) : [];

  return (
    <div className="flex h-full flex-col" role="region" aria-label="Colour dock">
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-3 py-2">
        <h2 className="text-[13px] font-semibold text-gray-100">Colour</h2>
        <button className="rounded px-1.5 text-[11px] text-gray-400 hover:bg-white/10 hover:text-white" onClick={() => useWorkspace.getState().setLayout({ dock: false })} aria-label="Hide the colour dock">Hide</button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <ScopesCard />
        <Card title="Grade" hint={clip ? "Colour effects of the selected clip. They apply top to bottom, and keyframe like any effect." : "Select one video or image clip on the timeline to grade it."}>
          <div className="flex flex-wrap gap-1">
            {GRADE_EFFECTS.map((id) => (
              <button key={id} className={btn} disabled={!clip || !!clip.graph} onClick={() => clip && editTimeline((t) => FX.addEffect(t, [clip.id], id))}>
                + {getEffect(id)?.name ?? id}
              </button>
            ))}
          </div>
          {clip && !grade.length && !clip.graph && <p className="text-[12px] text-gray-500">No colour effects yet. Add a Colour grade to get the wheels.</p>}
          {clip?.graph && <p className="text-[12px] text-gray-500">This clip uses a node graph; edit it in the Effects tab.</p>}
          {grade.map((fx) => (
            <EffectCard key={fx.id} clipId={clip!.id} fx={fx} first={clip!.effects[0]?.id === fx.id} last={clip!.effects[clip!.effects.length - 1]?.id === fx.id} clipStart={clip!.start} />
          ))}
        </Card>
        <StillsCard />
      </div>
    </div>
  );
}
