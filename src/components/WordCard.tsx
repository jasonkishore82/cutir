import { useState, type ReactNode } from "react";
import { Card, Icon, Segmented } from "./ui";
import { EASING_NAMES, IN_EFFECTS, OUT_EFFECTS } from "../lib/animations";
import { DEFAULT_EMPHASIS, layerIdOf, resolveStyle, useProject } from "../store/project";
import { getIn, resetWord, selectedWordOf, wordTransformOf, writeWordStyle, writeWordTransform, type WordTransform } from "./wordEdit";

/** Typefaces offered in the font pickers. */
export const FONTS = ["Permanent Marker", "IBM Plex Sans KR", "Inter", "Arial", "Georgia", "Impact", "Courier New"];

/** Entrances that only make sense for a whole line. */
const LINE_ONLY = new Set(["word-by-word", "word-highlight"]);

type Level = "0" | "1" | "2" | "3";
const EMPHASIS_OPTS: { value: Level; label: string }[] = [
  { value: "0", label: "None" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
];

/** Value on the right of a row, plus a reset button while the word has its own value. */
function Meta({ own, text, onReset }: { own: boolean; text: ReactNode; onReset: () => void }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        title={own ? "This word has its own value" : "This value comes from the line"}
        className={`rounded px-1.5 py-px text-[10px] ${own ? "bg-accent/15 text-accent" : "bg-white/[0.06] text-gray-500"}`}
      >
        {own ? "Word" : "Line"}
      </span>
      <span className="tabular-nums text-gray-500">{text}</span>
      {own && (
        <button onClick={onReset} title="Reset to line" aria-label="Reset to line" className="grid h-5 w-5 place-items-center rounded text-gray-500 hover:bg-white/10 hover:text-white">
          <Icon name="undo" className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/**
 * The word picked on the preview (double-click a line): emphasis, its own look, entrance and exit, and its extra
 * placement. Every value falls back to the line; "Reset to line" drops everything the word has of its own.
 */
export default function WordCard() {
  const project = useProject((s) => s.project);
  const selWord = useProject((s) => s.selectedWord);
  const [slot, setSlot] = useState<"in" | "out">("in");
  const sel = selectedWordOf(project, selWord);
  if (!sel) return null;
  const { line, index, text, count, override } = sel;
  const lineId = line.id;
  const locked = !!project.layers.find((x) => x.id === layerIdOf(project, line))?.locked;
  const base = resolveStyle(project, line);
  const em = override.emphasis ?? 0;
  const level = em ? (base.emphasis ?? DEFAULT_EMPHASIS)[em - 1] : undefined;
  const tf = wordTransformOf(override);
  const own = (path: string) => getIn(override.style, path) !== undefined;
  const val = <T,>(path: string, fallback?: T): T => (getIn(override.style, path) ?? fallback ?? getIn(base, path)) as T;
  const put = (path: string, v: unknown) => writeWordStyle(lineId, index, path, v, `w:${lineId}:${index}:${path}`);
  const unset = (path: string) => writeWordStyle(lineId, index, path, undefined);
  const btn = "rounded-lg border border-edge bg-black/20 px-3 py-1.5 text-[12px] text-gray-300 hover:bg-raised hover:text-white";

  const slider = (label: string, path: string, min: number, max: number, step: number, unit = "") => {
    const v = val<number>(path);
    return (
      <div>
        <div className="mb-2 flex items-center justify-between text-[12px]">
          <span className="text-gray-300">{label}</span>
          <Meta own={own(path)} text={`${Math.round(v * 100) / 100}${unit}`} onReset={() => unset(path)} />
        </div>
        <input type="range" className="block w-full" aria-label={`Word ${label.toLowerCase()}`} min={min} max={max} step={step} value={v} onChange={(e) => put(path, Number(e.target.value))} />
      </div>
    );
  };
  const color = (label: string, path: string, fallback?: string) => (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <label className="flex items-center gap-2.5 text-gray-300">
        <input type="color" aria-label={`Word ${label.toLowerCase()}`} value={val<string>(path, fallback)} onChange={(e) => put(path, e.target.value)} />
        {label}
      </label>
      <Meta own={own(path)} text="" onReset={() => unset(path)} />
    </div>
  );
  const select = (label: string, path: string, options: string[]) => {
    const cur = getIn(override.style, path) as string | undefined;
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[12px]">
          <span className="text-gray-300">{label}</span>
          <Meta own={cur !== undefined} text="" onReset={() => unset(path)} />
        </div>
        <select className="field" aria-label={`Word ${label.toLowerCase()}`} value={cur ?? ""} onChange={(e) => (e.target.value ? put(path, e.target.value) : unset(path))}>
          <option value="">Same as line ({String(getIn(base, path))})</option>
          {[...new Set([...(cur ? [cur] : []), ...options])].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  };
  const move = (label: string, k: keyof WordTransform, min: number, max: number, factor: number, unit: string) => (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between text-[12px]">
        <span className="text-gray-300">{label}</span>
        <span className="tabular-nums text-gray-500">{Math.round(tf[k] * factor * 10) / 10}{unit}</span>
      </span>
      <input
        type="range"
        className="block w-full"
        aria-label={`Word ${label.toLowerCase()}`}
        min={min}
        max={max}
        step={factor === 1 ? 1 : 0.5}
        value={tf[k] * factor}
        onChange={(e) => writeWordTransform(lineId, index, { [k]: Number(e.target.value) / factor }, `wt:${lineId}:${index}:${k}`)}
      />
    </label>
  );

  const effects = (slot === "in" ? IN_EFFECTS : OUT_EFFECTS).filter((n) => !LINE_ONLY.has(n));
  const hasTf = !!override.transform;
  const hasAny = Object.keys(override).length > 0;

  return (
    <Card title="Selected word" hint="Double-click another word on the preview to switch. Escape goes back to the whole line.">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-gray-100" title={text}>{text}</p>
          <p className="text-[11px] text-gray-500">Word {index + 1} of {count}{locked ? " (layer locked)" : ""}</p>
        </div>
        <button className={`${btn} shrink-0`} onClick={() => useProject.getState().selectWord(null)}>Back to line</button>
      </div>

      <fieldset disabled={locked} className="space-y-3 disabled:opacity-50">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[12px]">
            <span className="text-gray-300">Emphasis</span>
            {level && <span className="tabular-nums text-gray-500">{Math.round(level.scale * 100)}%{level.bold ? ", bold" : ""}</span>}
          </div>
          <Segmented
            label="Emphasis level"
            value={String(em) as Level}
            options={EMPHASIS_OPTS}
            onChange={(v) => useProject.getState().updateWord(lineId, index, { emphasis: Number(v) as 0 | 1 | 2 | 3 })}
          />
          <p className="mt-1.5 text-[11px] text-gray-500">Each level's look is set once for the project (Motion, Beats and emphasis).</p>
        </div>

        {color("Colour", "color", level?.color)}
        {select("Typeface", "fontFamily", FONTS)}
        {slider("Outline width", "outline.width", 0, 20, 1)}
        {color("Outline colour", "outline.color")}

        <div className="space-y-3 rounded-lg border border-edge p-2.5">
          <Segmented label="Word animation slot" value={slot} options={[{ value: "in", label: "In" }, { value: "out", label: "Out" }]} onChange={setSlot} />
          {select("Effect", `animation.${slot}.name`, effects)}
          {select("Easing", `animation.${slot}.easing`, EASING_NAMES)}
          {slider("Duration", `animation.${slot}.ms`, 0, 2000, 50, " ms")}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-gray-200">Placement</span>
            {hasTf && (
              <button className="text-[11px] text-accent hover:underline" onClick={() => useProject.getState().updateWord(lineId, index, { transform: undefined })}>
                Reset placement
              </button>
            )}
          </div>
          {move("Move across", "x", -50, 50, 100, "%")}
          {move("Move down", "y", -50, 50, 100, "%")}
          {move("Size", "scale", 10, 400, 100, "%")}
          {move("Rotation", "rotation", -180, 180, 1, " deg")}
          <p className="text-[11px] text-gray-500">Offsets from where the line puts this word. Drag the word on the preview to move, scale or rotate it.</p>
        </div>

        <button className={`${btn} w-full text-left disabled:opacity-40`} disabled={!hasAny} onClick={() => resetWord(lineId, index)}>
          Reset to line
        </button>
      </fieldset>
    </Card>
  );
}
