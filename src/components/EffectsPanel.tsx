import { useEffect, useState } from "react";
import { Card, Slider } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import type { ClipEffect, ClipTransition, ParamKey } from "../model/types";
import { getEffect, getTransition, keyedValue, listEffects, listTransitions, type EffectCategory, type ParamSpec, type Params } from "../lib/effects";
import * as FX from "../timeline/effects";
import { editTimeline, tlNow, useTimelineUi } from "../timeline/ui";
import { EASING_NAMES } from "../lib/animations";
import { getTime } from "../lib/transport";

export const EFFECT_MIME = "application/x-cutir-effect";
export const TRANSITION_MIME = "application/x-cutir-transition";

const PRESETS_KEY = "cutir:fx-presets";
type Preset = { name: string; stack: ClipEffect[] };
const readPresets = (): Preset[] => {
  try {
    return JSON.parse(localStorage.getItem(PRESETS_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const writePresets = (p: Preset[]) => {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {
    /* storage full */
  }
};
let stackClipboard: ClipEffect[] | null = null;

/** The Effects tab: effect and transition browser, the selected clip's stack, the selected transition. */
export default function EffectsPanel() {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const selTr = useTimelineUi((s) => s.selectedTransition);
  const tl = activeTimeline(doc);
  const targets = FX.effectTargets(tl, doc, selected);
  const clip = targets.length === 1 ? tl.clips.find((c) => c.id === targets[0]) : undefined;
  const transition = selTr ? tl.cutTransitions?.find((x) => x.id === selTr) : undefined;

  // stop previewing when the panel goes away
  useEffect(() => () => useTimelineUi.setState({ previewEffect: null }), []);

  return (
    <>
      <Browser targets={targets} />
      {transition && <TransitionEditor tr={transition} />}
      {clip ? (
        <StackEditor clipId={clip.id} stack={clip.effects} start={clip.start} />
      ) : (
        <Card title="Effect stack">
          <p className="text-[12px] text-gray-500">{targets.length > 1 ? `${targets.length} clips selected: click an effect to add it to all of them.` : "Select a video or image clip on the timeline to see its effects."}</p>
        </Card>
      )}
    </>
  );
}

/* ---------- browser ---------- */

function Browser({ targets }: { targets: string[] }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<EffectCategory | "All">("All");
  const all = listEffects();
  const cats = ["All", ...new Set(all.map((e) => e.category))] as (EffectCategory | "All")[];
  const k = q.trim().toLowerCase();
  const shown = all.filter((e) => (cat === "All" || e.category === cat) && (!k || `${e.name} ${e.description} ${e.category}`.toLowerCase().includes(k)));
  const trs = listTransitions().filter((t) => !k || `${t.name} ${t.description}`.toLowerCase().includes(k));
  const item = "flex w-full cursor-grab items-start gap-2 rounded-lg border border-edge bg-black/20 px-2.5 py-1.5 text-left hover:border-accent/60 hover:bg-raised";

  const addTransitionForSelection = (type: string) => {
    const t = tlNow();
    const c = t.clips.find((x) => x.id === targets[0]);
    if (!c) return;
    const next = t.clips.find((x) => x.trackId === c.trackId && Math.abs(x.start - (c.start + c.duration)) < 0.05 && x.id !== c.id);
    editTimeline((x) => FX.addTransition(x, { trackId: c.trackId, from: c.id, to: next?.id, type }));
  };

  return (
    <Card title="Effects and transitions" hint="Hover to preview on the selected clip, click to add, or drag onto a clip, a track or a cut.">
      <input className="field" placeholder="Search effects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search effects" />
      <div className="flex flex-wrap gap-1">
        {cats.map((c) => (
          <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c} className={`rounded-md px-2 py-0.5 text-[11px] ${cat === c ? "bg-accent/25 text-accent" : "text-gray-400 hover:bg-white/10"}`}>
            {c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-1">
        {shown.map((e) => (
          <button
            key={e.id}
            className={item}
            draggable
            onDragStart={(ev) => (ev.dataTransfer.setData(EFFECT_MIME, e.id), (ev.dataTransfer.effectAllowed = "copy"))}
            onMouseEnter={() => targets.length && useTimelineUi.setState({ previewEffect: e.id })}
            onMouseLeave={() => useTimelineUi.setState({ previewEffect: null })}
            onFocus={() => targets.length && useTimelineUi.setState({ previewEffect: e.id })}
            onBlur={() => useTimelineUi.setState({ previewEffect: null })}
            onClick={() => {
              if (!targets.length) return;
              useTimelineUi.setState({ previewEffect: null });
              editTimeline((t) => FX.addEffect(t, targets, e.id));
            }}
            title={targets.length ? "Click to add to the selected clip" : "Drag onto a clip, or select a clip first"}
          >
            <span className="flex-1">
              <span className="block text-[12px] text-gray-100">{e.name}</span>
              <span className="block text-[10px] text-gray-500">{e.description}</span>
            </span>
            {e.gpu && <span className="rounded bg-white/5 px-1 text-[9px] text-gray-500" title="Runs on the graphics card">GPU</span>}
          </button>
        ))}
      </div>
      {trs.length > 0 && (
        <>
          <p className="pt-1 text-[11px] uppercase tracking-wide text-gray-600">Transitions</p>
          <div className="grid grid-cols-2 gap-1">
            {trs.map((t) => (
              <button
                key={t.id}
                className={item}
                draggable
                onDragStart={(ev) => (ev.dataTransfer.setData(TRANSITION_MIME, t.id), (ev.dataTransfer.effectAllowed = "copy"))}
                onClick={() => addTransitionForSelection(t.id)}
                title={targets.length ? "Click: at the end of the selected clip (into the next one if it touches). Or drag onto a cut." : "Drag onto a cut or a clip edge"}
              >
                <span className="text-[12px] text-gray-100">{t.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------- the selected clip's stack ---------- */

function StackEditor({ clipId, stack, start }: { clipId: string; stack: ClipEffect[]; start: number }) {
  const [presets, setPresets] = useState(readPresets);
  const [naming, setNaming] = useState(false);
  const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-raised disabled:opacity-40";
  return (
    <Card title="Effect stack" hint="Effects apply top to bottom.">
      {stack.length === 0 && <p className="text-[12px] text-gray-500">No effects yet. Click one above.</p>}
      {stack.map((fx, i) => (
        <EffectCard key={fx.id} clipId={clipId} fx={fx} first={i === 0} last={i === stack.length - 1} clipStart={start} />
      ))}
      <div className="flex flex-wrap gap-1">
        <button className={btn} disabled={!stack.length} onClick={() => (stackClipboard = stack)}>Copy stack</button>
        <button className={btn} disabled={!stackClipboard} onClick={() => stackClipboard && editTimeline((t) => FX.applyStackTo(t, [clipId], stackClipboard!))}>Paste stack</button>
        <button className={btn} disabled={!stack.length} onClick={() => setNaming(true)}>Save as preset</button>
      </div>
      {naming && (
        <input
          autoFocus
          className="field"
          placeholder="Preset name"
          onKeyDown={(e) => {
            if (e.key === "Escape") setNaming(false);
            if (e.key !== "Enter") return;
            const name = e.currentTarget.value.trim() || "My preset";
            const next = [...presets.filter((p) => p.name !== name), { name, stack: FX.copyStack(stack) }];
            writePresets(next);
            setPresets(next);
            setNaming(false);
          }}
          onBlur={() => setNaming(false)}
        />
      )}
      {presets.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-gray-500">Presets</p>
          {presets.map((p) => (
            <div key={p.name} className="flex items-center gap-1">
              <button className={`${btn} flex-1 text-left`} onClick={() => editTimeline((t) => FX.applyStackTo(t, [clipId], p.stack, "append"))} title="Add these effects to the clip">
                {p.name} <span className="text-gray-500">({p.stack.length})</span>
              </button>
              <button
                className="rounded px-1 text-[11px] text-gray-500 hover:text-red-400"
                aria-label={`Delete preset ${p.name}`}
                onClick={() => {
                  const next = presets.filter((x) => x.name !== p.name);
                  writePresets(next);
                  setPresets(next);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EffectCard({ clipId, fx, first, last, clipStart }: { clipId: string; fx: ClipEffect; first: boolean; last: boolean; clipStart: number }) {
  const def = getEffect(fx.type);
  const [open, setOpen] = useState(true);
  const small = "rounded px-1 text-[11px] text-gray-500 hover:bg-white/10 hover:text-gray-200 disabled:opacity-30";
  if (!def) return <p className="text-[11px] text-red-400">Unknown effect {fx.type} (from a plugin that is not installed).</p>;
  const set = (params: Params, key: string) => editTimeline((t) => FX.updateEffect(t, clipId, fx.id, { params }), `fx:${fx.id}:${key}`);
  return (
    <div className={`space-y-2 rounded-lg border border-edge p-2 ${fx.enabled ? "" : "opacity-60"}`}>
      <div className="flex items-center gap-1">
        <input type="checkbox" checked={fx.enabled} aria-label={`${def.name} on`} onChange={(e) => editTimeline((t) => FX.updateEffect(t, clipId, fx.id, { enabled: e.target.checked }))} />
        <button className="flex-1 text-left text-[12px] font-medium text-gray-100" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {def.name}
        </button>
        <button className={small} disabled={first} title="Earlier in the stack" onClick={() => editTimeline((t) => FX.moveEffect(t, clipId, fx.id, -1))}>▲</button>
        <button className={small} disabled={last} title="Later in the stack" onClick={() => editTimeline((t) => FX.moveEffect(t, clipId, fx.id, 1))}>▼</button>
        <button className={small} title="Reset to defaults" onClick={() => editTimeline((t) => FX.resetEffect(t, clipId, fx.id))}>↺</button>
        <button className={`${small} hover:!text-red-400`} title="Remove" onClick={() => editTimeline((t) => FX.removeEffect(t, clipId, fx.id))}>✕</button>
      </div>
      {open &&
        def.params.map((spec) => (
          <ParamField
            key={spec.key}
            spec={spec}
            value={fx.params[spec.key]}
            keys={fx.keys?.[spec.key]}
            now={getTime() - clipStart}
            onChange={(v) => set({ [spec.key]: v }, spec.key)}
            onKeys={(keys) => editTimeline((t) => FX.updateEffect(t, clipId, fx.id, { keys: { ...(fx.keys ?? {}), [spec.key]: keys } }))}
          />
        ))}
    </div>
  );
}

/** One param, its control generated from its spec. Numeric params can be keyframed at the playhead. */
function ParamField({ spec, value, keys, now, onChange, onKeys }: { spec: ParamSpec; value: unknown; keys?: ParamKey[]; now: number; onChange: (v: unknown) => void; onKeys: (k: ParamKey[]) => void }) {
  const numeric = spec.type === "number" || spec.type === "angle";
  const keyBtn = numeric ? (
    <span className="flex items-center gap-1">
      <button
        className={`rounded px-1 text-[11px] ${keys?.length ? "text-yellow-300" : "text-gray-500"} hover:bg-white/10`}
        title={keys?.length ? `${keys.length} keyframe(s). Click: add one at the playhead` : "Add a keyframe at the playhead"}
        onClick={() => {
          const t = Math.max(0, Math.round(now * 100) / 100);
          const v = keyedValue(keys, t, typeof value === "number" ? value : 0);
          onKeys([...(keys ?? []).filter((k) => Math.abs(k.t - t) > 0.02), { t, v, easing: "ease-in-out" as const }].sort((a, b) => a.t - b.t));
        }}
      >
        ◆
      </button>
      {!!keys?.length && (
        <button className="rounded px-1 text-[10px] text-gray-500 hover:text-red-400" title="Remove this param's keyframes" onClick={() => onKeys([])}>
          clear
        </button>
      )}
    </span>
  ) : null;

  // with keyframes, the slider edits the keyframe at the playhead (or the value at the playhead, which adds one)
  const keyedChange = (v: number) => {
    if (!keys?.length) return onChange(v);
    const t = Math.max(0, Math.round(now * 100) / 100);
    onKeys([...keys.filter((k) => Math.abs(k.t - t) > 0.02), { t, v, easing: keys.find((k) => Math.abs(k.t - t) <= 0.02)?.easing ?? "ease-in-out" }].sort((a, b) => a.t - b.t));
  };
  const shown = numeric && keys?.length ? keyedValue(keys, now, typeof value === "number" ? value : 0) : value;

  switch (spec.type) {
    case "number":
      return (
        <div className="flex items-end gap-1">
          <div className="flex-1">
            <Slider label={spec.label} value={Math.round(Number(shown ?? spec.default) * 100) / 100} min={spec.min} max={spec.max} step={spec.step ?? 1} unit={spec.unit ? ` ${spec.unit}` : ""} onChange={keyedChange} />
          </div>
          {keyBtn}
        </div>
      );
    case "angle":
      return (
        <div className="flex items-end gap-1">
          <div className="flex-1">
            <Slider label={spec.label} value={Math.round(Number(shown ?? spec.default))} min={-180} max={180} unit=" deg" onChange={keyedChange} />
          </div>
          {keyBtn}
        </div>
      );
    case "color":
      return (
        <label className="flex items-center justify-between text-[12px] text-gray-300">
          {spec.label}
          <input type="color" value={String(value ?? spec.default)} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-[12px] text-gray-300">
          <input type="checkbox" checked={Boolean(value ?? spec.default)} onChange={(e) => onChange(e.target.checked)} />
          {spec.label}
        </label>
      );
    case "choice":
      return (
        <label className="block">
          <span className="label">{spec.label}</span>
          <select className="field" value={String(value ?? spec.default)} onChange={(e) => onChange(e.target.value)}>
            {spec.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      );
    case "point": {
      const p = (value as { x: number; y: number }) ?? spec.default;
      return (
        <div className="grid grid-cols-2 gap-2">
          <Slider label={`${spec.label} across`} value={Math.round(p.x * 100)} min={0} max={100} unit="%" onChange={(x) => onChange({ ...p, x: x / 100 })} />
          <Slider label="down" value={Math.round(p.y * 100)} min={0} max={100} unit="%" onChange={(y) => onChange({ ...p, y: y / 100 })} />
        </div>
      );
    }
    case "curve":
      return <p className="text-[11px] text-gray-500">{spec.label}: curve (edit through the chat for now)</p>;
  }
}

/* ---------- the selected transition ---------- */

function TransitionEditor({ tr }: { tr: ClipTransition }) {
  const def = getTransition(tr.type);
  const set = (patch: Parameters<typeof FX.updateTransition>[2], key: string) => editTimeline((t) => FX.updateTransition(t, tr.id, patch), `tr:${tr.id}:${key}`);
  const kind = tr.type === "crossfade" ? "Audio crossfade" : def?.name ?? tr.type;
  return (
    <Card title={`Transition: ${kind}`} hint={tr.from && tr.to ? "At a cut between two clips" : tr.from ? "At the end of a clip" : "At the start of a clip"}>
      {tr.type !== "crossfade" && (
        <label className="block">
          <span className="label">Type</span>
          <select className="field" value={tr.type} onChange={(e) => set({ type: e.target.value }, "type")}>
            {listTransitions().map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
      )}
      <Slider label="Length" value={tr.duration} min={0.1} max={4} step={0.05} unit=" s" onChange={(v) => set({ duration: v }, "d")} />
      {tr.from && tr.to && (
        <label className="block">
          <span className="label">Position</span>
          <select className="field" value={tr.align} onChange={(e) => set({ align: e.target.value as ClipTransition["align"] }, "a")}>
            <option value="end">Ends at the cut</option>
            <option value="center">Centred on the cut</option>
            <option value="start">Starts at the cut</option>
          </select>
        </label>
      )}
      <label className="block">
        <span className="label">Easing</span>
        <select className="field" value={tr.easing} onChange={(e) => set({ easing: e.target.value as ClipTransition["easing"] }, "e")}>
          {EASING_NAMES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      {def?.params.map((spec) => (
        <ParamField key={spec.key} spec={spec} value={tr.params[spec.key]} now={0} onChange={(v) => set({ params: { [spec.key]: v } }, spec.key)} onKeys={() => undefined} />
      ))}
      <button
        className="w-full rounded-lg border border-red-900/60 px-3 py-1.5 text-[12px] text-red-300 hover:bg-red-950/60"
        onClick={() => {
          editTimeline((t) => FX.removeTransition(t, tr.id));
          useTimelineUi.setState({ selectedTransition: null });
        }}
      >
        Remove transition
      </button>
    </Card>
  );
}
