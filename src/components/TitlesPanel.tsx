import { useEffect, useMemo, useState } from "react";
import { Card, Segmented, Slider } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import type { Clip, Generator, ShapeSpec, TitleAnimator, TitleSpec } from "../model/types";
import { editTimeline, useTimelineUi } from "../timeline/ui";
import { getTime } from "../lib/transport";
import { ensureFont } from "../lib/fonts";
import { GENERATOR_KINDS, SHAPE_KINDS, newGenerator, shapeOf } from "../lib/generators";
import { TITLE_TEMPLATES, addGeneratorClips, buildTemplate, updateGenerator, type TitleTemplate } from "../lib/titleTemplates";
import { ANIMATOR_PRESETS, DEFAULT_FROM, titleOf } from "../lib/titles";
import { LYRIC_PACKS, lyricClips, lyricsToTitles, removeLyricTitles } from "../lib/lyricPack";
import { buildUserTemplate, captureTemplate, deleteTemplate, loadTemplates, saveTemplate, templateFields, type UserTemplate } from "../lib/userTemplates";
import { deletePreset, loadPresets, savePreset, titleFromPreset, type TitlePreset } from "../lib/titlePresets";

const btn = "rounded-lg border border-edge bg-black/20 px-2.5 py-1.5 text-[12px] text-gray-300 hover:bg-raised hover:text-white";

/** The Titles tab: templates, generators and shapes you can add at the playhead, and the editor for the selected one. */
export default function TitlesPanel() {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const tl = activeTimeline(doc);
  const clip = selected.length === 1 ? tl.clips.find((c) => c.id === selected[0] && c.generator) : undefined;

  const add = (plans: Parameters<typeof addGeneratorClips>[1]) => {
    let ids: string[] = [];
    editTimeline((t) => {
      const r = addGeneratorClips(t, plans, getTime());
      ids = r.ids;
      return r.tl;
    });
    useTimelineUi.setState({ selected: ids.slice(-1) });
  };

  return (
    <>
      <Templates onAdd={add} />
      <MyTemplates onAdd={add} />
      <LyricPackCard />
      <Presets onAdd={add} current={clip?.generator?.type === "title" ? clip.generator.title : undefined} />
      <Card title="Generators and shapes" hint="Added at the playhead on a free video track. Move, fade, key and add effects to them like any clip.">
        <div className="flex flex-wrap gap-1.5">
          {GENERATOR_KINDS.filter((g) => g.id !== "shape" && g.id !== "title").map((g) => (
            <button key={g.id} className={btn} onClick={() => add([{ name: g.name, generator: newGenerator(g.id), duration: 5 }])}>
              {g.name}
            </button>
          ))}
          <button className={btn} onClick={() => add([{ name: "Title", generator: { type: "title", title: titleOf() }, duration: 5 }])}>Title</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SHAPE_KINDS.map((s) => (
            <button key={s.id} className={btn} onClick={() => add([{ name: s.name, generator: { type: "shape", shape: shapeOf(s.id) }, duration: 5 }])}>
              {s.name}
            </button>
          ))}
        </div>
      </Card>
      {clip ? <GeneratorEditor clip={clip} /> : <Card title="Selected clip"><p className="text-[12px] text-gray-500">Click a title, shape or generator clip on the timeline to edit it here.</p></Card>}
    </>
  );
}

/* ---------- templates ---------- */

