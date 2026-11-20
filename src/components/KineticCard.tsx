import { Card, Slider } from "./ui";
import { PropCheck, PropChoice, PropSlider, useTarget } from "./props";
import { editStyle, readField } from "../lib/styleEdit";
import { applyAutoEmphasis } from "../lib/emphasis";
import { BEAT_NAMES } from "../lib/animations";
import { DEFAULT_BEAT, DEFAULT_EMPHASIS, setWordOverride, useProject, type BeatName, type EmphasisLevel } from "../store/project";


const btn = "rounded-lg border border-edge bg-black/20 px-3 py-2 text-left text-[13px] text-gray-300 hover:bg-raised hover:text-white disabled:opacity-40 disabled:hover:bg-black/20 disabled:hover:text-gray-300";

/**
 * Kinetic controls: how text hits on each beat, how much the song's loudness drives motion, and emphasis.
 * Beat and energy follow the "what to edit" bar (line, layer or project); emphasis looks are set for the project.
 */
export default function KineticCard() {
  const { target, scope, ids, project } = useTarget();
  const hasBeats = (project.beats?.length ?? 0) > 0;
  const beatName = (readField(project, target, "animation.beat.name").value as BeatName | undefined) ?? "none";

  return (
    <>
      <Card title="Beat reaction" hint="A short hit on every beat of the song, stronger on big hits.">
        {hasBeats ? (
          <>
            <PropChoice
              path="animation.beat.name"
              label="Effect"
              options={BEAT_NAMES}
              columns={3}
              onPick={(v, t) =>
                // the project style always holds a whole beat slot, so older projects get one on first use
                t.scope === "project" && !project.style.animation.beat
                  ? editStyle(t, { set: [["animation.beat", { ...DEFAULT_BEAT, name: v }]] })
                  : editStyle(t, { set: [["animation.beat.name", v]] })
              }
            />
            {beatName !== "none" && (
              <>
                <PropSlider path="animation.beat.strength" label="Strength" min={0} max={2} step={0.05} unit="x" auto={DEFAULT_BEAT.strength} />
                <PropCheck path="animation.beat.downbeatsOnly" label="Downbeats only (first beat of each bar)" />
              </>
            )}
            <p className="text-[11px] text-gray-500">{project.beats!.length} beats on this timeline.</p>
          </>
        ) : (
          <p className="text-[12px] text-gray-500">Beats are detected when a song is added. To find them for a song already in the project, use Detect beats on it in the media pool.</p>
        )}
      </Card>

      <Card title="Energy" hint="How much the song's loudness drives motion: calm in quiet parts, intense in loud ones.">
        <PropSlider path="energy" label="Amount" min={0} max={1} step={0.05} auto={0} zero="none" />
        {!project.energy && <p className="text-[11px] text-gray-500">The song's loudness is measured with its beats; until then this has no effect.</p>}
      </Card>

      <EmphasisCard lineIds={scope === "line" ? ids : undefined} />
    </>
  );
}

/** Automatic emphasis for the chosen lines (all lines without a selection) and the looks of the three levels. */
function EmphasisCard({ lineIds }: { lineIds?: string[] }) {
  const project = useProject((s) => s.project);
  const levels: EmphasisLevel[] = project.style.emphasis ?? DEFAULT_EMPHASIS;
  const which = lineIds?.length ? (lineIds.length === 1 ? "this line" : `${lineIds.length} lines`) : "every line";
  const emphasised = project.lines.filter((l) => (!lineIds?.length || lineIds.includes(l.id)) && Object.values(l.wordOverrides ?? {}).some((o) => o.emphasis)).length;

  const auto = () => useProject.getState().update((p) => applyAutoEmphasis(p, lineIds?.length ? lineIds : undefined));
  const clear = () =>
    useProject.getState().update((p) => ({
      ...p,
      lines: p.lines.map((l) => {
        if ((lineIds?.length && !lineIds.includes(l.id)) || !l.wordOverrides) return l;
        let out = l;
        for (const i of Object.keys(l.wordOverrides)) if (l.wordOverrides[+i].emphasis) out = setWordOverride(out, +i, { emphasis: undefined });
        return out;
      }),
    }));
  /** Change one level's look for the whole project (one undo step per drag). */
  const setLevel = (i: number, patch: Partial<EmphasisLevel>, key?: string) =>
    useProject.getState().update((p) => {
      const cur = [...(p.style.emphasis ?? DEFAULT_EMPHASIS)];
      const next: EmphasisLevel = { ...cur[i], ...patch };
      if (next.color === undefined) delete next.color;
      cur[i] = next;
      return { ...p, style: { ...p.style, emphasis: cur } };
    }, key);

  return (
    <Card title="Emphasis" hint="Key words of a line get bigger, bolder or an accent colour. Pick a single word on the preview to set its level by hand.">
      <div className="grid grid-cols-2 gap-1.5">
        <button className={btn} onClick={auto} title={`Pick the key words of ${which}`}>Auto emphasis</button>
        <button className={btn} disabled={!emphasised} onClick={clear}>Clear emphasis</button>
      </div>
      <p className="text-[11px] text-gray-500">Works on {which}. One click, one undo.</p>

      {levels.slice(0, 3).map((lv, i) => (
        <div key={i} className="space-y-2.5 rounded-lg border border-edge p-2.5">
          <span className="text-[12px] font-medium text-gray-200">Level {i + 1}</span>
          <Slider label="Size" value={Math.round(lv.scale * 100)} min={100} max={300} step={5} unit="%" onChange={(v) => setLevel(i, { scale: v / 100 }, `emph:${i}:scale`)} />
          <div className="flex items-center justify-between gap-3 text-[12px]">
            <label className="flex items-center gap-2 text-gray-300">
              <input type="checkbox" checked={!!lv.bold} onChange={(e) => setLevel(i, { bold: e.target.checked })} />
              Bold
            </label>
            <span className="flex items-center gap-2 text-gray-300">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={lv.color !== undefined} onChange={(e) => setLevel(i, { color: e.target.checked ? "#ffd84a" : undefined })} />
                Colour
              </label>
              {lv.color !== undefined && <input type="color" aria-label={`Level ${i + 1} colour`} value={lv.color} onChange={(e) => setLevel(i, { color: e.target.value }, `emph:${i}:color`)} />}
            </span>
          </div>
        </div>
      ))}
      <p className="text-[11px] text-gray-500">Level looks are shared by the whole project: changing one restyles every word at that level.</p>
    </Card>
  );
}
