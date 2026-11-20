import { Card, Slider } from "./ui";
import { PropCheck, PropChoice, PropSlider, useTarget } from "./props";
import { editStyle, readField } from "../lib/styleEdit";
import { applyAutoEmphasis } from "../lib/emphasis";
import { useState } from "react";
import { applyCollageLayout } from "../lib/collage";
import { SHAPES, addSticker, autoDoodles, clearStickers, removeSticker, updateSticker } from "../lib/stickers";
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

      <Card title="Ghost lines" hint="Faded copies of the lines before and after the current one, stacked behind it.">
        <PropSlider path="ghosts" label="Count" min={0} max={4} step={1} auto={0} zero="off" />
        <PropSlider path="ghostOpacity" label="Brightness" min={0.05} max={1} step={0.05} auto={0.3} />
        <PropSlider path="ghostSpacing" label="Spacing" min={0.4} max={1.6} step={0.05} auto={0.9} unit="x" />
        <PropCheck path="ghostEcho" label="Echo: repeat this line as outlines" />
      </Card>

      <CollageCard lineIds={scope === "line" ? ids : undefined} />

      <StickerCard lineIds={scope === "line" ? ids : undefined} />

      <EmphasisCard lineIds={scope === "line" ? ids : undefined} />
    </>
  );
}

/** Doodle stickers: small drawings that pop in behind a line. Pick a shape to add it to the chosen line(s). */
function StickerCard({ lineIds }: { lineIds?: string[] }) {
  const project = useProject((s) => s.project);
  const [note, setNote] = useState("");
  const one = lineIds?.length === 1 ? project.lines.find((l) => l.id === lineIds[0]) : undefined;
  const accent = project.style.highlight?.color && project.style.highlight.color !== project.style.color ? project.style.highlight.color : "#ffd84a";
  const edit = (fn: (p: typeof project) => typeof project) => useProject.getState().update(fn);
  return (
    <Card title="Doodle stickers" hint="Little drawings that pop in behind a line, like hearts, stars and cutlery. Select a line, then pick a shape.">
      <div className="grid grid-cols-5 gap-1.5">
        {SHAPES.map((sh) => (
          <button
            key={sh.id}
            title={`Add ${sh.name}`}
            aria-label={`Add ${sh.name}`}
            disabled={!lineIds?.length}
            className="flex h-10 items-center justify-center rounded-md border border-edge bg-black/20 hover:bg-raised disabled:opacity-40"
            onClick={() => edit((p) => addSticker(p, lineIds!, sh.id, accent))}
          >
            <svg viewBox="0 0 100 100" width="22" height="22" fill="currentColor" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300">
              {sh.fill && <path d={sh.fill} stroke="none" />}
              {sh.line && <path d={sh.line} fill="none" />}
            </svg>
          </button>
        ))}
      </div>
      {!lineIds?.length && <p className="text-[11px] text-gray-500">Select a line in the lyrics or the timeline first.</p>}
      <div className="flex gap-1.5">
        <button
          className={btn}
          onClick={() => {
            const r = autoDoodles(useProject.getState().project, lineIds);
            edit(() => r.project);
            setNote(r.added ? `Added ${r.added} doodle${r.added === 1 ? "" : "s"} from the lyrics.` : "No lyric words matched a doodle.");
          }}
          title="Pick a doodle for lines that mention love, fire, stars, music, food and so on"
        >
          Auto doodles
        </button>
        <button className={btn} onClick={() => edit((p) => clearStickers(p, lineIds))}>Clear</button>
      </div>
      {note && <p className="text-[11px] text-gray-500">{note}</p>}
      {one?.stickers?.map((st) => (
        <div key={st.id} className="space-y-1.5 rounded-lg border border-edge p-2">
          <div className="flex items-center justify-between text-[12px] text-gray-300">
            <span>{SHAPES.find((x) => x.id === st.shape)?.name ?? st.shape}</span>
            <span className="flex items-center gap-2">
              <input type="color" aria-label="Sticker colour" value={st.color} onChange={(e) => edit((p) => updateSticker(p, one.id, st.id, { color: e.target.value }))} />
              <label className="flex items-center gap-1 text-[11px]">
                <input type="checkbox" checked={st.outline} onChange={(e) => edit((p) => updateSticker(p, one.id, st.id, { outline: e.target.checked }))} />
                outline
              </label>
              <button className="text-red-400 hover:text-red-300" onClick={() => edit((p) => removeSticker(p, one.id, st.id))}>Remove</button>
            </span>
          </div>
          <Slider label="Size" value={Math.round(st.size * 100)} min={5} max={60} step={1} unit="%" onChange={(v) => edit((p) => updateSticker(p, one.id, st.id, { size: v / 100 }))} />
          <Slider label="Left / right" value={Math.round(st.x * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => edit((p) => updateSticker(p, one.id, st.id, { x: v / 100 }))} />
          <Slider label="Up / down" value={Math.round(st.y * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => edit((p) => updateSticker(p, one.id, st.id, { y: v / 100 }))} />
          <Slider label="Tilt" value={Math.round(st.rotation)} min={-90} max={90} step={1} unit=" deg" onChange={(v) => edit((p) => updateSticker(p, one.id, st.id, { rotation: v }))} />
        </div>
      ))}
    </Card>
  );
}

/** Collage layout: each line gets its own place, size and tilt. Run it again for a different arrangement. */
function CollageCard({ lineIds }: { lineIds?: string[] }) {
  const which = lineIds?.length ? (lineIds.length === 1 ? "this line" : `${lineIds.length} lines`) : "every line";
  const run = () => useProject.getState().update((p) => applyCollageLayout(p, lineIds, Math.floor(Math.random() * 1e9)));
  return (
    <Card title="Collage layout" hint="Scatters lines around the frame at different sizes and tilts, like a kinetic poster. Click again for a new arrangement.">
      <button className={btn} onClick={run} title={`Place ${which} around the frame`}>Collage {which}</button>
      <p className="text-[11px] text-gray-500">Sets position, size and rotation only. Use Reset position in the Position card to undo, or Ctrl+Z.</p>
    </Card>
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