function Templates({ onAdd }: { onAdd: (plans: Parameters<typeof addGeneratorClips>[1]) => void }) {
  const [id, setId] = useState(TITLE_TEMPLATES[0].id);
  const [values, setValues] = useState<Record<string, string>>({});
  const t = TITLE_TEMPLATES.find((x) => x.id === id) as TitleTemplate;
  const val = (k: string, d: string) => values[`${id}:${k}`] ?? d;
  return (
    <Card title="Title templates" hint="Pick one, fill in the words, add it at the playhead.">
      <div className="grid grid-cols-2 gap-1.5">
        {TITLE_TEMPLATES.map((x) => (
          <button key={x.id} onClick={() => setId(x.id)} aria-pressed={x.id === id} title={x.description} className={`rounded-lg border px-2.5 py-2 text-left text-[12px] ${x.id === id ? "border-accent bg-accent/15 text-white ring-1 ring-accent" : "border-edge bg-black/20 text-gray-300 hover:bg-raised"}`}>
            {x.name}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-gray-500">{t.description}</p>
      {t.fields.map((f) => (
        <label key={f.key} className="block">
          <span className="label">{f.label}</span>
          {f.key === "color" ? (
            <input type="color" value={val(f.key, f.default)} onChange={(e) => setValues({ ...values, [`${id}:${f.key}`]: e.target.value })} />
          ) : f.multiline ? (
            <textarea className="field min-h-[72px]" value={val(f.key, f.default)} onChange={(e) => setValues({ ...values, [`${id}:${f.key}`]: e.target.value })} />
          ) : (
            <input className="field" value={val(f.key, f.default)} onChange={(e) => setValues({ ...values, [`${id}:${f.key}`]: e.target.value })} />
          )}
        </label>
      ))}
      <button className="w-full rounded-lg bg-accent/90 px-3 py-2 text-[13px] font-medium text-black hover:bg-accent" onClick={() => onAdd(buildTemplate(id, Object.fromEntries(t.fields.map((f) => [f.key, val(f.key, f.default)]))))}>
        Add {t.name.toLowerCase()} at the playhead
      </button>
    </Card>
  );
}

/* ---------- saved multi-clip templates ---------- */

function MyTemplates({ onAdd }: { onAdd: (plans: Parameters<typeof addGeneratorClips>[1]) => void }) {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const tl = activeTimeline(doc);
  const gens = tl.clips.filter((c) => selected.includes(c.id) && c.generator).length;
  const [list, setList] = useState<UserTemplate[]>(() => loadTemplates());
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string>("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const save = () => {
    try {
      setList(saveTemplate(captureTemplate(tl, selected, name)));
      setName("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const t = list.find((x) => x.id === open);
  return (
    <Card title="My templates" hint="Select several titles or shapes on the timeline (a bar and its text), save them as one template, and add the whole group again with new words.">
      <div className="flex gap-1.5">
        <input className="field" placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className={btn} disabled={!gens || !name.trim()} onClick={save} title={gens ? `Save ${gens} selected clip${gens === 1 ? "" : "s"}` : "Select titles or shapes first"}>Save {gens > 1 ? `${gens} clips` : ""}</button>
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {list.map((x) => (
        <div key={x.id} className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <button className={`${btn} flex-1 text-left`} onClick={() => (setOpen(open === x.id ? "" : x.id), setVals({}))}>{x.name} <span className="text-gray-500">({x.clips.length} clip{x.clips.length === 1 ? "" : "s"})</span></button>
            <button className="text-[11px] text-gray-500 hover:text-red-400" onClick={() => setList(deleteTemplate(x.id))} aria-label={`Delete template ${x.name}`}>delete</button>
          </div>
          {t && t.id === x.id && (
            <div className="space-y-1.5 pl-2">
              {templateFields(t).map((f) => (
                <label key={f.key} className="block"><span className="label">{f.label}</span><textarea className="field" rows={2} value={vals[f.key] ?? f.default} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} /></label>
              ))}
              <button className="w-full rounded-lg bg-accent/90 px-3 py-2 text-[13px] font-medium text-black hover:bg-accent" onClick={() => onAdd(buildUserTemplate(t, vals))}>Add at the playhead</button>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

/* ---------- lyric pack ---------- */

function LyricPackCard() {
  const doc = useProject((s) => s.doc);
  const tl = activeTimeline(doc);
  const subs = tl.tracks.filter((t) => t.kind === "subtitle" && lyricClips(tl, t.id).length);
  const [pack, setPack] = useState(LYRIC_PACKS[0].id);
  const [track, setTrack] = useState("");
  const [msg, setMsg] = useState("");
  const src = subs.find((t) => t.id === track) ?? subs[0];
  const bound = src ? tl.tracks.some((t) => t.lyricsOf === src.id) : false;
  const p = LYRIC_PACKS.find((x) => x.id === pack)!;
  const apply = () => {
    if (!src) return;
    try {
      let n = 0;
      editTimeline((t) => {
        const r = lyricsToTitles(t, src.id, p);
        n = r.created;
        return r.tl;
      });
      setMsg(`${n} lines shown with ${p.name}.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <Card title="Lyric pack" hint="Show the lines of a subtitle track (synced lyrics, LRC or SRT) as animated titles. The subtitle lines stay as the timing: run it again after retiming.">
      {!src ? (
        <p className="text-[12px] text-gray-500">No subtitle track with lines yet. Sync or import lyrics first.</p>
      ) : (
        <>
          {subs.length > 1 && (
            <label className="block"><span className="label">Lines from</span>
              <select className="field" value={src.id} onChange={(e) => setTrack(e.target.value)}>{subs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </label>
          )}
          <label className="block"><span className="label">Pack</span>
            <select className="field" value={pack} onChange={(e) => setPack(e.target.value)}>{LYRIC_PACKS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </label>
          <p className="text-[11px] text-gray-500">{p.description}</p>
          <div className="flex gap-1.5">
            <button className="flex-1 rounded-lg bg-accent/90 px-3 py-2 text-[13px] font-medium text-black hover:bg-accent" onClick={apply}>{bound ? "Refresh titles" : "Show as titles"}</button>
            {bound && <button className={btn} onClick={() => (editTimeline((t) => removeLyricTitles(t, src.id)), setMsg("Back to the plain subtitle lines."))}>Back to subtitles</button>}
          </div>
        </>
      )}
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
    </Card>
  );
}

/* ---------- your saved title looks ---------- */

function Presets({ onAdd, current }: { onAdd: (plans: Parameters<typeof addGeneratorClips>[1]) => void; current?: TitleSpec }) {
  const [list, setList] = useState<TitlePreset[]>(() => loadPresets());
  const [name, setName] = useState("");
  const [text, setText] = useState("Your words");
  const [error, setError] = useState("");
  const save = () => {
    if (!current) return;
    try {
      setList(savePreset(name, current));
      setName("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="My title presets" hint="Save the look of the selected title (font, colours, box, animation) and add it again with new words.">
      <div className="flex gap-1.5">
        <input className="field" placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className={btn} disabled={!current || !name.trim()} onClick={save} title={current ? "Save the selected title's look" : "Select a title clip first"}>Save</button>
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {list.length > 0 && (
        <>
          <label className="block"><span className="label">Words for new titles</span><input className="field" value={text} onChange={(e) => setText(e.target.value)} /></label>
          {list.map((p) => (
            <div key={p.id} className="flex items-center gap-1.5">
              <button className={`${btn} flex-1 text-left`} onClick={() => onAdd([{ name: p.name, generator: { type: "title", title: titleFromPreset(p, text) }, duration: 5 }])}>Add &ldquo;{p.name}&rdquo;</button>
              <button className="text-[11px] text-gray-500 hover:text-red-400" onClick={() => setList(deletePreset(p.id))} aria-label={`Delete preset ${p.name}`}>delete</button>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

/* ---------- editor for the selected generator clip ---------- */

function GeneratorEditor({ clip }: { clip: Clip }) {
  const g = clip.generator as Generator;
  const set = (patch: Partial<Generator>, key: string) => editTimeline((t) => updateGenerator(t, clip.id, patch), `gen:${clip.id}:${key}`);
  const color = (label: string, v: string, key: string, fn: (c: string) => void) => (
    <label className="flex items-center justify-between text-[12px] text-gray-300" key={key}>
      {label}
      <input type="color" value={v || "#000000"} onChange={(e) => fn(e.target.value)} />
    </label>
  );
  const kind = GENERATOR_KINDS.find((k) => k.id === g.type)?.name ?? g.type;
  return (
    <Card title={`${kind}: ${clip.name ?? ""}`.trim()}>
      {g.type === "solid" && color("Colour", g.color, "color", (c) => set({ color: c }, "color"))}
      {g.type === "gradient" && (
        <>
          {g.colors.map((c, i) => color(i === 0 ? "From" : i === g.colors.length - 1 ? "To" : `Stop ${i + 1}`, c, `c${i}`, (v) => set({ colors: g.colors.map((x, j) => (j === i ? v : x)) }, `c${i}`)))}
          <Slider label="Angle" value={g.angle} min={0} max={360} unit=" deg" onChange={(v) => set({ angle: v }, "angle")} />
        </>
      )}
      {g.type === "noise" && (
        <>
          <Slider label="Amount" value={g.amount} min={0} max={100} unit="%" onChange={(v) => set({ amount: v }, "amount")} />
          <Slider label="Grain size" value={g.scale} min={1} max={16} onChange={(v) => set({ scale: v }, "scale")} />
          <Slider label="Speed (changes per second)" value={g.speed} min={0} max={60} onChange={(v) => set({ speed: v }, "speed")} />
          {color("Tint", g.color, "color", (c) => set({ color: c }, "color"))}
          <label className="flex items-center gap-2 text-[12px] text-gray-300"><input type="checkbox" checked={g.mono} onChange={(e) => set({ mono: e.target.checked }, "mono")} />Black and white</label>
        </>
      )}
      {g.type === "countdown" && (
        <>
          <Slider label="Start from" value={g.from} min={1} max={30} onChange={(v) => set({ from: v }, "from")} />
          <Slider label="Size" value={Math.round(g.size * 100)} min={5} max={80} unit="%" onChange={(v) => set({ size: v / 100 }, "size")} />
          {color("Colour", g.color, "color", (c) => set({ color: c }, "color"))}
          <label className="flex items-center gap-2 text-[12px] text-gray-300"><input type="checkbox" checked={g.ring} onChange={(e) => set({ ring: e.target.checked }, "ring")} />Ring that empties each second</label>
        </>
      )}
      {g.type === "timecode" && (
        <>
          <Slider label="Size" value={Math.round(g.size * 100)} min={2} max={30} unit="%" onChange={(v) => set({ size: v / 100 }, "size")} />
          <Slider label="Frame rate" value={g.fps} min={24} max={60} onChange={(v) => set({ fps: v }, "fps")} />
          <Slider label="Start at (seconds)" value={g.offset} min={0} max={3600} onChange={(v) => set({ offset: v }, "offset")} />
          {color("Colour", g.color, "color", (c) => set({ color: c }, "color"))}
          <label className="flex items-center gap-2 text-[12px] text-gray-300"><input type="checkbox" checked={g.box} onChange={(e) => set({ box: e.target.checked }, "box")} />Dark box behind</label>
        </>
      )}
      {g.type === "shape" && <ShapeEditor shape={g.shape} onChange={(s, k) => set({ shape: s }, k)} />}
      {g.type === "title" && <TitleEditor title={g.title} duration={clip.duration} onChange={(t, k) => set({ title: t }, k)} />}
    </Card>
  );
}

function ShapeEditor({ shape: s, onChange }: { shape: ShapeSpec; onChange: (s: ShapeSpec, key: string) => void }) {
  const up = (patch: Partial<ShapeSpec>, key: string) => onChange({ ...s, ...patch }, key);
  const colour = (label: string, v: string, key: "fill" | "stroke", allowNone: boolean) => (
    <label className="flex items-center justify-between text-[12px] text-gray-300">
      {label}
      <span className="flex items-center gap-2">
        {allowNone && <button className="text-[10px] text-gray-500 hover:text-gray-200" onClick={() => up({ [key]: "" }, key)}>none</button>}
        <input type="color" value={v || "#000000"} onChange={(e) => up({ [key]: e.target.value }, key)} />
      </span>
    </label>
  );
  return (
    <>
      <Segmented label="Shape" value={s.kind} options={SHAPE_KINDS.map((k) => ({ value: k.id, label: k.name }))} onChange={(k) => onChange(shapeOf(k, { x: s.x, y: s.y, fill: s.fill || shapeOf(k).fill }), "kind")} />
      {s.kind !== "line" && colour("Fill", s.fill, "fill", true)}
      {colour(s.kind === "line" ? "Colour" : "Outline", s.stroke, "stroke", false)}
      <Slider label="Outline width" value={Math.round(s.strokeWidth * 1000)} min={0} max={60} unit="/1000" onChange={(v) => up({ strokeWidth: v / 1000 }, "sw")} />
      <Slider label="Across" value={Math.round(s.x * 100)} min={0} max={100} unit="%" onChange={(v) => up({ x: v / 100 }, "x")} />
      <Slider label="Down" value={Math.round(s.y * 100)} min={0} max={100} unit="%" onChange={(v) => up({ y: v / 100 }, "y")} />
      <Slider label="Width" value={Math.round(s.width * 100)} min={1} max={200} unit="%" onChange={(v) => up({ width: v / 100 }, "w")} />
      {s.kind !== "line" && <Slider label="Height" value={Math.round(s.height * 100)} min={1} max={100} unit="%" onChange={(v) => up({ height: v / 100 }, "h")} />}
      {s.kind === "rectangle" && <Slider label="Corner radius" value={Math.round(s.radius * 100)} min={0} max={50} unit="%" onChange={(v) => up({ radius: v / 100 }, "r")} />}
      {s.kind === "polygon" && <Slider label="Corners" value={s.sides} min={3} max={12} onChange={(v) => up({ sides: v }, "sides")} />}
      <Slider label="Rotation" value={s.rotation} min={-180} max={180} unit=" deg" onChange={(v) => up({ rotation: v }, "rot")} />
    </>
  );
}

const FONTS = ["Inter", "Bebas Neue", "Anton", "Playfair Display", "Oswald", "Montserrat", "Roboto Slab", "Lobster", "Pacifico", "Cairo", "Noto Sans Hebrew"];

/** True when the browser can draw this family (a Google or local font that is loaded or installed). */
const hasFont = (family: string) => {
  try {
    return document.fonts.check(`16px "${family}"`) || ["sans-serif", "serif", "monospace"].includes(family);
  } catch {
    return true;
  }
};

function TitleEditor({ title: s, duration, onChange }: { title: TitleSpec; duration: number; onChange: (t: TitleSpec, key: string) => void }) {
  const up = (patch: Partial<TitleSpec>, key: string) => onChange({ ...s, ...patch }, key);
  const anim = (patch: Partial<TitleAnimator>, key: string) => up({ animator: { ...s.animator, ...patch } }, key);
  const [missing, setMissing] = useState(false);
  const fonts = useMemo(() => (FONTS.includes(s.font) ? FONTS : [s.font, ...FONTS]), [s.font]);
  useEffect(() => {
    let live = true;
    void ensureFont(s.font, s.text).then(() => live && setMissing(!hasFont(s.font)));
    return () => {
      live = false;
    };
  }, [s.font, s.text]);
  const row = "flex items-center justify-between text-[12px] text-gray-300";
  const check = (label: string, v: boolean, fn: (b: boolean) => void) => (
    <label className="flex items-center gap-2 text-[12px] text-gray-300"><input type="checkbox" checked={v} onChange={(e) => fn(e.target.checked)} />{label}</label>
  );
  const runFor = (i: number) => s.runs.find((r) => r.start <= i && i < r.end);
  void runFor;
  return (
    <>
      <label className="block">
        <span className="label">Text (Enter for a new line)</span>
        <textarea className="field min-h-[72px]" dir="auto" value={s.text} onChange={(e) => up({ text: e.target.value }, "text")} />
      </label>
      <label className="block">
        <span className="label">Font</span>
        <select className="field" value={s.font} onChange={(e) => up({ font: e.target.value }, "font")}>
          {fonts.map((f) => <option key={f}>{f}</option>)}
        </select>
      </label>
      {missing && <p className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-[11px] text-yellow-200">&ldquo;{s.font}&rdquo; is not available here, so the fallback fonts below are used. It may look different on another computer.</p>}
      <label className="block">
        <span className="label">Fallback fonts (comma separated)</span>
        <input className="field" value={s.fallback.join(", ")} onChange={(e) => up({ fallback: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }, "fallback")} />
      </label>
      <Slider label="Size" value={Math.round(s.size * 1000) / 10} min={1} max={40} step={0.5} unit="%" onChange={(v) => up({ size: v / 100 }, "size")} />
      <Slider label="Weight" value={s.weight} min={100} max={900} step={100} onChange={(v) => up({ weight: v }, "weight")} />
      <div className="flex gap-4">
        {check("Italic", s.italic, (b) => up({ italic: b }, "italic"))}
        {check("Underline", s.underline, (b) => up({ underline: b }, "underline"))}
        {check("Fit to the box", s.autoFit, (b) => up({ autoFit: b }, "fit"))}
      </div>
      <Segmented label="Alignment" value={s.align} options={["left", "center", "right"] as const} onChange={(a) => up({ align: a }, "align")} />
      <Slider label="Line spacing" value={Math.round(s.lineHeight * 100)} min={70} max={250} unit="%" onChange={(v) => up({ lineHeight: v / 100 }, "lh")} />
      <Slider label="Letter spacing" value={Math.round(s.letterSpacing * 100)} min={-10} max={50} unit="%" onChange={(v) => up({ letterSpacing: v / 100 }, "ls")} />
      <Slider label="Box width" value={Math.round(s.width * 100)} min={10} max={100} unit="%" onChange={(v) => up({ width: v / 100 }, "width")} />
      <Slider label="Across" value={Math.round(s.x * 100)} min={0} max={100} unit="%" onChange={(v) => up({ x: v / 100 }, "x")} />
      <Slider label="Down" value={Math.round(s.y * 100)} min={0} max={100} unit="%" onChange={(v) => up({ y: v / 100 }, "y")} />

      <p className="pt-1 text-[11px] uppercase tracking-wide text-gray-600">Fill</p>
      <label className={row}>Colour<input type="color" value={s.color} onChange={(e) => up({ color: e.target.value }, "color")} /></label>
      {check("Gradient", s.gradient, (b) => up({ gradient: b }, "grad"))}
      {s.gradient && (
        <>
          <label className={row}>Second colour<input type="color" value={s.color2} onChange={(e) => up({ color2: e.target.value }, "color2")} /></label>
          <Slider label="Gradient angle" value={s.gradientAngle} min={0} max={360} unit=" deg" onChange={(v) => up({ gradientAngle: v }, "gangle")} />
        </>
      )}
      <label className="block">
        <span className="label">Image fill</span>
        <span className="flex items-center gap-2">
          <input
            type="file"
            accept="image/*"
            className="text-[11px] text-gray-400"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = new FileReader();
              r.onload = () => up({ fillImage: String(r.result) }, "img");
              r.readAsDataURL(f);
            }}
          />
          {s.fillImage && <button className="text-[11px] text-gray-500 hover:text-red-400" onClick={() => up({ fillImage: undefined }, "img")}>remove</button>}
        </span>
      </label>

      <p className="pt-1 text-[11px] uppercase tracking-wide text-gray-600">Outline and effects</p>
      <Slider label="Outline" value={Math.round(s.strokeWidth * 1000)} min={0} max={40} unit="/1000" onChange={(v) => up({ strokeWidth: v / 1000 }, "sw")} />
      {s.strokeWidth > 0 && <label className={row}>Outline colour<input type="color" value={s.stroke} onChange={(e) => up({ stroke: e.target.value }, "stroke")} /></label>}
      {check("Shadow", s.shadow, (b) => up({ shadow: b }, "shadow"))}
      {s.shadow && <Slider label="Shadow blur" value={Math.round(s.shadowBlur * 1000)} min={0} max={60} unit="/1000" onChange={(v) => up({ shadowBlur: v / 1000 }, "sb")} />}
      <Slider label="Glow" value={Math.round(s.glow * 1000)} min={0} max={80} unit="/1000" onChange={(v) => up({ glow: v / 1000 }, "glow")} />
      {s.glow > 0 && <label className={row}>Glow colour<input type="color" value={s.glowColor} onChange={(e) => up({ glowColor: e.target.value }, "gc")} /></label>}
      {check("Bevel (layered strokes)", s.bevel, (b) => up({ bevel: b }, "bevel"))}

      <p className="pt-1 text-[11px] uppercase tracking-wide text-gray-600">Background box</p>
      {check("Box behind the text", !!s.box, (b) => up({ box: b ? { color: "#101018", padding: 0.025, radius: 0.01, opacity: 0.85 } : null }, "box"))}
      {s.box && (
        <>
          <label className={row}>Box colour<input type="color" value={s.box.color} onChange={(e) => up({ box: { ...s.box!, color: e.target.value } }, "boxc")} /></label>
          <Slider label="Padding" value={Math.round(s.box.padding * 1000)} min={0} max={100} unit="/1000" onChange={(v) => up({ box: { ...s.box!, padding: v / 1000 } }, "boxp")} />
          <Slider label="Corner radius" value={Math.round(s.box.radius * 1000)} min={0} max={100} unit="/1000" onChange={(v) => up({ box: { ...s.box!, radius: v / 1000 } }, "boxr")} />
          <Slider label="Box opacity" value={Math.round(s.box.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => up({ box: { ...s.box!, opacity: v / 100 } }, "boxo")} />
        </>
      )}

      <p className="pt-1 text-[11px] uppercase tracking-wide text-gray-600">Per-character animation</p>
      <label className="block">
        <span className="label">Preset</span>
        <select className="field" value={s.animator.preset} onChange={(e) => {
          const p = ANIMATOR_PRESETS.find((x) => x.id === e.target.value)!;
          anim({ preset: p.id, unit: p.unit, duration: p.duration }, "preset");
        }}>
          {ANIMATOR_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {s.animator.preset !== "none" && s.animator.preset !== "roll" && (
        <>
          <Segmented label="Animate by" value={s.animator.unit} options={[{ value: "char", label: "letter" }, { value: "word", label: "word" }, { value: "line", label: "line" }]} onChange={(u) => anim({ unit: u }, "unit")} />
          <Slider label="Duration (seconds)" value={s.animator.duration} min={0.2} max={Math.max(2, duration)} step={0.1} onChange={(v) => anim({ duration: v }, "dur")} />
          <Slider label="Range starts at" value={s.animator.rangeStart} min={0} max={100} unit="%" onChange={(v) => anim({ rangeStart: Math.min(v, s.animator.rangeEnd - 1) }, "rs")} />
          <Slider label="Range ends at" value={s.animator.rangeEnd} min={0} max={100} unit="%" onChange={(v) => anim({ rangeEnd: Math.max(v, s.animator.rangeStart + 1) }, "re")} />
          <Slider label="Range offset" value={s.animator.offset} min={-100} max={100} unit="%" onChange={(v) => anim({ offset: v }, "ro")} />
        </>
      )}
      {s.animator.preset === "custom" && <CustomAnimator a={s.animator} onChange={(patch) => anim(patch, "from")} />}
      <Slider label="Fade out at the end (seconds)" value={s.animator.outDuration} min={0} max={3} step={0.1} onChange={(v) => anim({ outDuration: v }, "out")} />
      <Slider label="Credits roll speed (screens per second)" value={s.roll} min={0} max={0.5} step={0.01} onChange={(v) => up({ roll: v }, "roll")} />
      <RunsEditor s={s} up={up} />
    </>
  );
}

/** The custom animator: where each unit starts (opacity, offset, scale, rotation, blur, colour) before it eases into place. */
function CustomAnimator({ a, onChange }: { a: TitleAnimator; onChange: (p: Partial<TitleAnimator>) => void }) {
  const f = a.from ?? DEFAULT_FROM;
  const set = (patch: Partial<typeof f>) => onChange({ from: { ...f, ...patch } });
  return (
    <div className="space-y-1 rounded-lg border border-edge p-2">
      <p className="text-[11px] text-gray-500">Each piece starts like this and eases into place as the animation reaches it.</p>
      <Slider label="Starts at opacity" value={Math.round(f.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => set({ opacity: v / 100 })} />
      <Slider label="Starts across by" value={Math.round(f.dx * 100)} min={-500} max={500} unit="% of text height" onChange={(v) => set({ dx: v / 100 })} />
      <Slider label="Starts down by" value={Math.round(f.dy * 100)} min={-500} max={500} unit="% of text height" onChange={(v) => set({ dy: v / 100 })} />
      <Slider label="Starts at size" value={Math.round(f.scale * 100)} min={0} max={400} unit="%" onChange={(v) => set({ scale: v / 100 })} />
      <Slider label="Starts rotated by" value={f.rotation} min={-720} max={720} unit=" deg" onChange={(v) => set({ rotation: v })} />
      <Slider label="Starts blurred by" value={Math.round(f.blur * 100)} min={0} max={100} unit="%" onChange={(v) => set({ blur: v / 100 })} />
      <Slider label="Starts mixed with 2nd colour" value={Math.round(f.tint * 100)} min={0} max={100} unit="%" onChange={(v) => set({ tint: v / 100 })} />
    </div>
  );
}

/** Style part of the text: type the letters to style (start and end of the range), then the look. */
function RunsEditor({ s, up }: { s: TitleSpec; up: (p: Partial<TitleSpec>, key: string) => void }) {
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(Math.min(5, s.text.length));
  const total = s.text.length;
  const addRun = () => up({ runs: [...s.runs, { start: Math.max(0, Math.min(from, total)), end: Math.max(from + 1, Math.min(to, total)), color: "#ffd84a", weight: 900 }] }, `run${s.runs.length}`);
  return (
    <>
      <p className="pt-1 text-[11px] uppercase tracking-wide text-gray-600">Style part of the text</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block"><span className="label">From letter</span><input type="number" className="field" min={0} max={total} value={from} onChange={(e) => setFrom(Number(e.target.value))} /></label>
        <label className="block"><span className="label">To letter</span><input type="number" className="field" min={0} max={total} value={to} onChange={(e) => setTo(Number(e.target.value))} /></label>
      </div>
      <p className="text-[11px] text-gray-500">&ldquo;{s.text.slice(from, to)}&rdquo;</p>
      <button className={btn} onClick={addRun}>Style this part</button>
      {s.runs.map((r, i) => (
        <div key={i} className="space-y-1 rounded-lg border border-edge p-2">
          <div className="flex items-center justify-between text-[12px] text-gray-300">
            <span>&ldquo;{s.text.slice(r.start, r.end)}&rdquo; ({r.start}-{r.end})</span>
            <button className="text-[11px] text-gray-500 hover:text-red-400" onClick={() => up({ runs: s.runs.filter((_, j) => j !== i) }, `rm${i}`)}>remove</button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-gray-300">
            <input type="color" value={r.color ?? s.color} onChange={(e) => up({ runs: s.runs.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) }, `rc${i}`)} aria-label="Colour" />
            <select className="field !w-auto" aria-label="Font for this part" value={r.font ?? ""} onChange={(e) => { void (e.target.value && ensureFont(e.target.value, s.text.slice(r.start, r.end))); up({ runs: s.runs.map((x, j) => (j === i ? { ...x, font: e.target.value || undefined } : x)) }, `rf${i}`); }}>
              <option value="">Same font</option>
              {(r.font && !FONTS.includes(r.font) ? [r.font, ...FONTS] : FONTS).map((f) => <option key={f}>{f}</option>)}
            </select>
            <label className="flex items-center gap-1"><input type="checkbox" checked={(r.weight ?? s.weight) >= 800} onChange={(e) => up({ runs: s.runs.map((x, j) => (j === i ? { ...x, weight: e.target.checked ? 900 : 400 } : x)) }, `rw${i}`)} />Bold</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={r.italic ?? s.italic} onChange={(e) => up({ runs: s.runs.map((x, j) => (j === i ? { ...x, italic: e.target.checked } : x)) }, `ri${i}`)} />Italic</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={r.underline ?? s.underline} onChange={(e) => up({ runs: s.runs.map((x, j) => (j === i ? { ...x, underline: e.target.checked } : x)) }, `ru${i}`)} />Underline</label>
          </div>
        </div>
      ))}
    </>
  );
}
