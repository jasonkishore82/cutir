import { useRef, useState } from "react";
import { ensureFont, markFontReady } from "../lib/fonts";
import { parseSubtitleFile } from "../lib/subtitles";
import AutoSync from "./AutoSync";
import KeyframesCard from "./KeyframesCard";
import ClipCard from "./ClipCard";
import EffectsPanel from "./EffectsPanel";
import TemplatesCard from "./TemplatesCard";
import TransitionsCard from "./TransitionsCard";
import WordCard, { FONTS } from "./WordCard";
import KineticCard from "./KineticCard";
import MediaPool, { PoolThumb } from "./MediaPool";
import { useMedia, type MediaItem } from "../store/media";
import { SECTIONS, type SectionId } from "./SectionTabs";
import { ActionButton, Card, Icon, Row, Segmented } from "./ui";
import { useLibrary } from "../store/library";
import { ScopeBar, PropCheck, PropChoice, PropColor, PropSelect, PropSlider, useTarget } from "./props";
import { IN_EFFECTS, OUT_EFFECTS, LOOP_NAMES, EASING_NAMES } from "../lib/animations";
import { alignLines, applyStyle, copyStyle, distributeLines, editStyle, idsOfLayer, readField, resetFields, snapshotOf, useStyleClipboard, writeField, type AlignMode } from "../lib/styleEdit";
import {
  layerIdOf,
  linesOfLayer,
  linesToText,
  orderByLayers,
  useProject,
  type Aspect,
  type Position,
} from "../store/project";

const POSITIONS: Position[] = ["top", "center", "bottom"];
const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

const CANVAS_PX: Record<Aspect, string> = { "16:9": "1920 x 1080", "9:16": "1080 x 1920", "1:1": "1080 x 1080" };

const GRADIENT_PRESETS: { name: string; colors: string[]; angle: number }[] = [
  { name: "Sunset", colors: ["#1e2a6b", "#5b3a8c", "#d4687a", "#f0a070"], angle: 135 },
  { name: "Ocean", colors: ["#0b132b", "#1c2541", "#3a6ea5", "#6fffe9"], angle: 160 },
  { name: "Neon", colors: ["#12002b", "#6a00f4", "#f20089"], angle: 120 },
  { name: "Mono", colors: ["#111111", "#444444"], angle: 90 },
];

function pickFile(accept: string, onFile: (f: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => input.files?.[0] && onFile(input.files[0]);
  input.click();
}

export default function LeftPanel({ tab, onGoto }: { tab: SectionId; onGoto?: (s: SectionId) => void }) {
  const project = useProject((s) => s.project);
  const activeLayerId = useProject((s) => s.activeLayerId);
  const setActiveLayer = useProject((s) => s.setActiveLayer);
  const layer = project.layers.find((l) => l.id === activeLayerId) ?? project.layers[0];
  const layerLines = linesOfLayer(project, layer.id);
  const setAspect = useProject((s) => s.setAspect);
  const setBackground = useProject((s) => s.setBackground);
  const setAudio = useProject((s) => s.setAudio);
  const setLinesFromText = useProject((s) => s.setLinesFromText);
  const { target, ...sel } = useTarget();
  const pool = useMedia((s) => s.items);
  const audioItems = pool.filter((i) => i.kind === "audio");
  const visualItems = pool.filter((i) => i.kind === "video" || i.kind === "image");
  const lastAudioUrl = useRef<string>();
  const [gfont, setGfont] = useState("");
  const [gfontMsg, setGfontMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [gfontBusy, setGfontBusy] = useState(false);

  /** Download a font from Google Fonts by name and use it. */
  const useGoogleFont = async () => {
    const name = gfont.trim();
    if (!name || gfontBusy) return;
    setGfontBusy(true);
    setGfontMsg(null);
    try {
      const family = await ensureFont(name, useProject.getState().project.lines.map((l) => l.text).join(" "));
      writeField(target, "fontFamily", family);
      setGfontMsg({ ok: true, text: `Using ${family}` });
      setGfont("");
    } catch (e) {
      setGfontMsg({ ok: false, text: (e as Error).message });
    } finally {
      setGfontBusy(false);
    }
  };

  const loadAudio = (f: File, mediaId?: string) => {
    if (lastAudioUrl.current) URL.revokeObjectURL(lastAudioUrl.current);
    lastAudioUrl.current = URL.createObjectURL(f);
    setAudio({ name: f.name, kind: "audio", url: lastAudioUrl.current, mediaId });
    useLibrary.getState().saveAsset("audio", f, f.name); // so the project gets its song back when reopened
  };

  const loadBackground = (f: File, mediaId?: string) => {
    const kind = f.type.startsWith("video") ? "video" : "image";
    setBackground({ type: "asset", asset: { name: f.name, kind, url: URL.createObjectURL(f), mediaId } });
    useLibrary.getState().saveAsset("bg", f, f.name);
  };

  /** A file picked from the Song, Background or Canva card also joins the media pool. */
  const chooseAudio = async (f: File) => loadAudio(f, (await useMedia.getState().addFiles([f]))[0]?.id);
  const chooseBackground = async (f: File) => loadBackground(f, (await useMedia.getState().addFiles([f]))[0]?.id);
  const useFromPool = async (item: MediaItem) => {
    const f = await useMedia.getState().fileOf(item.id);
    if (!f) return;
    if (item.kind === "audio") loadAudio(f, item.id);
    else loadBackground(f, item.id);
  };

  const loadFont = async (f: File) => {
    const family = f.name.replace(/\.[^.]+$/, "");
    try {
      const face = new FontFace(family, await f.arrayBuffer());
      await face.load();
      document.fonts.add(face);
      markFontReady(family);
      writeField(target, "fontFamily", family);
    } catch {
      alert("Could not load that font file.");
    }
  };

  const meta = SECTIONS.find((x) => x.id === tab) ?? SECTIONS[0];
  const textBtn = "rounded-lg border border-edge bg-black/20 px-3 py-2 text-[13px] text-gray-300 hover:bg-raised hover:text-white";

  return (
    <div id="inspector" role="tabpanel" aria-labelledby={`tab-${tab}`} className="space-y-3 p-3.5 text-sm">
      <header className="px-0.5 pb-1 pt-0.5">
        <h2 className="text-gradient text-[19px] font-semibold tracking-tight">{meta.title}</h2>
      </header>

      {tab === "import" && (
        <>
          <Card title="Import">
            <MediaPool compact />
          </Card>
          <Card title="Canva">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
                if (files.length) void useMedia.getState().addFiles(files);
              }}
              className="space-y-3"
            >
              <a
                href="https://www.canva.com/"
                target="_blank"
                rel="noreferrer"
                className="flex w-full items-center gap-2.5 rounded-lg border border-edge bg-black/20 px-3 py-2 text-[13px] text-gray-300 hover:bg-raised hover:text-white"
              >
                <Icon name="export" className="h-4 w-4 shrink-0 text-gray-500" />
                <span className="min-w-0 flex-1 truncate">Open Canva</span>
              </a>
              <ActionButton icon="image" onClick={() => pickFile("image/*,video/*", (f) => void useMedia.getState().addFiles([f]))}>
                Import Canva export
              </ActionButton>
              <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-snug text-gray-500">
                <li>Design at {CANVAS_PX[project.aspect]} px in Canva.</li>
                <li>Choose Share, then Download, and pick PNG, JPG, GIF or MP4.</li>
                <li>Import the file here, or drop it on this card.</li>
              </ol>
            </div>
          </Card>
        </>
      )}

      {tab === "media" && (
        <>
          <Card title="Song">
            {audioItems.length > 0 ? (
              <ul className="space-y-1" aria-label="Imported audio">
                {audioItems.map((it) => {
                  const on = project.audio?.mediaId === it.id;
                  return (
                    <li key={it.id}>
                      <button
                        onClick={() => useFromPool(it)}
                        aria-pressed={on}
                        className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] ${on ? "border-accent/50 bg-accent/10 text-white" : "border-edge bg-black/20 text-gray-300 hover:bg-raised hover:text-white"}`}
                      >
                        <Icon name="music" className={`h-4 w-4 shrink-0 ${on ? "text-accent" : "text-gray-500"}`} />
                        <span className="min-w-0 flex-1 truncate">{it.name}</span>
                        {on && <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-accent" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[12px] text-gray-500">
                No audio imported yet.{" "}
                {onGoto && <button className="text-accent hover:underline" onClick={() => onGoto("import")}>Open Import</button>}
              </p>
            )}
            <ActionButton icon="music" active={!!project.audio && !project.audio.mediaId} onClick={() => pickFile("audio/*,.mp3,.wav,.m4a", chooseAudio)}>
              {project.audio && !project.audio.mediaId ? project.audio.name : "Choose another file"}
            </ActionButton>
          </Card>

          <Card title="Background">
            {visualItems.length > 0 && (
              <div>
                <span className="label">Imported</span>
                <div className="grid grid-cols-3 gap-2">
                  {visualItems.map((it) => {
                    const on = project.background.type === "asset" && project.background.asset?.mediaId === it.id;
                    return (
                      <button
                        key={it.id}
                        title={it.name}
                        aria-label={`Use ${it.name} as background`}
                        aria-pressed={on}
                        onClick={() => useFromPool(it)}
                        className={`relative aspect-square overflow-hidden rounded-lg border bg-black/40 ${on ? "border-accent ring-2 ring-accent/40" : "border-white/10 hover:border-white/30"}`}
                      >
                        <PoolThumb item={it} />
                        {it.kind === "video" && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] text-gray-200">video</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <ActionButton
              icon="image"
              active={project.background.type === "asset" && !project.background.asset?.mediaId}
              onClick={() => pickFile("image/*,video/*", chooseBackground)}
            >
              {project.background.type === "asset" && project.background.asset && !project.background.asset.mediaId ? project.background.asset.name : "Choose another file"}
            </ActionButton>
            <div>
              <span className="label">Gradients</span>
              <div className="grid grid-cols-4 gap-2">
                {GRADIENT_PRESETS.map((g) => (
                  <button
                    key={g.name}
                    title={g.name}
                    aria-label={`${g.name} gradient`}
                    className="aspect-square rounded-xl border border-white/10 ring-offset-2 ring-offset-panel hover:ring-2 hover:ring-white/30"
                    style={{ background: `linear-gradient(${g.angle}deg, ${g.colors.join(",")})` }}
                    onClick={() => (setBackground({ type: "gradient", colors: g.colors, angle: g.angle, noise: true }), useLibrary.getState().clearAsset("bg"))}
                  />
                ))}
              </div>
            </div>
          </Card>

          <Card title="Canvas">
            <Segmented label="Aspect ratio" value={project.aspect} options={ASPECTS} onChange={(a) => setAspect(a)} />
          </Card>
        </>
      )}

      {tab === "lyrics" && (
        <>
          <Card title="Lines">
            {project.layers.length > 1 && (
              <Row label="Editing layer">
                <select className="field" value={layer.id} onChange={(e) => setActiveLayer(e.target.value)}>
                  {project.layers.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </Row>
            )}
            <textarea
              className="field h-40 resize-y font-mono text-xs leading-relaxed"
              placeholder={project.layers.length > 1 ? `One line per row for "${layer.name}"` : "One lyric line per row"}
              value={linesToText(layerLines)}
              onChange={(e) => setLinesFromText(e.target.value)}
            />
            <button
              className={`${textBtn} w-full text-left`}
              onClick={() =>
                pickFile(".lrc,.srt,text/plain", async (f) => {
                  const imported = parseSubtitleFile(f.name, await f.text());
                  if (!imported.length) return alert("No timed lines found in that file.");
                  // replaces the lines of the layer being edited; other layers stay as they are
                  useProject.getState().update((p) => {
                    const lid = p.layers.some((l) => l.id === useProject.getState().activeLayerId) ? useProject.getState().activeLayerId : p.layers[0].id;
                    const others = p.lines.filter((l) => layerIdOf(p, l) !== lid);
                    return orderByLayers({ ...p, lines: [...others, ...imported.map((l) => ({ ...l, layerId: lid }))] });
                  });
                })
              }
            >
              Import .lrc or .srt file
            </button>
          </Card>

          {sel.ids.length === 1 && <LineFields id={sel.ids[0]} />}

          <Card title="Sync">
            <AutoSync />
          </Card>
        </>
      )}

      {tab === "style" && (
        <>
          <WordCard />
          <ScopeBar />

          <TemplatesCard />

          <Card title="Font">
            <PropSelect path="fontFamily" label="Typeface" options={FONTS} />
            <div className="space-y-1.5">
              <div className="flex gap-1.5">
                <input
                  className="field"
                  value={gfont}
                  placeholder="Google Fonts name, e.g. Roboto"
                  onChange={(e) => setGfont(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && useGoogleFont()}
                  aria-label="Google Fonts name"
                />
                <button className={`${textBtn} shrink-0 disabled:opacity-40`} onClick={useGoogleFont} disabled={!gfont.trim() || gfontBusy}>
                  {gfontBusy ? "Loading" : "Use"}
                </button>
              </div>
              {gfontMsg && <p className={`text-[11px] ${gfontMsg.ok ? "text-green-400" : "text-red-400"}`}>{gfontMsg.text}</p>}
            </div>
            <button className={`${textBtn} w-full text-left`} onClick={() => pickFile(".ttf,.otf", loadFont)}>Upload font file (.ttf, .otf)</button>
          </Card>

          <Card title="Text">
            <PropSlider path="fontSize" label="Size" min={24} max={240} />
            <PropColor path="color" label="Colour" />
            <PropCheck path="uppercase" label="ALL CAPS" />
            <PropSlider path="letterSpacing" label="Letter spacing" min={-5} max={30} />
            <PropSlider path="lineHeight" label="Line height" min={0.8} max={2} step={0.05} />
            <PropSlider path="maxCharsPerLine" label="Characters per line" min={8} max={60} />
          </Card>

          <Card title="Shadow">
            <PropSlider path="shadow.blur" label="Blur" min={0} max={60} />
            <PropSlider path="shadow.offsetY" label="Distance" min={-40} max={40} />
            <PropSlider path="shadow.opacity" label="Opacity" min={0} max={1} step={0.05} />
          </Card>

          <Card title="Outline">
            <PropSlider path="outline.width" label="Width" min={0} max={20} />
            <PropColor path="outline.color" label="Colour" />
          </Card>

          <Card title="Karaoke" hint="For the word highlight entrance (Motion, Animation, In): how sung words look.">
            <PropCheck path="highlight.tint" label="Colour sung words" />
            <PropColor path="highlight.color" label="Sung word colour" />
            <PropSlider path="highlight.activeScale" label="Current word size" min={100} max={160} factor={100} unit="%" />
          </Card>

          <StyleActions />
        </>
      )}

      {tab === "effects" && <EffectsPanel />}

      {tab === "motion" && (
        <>
          <ClipCard />
          <WordCard />
          <ScopeBar />

          <Card title="Position">
            <PropChoice
              path="position"
              label="Preset"
              options={POSITIONS}
              columns={3}
              onPick={(v, t) => editStyle(t, { set: [["position", v]], unset: ["transform.x", "transform.y"] })}
            />
            <PropSlider path="transform.x" label="Horizontal" min={0} max={100} factor={100} unit="%" auto={50} />
            <PropSlider path="transform.y" label="Vertical" min={0} max={100} factor={100} unit="%" auto={50} />
            <PropSlider path="transform.scale" label="Size" min={10} max={500} factor={100} unit="%" />
            <PropSlider path="transform.rotation" label="Rotation" min={-180} max={180} unit=" deg" />
            <button className={`${textBtn} w-full text-left`} onClick={() => resetFields(target, ["transform.x", "transform.y", "transform.scale", "transform.rotation"])}>
              Reset position, size and rotation
            </button>
          </Card>

          {sel.ids.length > 0 && (
            <Card title="Align to canvas">
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [["left", "Left"], ["centerX", "Centre"], ["right", "Right"], ["top", "Top"], ["centerY", "Middle"], ["bottom", "Bottom"]] as [AlignMode, string][]
                ).map(([m, l]) => (
                  <button key={m} className={`${textBtn} px-1 text-center text-[12px]`} onClick={() => alignLines(sel.ids, m)}>{l}</button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button className={`${textBtn} text-center text-[12px] disabled:opacity-40`} disabled={sel.ids.length < 3} onClick={() => distributeLines(sel.ids, "x")}>Space across</button>
                <button className={`${textBtn} text-center text-[12px] disabled:opacity-40`} disabled={sel.ids.length < 3} onClick={() => distributeLines(sel.ids, "y")}>Space down</button>
              </div>
              {sel.ids.length < 3 && <p className="text-[11px] text-gray-500">Select three or more lines to space them evenly.</p>}
            </Card>
          )}

          <AnimationCard />
          <KineticCard />
          <TransitionsCard />
          <KeyframesCard />
        </>
      )}
    </div>
  );
}

/** How lines come in, go out and keep moving. Each slot has its own effect, easing and duration. */
function AnimationCard() {
  const [slot, setSlot] = useState<"in" | "out" | "loop">("in");
  const { target, project } = useTarget();
  const name = readField(project, target, `animation.${slot}.name`).value;
  const slotNames = slot === "in" ? IN_EFFECTS : OUT_EFFECTS;
  return (
    <Card title="Animation">
      <Segmented
        label="Animation slot"
        value={slot}
        options={[{ value: "in", label: "In" }, { value: "out", label: "Out" }, { value: "loop", label: "Loop" }]}
        onChange={setSlot}
      />
      {slot === "loop" ? (
        <>
          <PropChoice path="animation.loop.name" label="Effect" options={LOOP_NAMES} />
          <PropSlider path="animation.loop.speed" label="Speed" min={0.25} max={4} step={0.25} unit="x" />
        </>
      ) : (
        <>
          <PropChoice path={`animation.${slot}.name`} label="Effect" options={slotNames} />
          <PropSelect path={`animation.${slot}.easing`} label="Easing" options={EASING_NAMES} />
          <PropSlider path={`animation.${slot}.ms`} label="Duration" min={0} max={2000} step={50} unit=" ms" zero={name === "typewriter" ? "auto" : "off"} />
          <p className="text-[11px] text-gray-500">In and out each use at most half of the line, so they never overlap.</p>
        </>
      )}
    </Card>
  );
}

/** Copy a line's look and give it to other lines. */
function StyleActions() {
  const { ids, has, project } = useTarget();
  const snap = useStyleClipboard((s) => s.snapshot);
  const primary = useProject((s) => s.selectedLineId);
  const btn = "rounded-lg border border-edge bg-black/20 px-3 py-2 text-left text-[13px] text-gray-300 hover:bg-raised hover:text-white disabled:opacity-40 disabled:hover:bg-black/20 disabled:hover:text-gray-300";
  const from = primary && project.lines.some((l) => l.id === primary) ? primary : ids[0];
  return (
    <Card title="Copy and apply">
      <div className="grid grid-cols-2 gap-1.5">
        <button className={btn} disabled={!from} onClick={() => from && copyStyle(from)}>Copy style</button>
        <button className={btn} disabled={!has || !snap} onClick={() => snap && applyStyle(ids, snap)}>Paste style</button>
        <button className={btn} disabled={!from} onClick={() => { const s = from && snapshotOf(project, from); if (s && from) applyStyle(idsOfLayer(project, from), s); }}>Apply to layer</button>
        <button className={btn} disabled={!from} onClick={() => { const s = from && snapshotOf(project, from); if (s) applyStyle(project.lines.map((l) => l.id), s); }}>Apply to all lines</button>
      </div>
      <p className="text-[11px] text-gray-500">{from ? "Uses the style of the selected line. Position is not copied." : "Select a line to copy its style."}</p>
    </Card>
  );
}

/** Text and timing of the selected line, as numbers. */
function LineFields({ id }: { id: string }) {
  const line = useProject((s) => s.project.lines.find((l) => l.id === id));
  const updateLine = useProject((s) => s.updateLine);
  if (!line) return null;
  const num = "field tabular-nums";
  return (
    <Card title="Selected line">
      <Row label="Text">
        <input className="field" value={line.text} onChange={(e) => updateLine(id, { text: e.target.value }, `text:${id}`)} />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label="Start (s)">
          <input
            type="number"
            step={0.01}
            min={0}
            className={num}
            value={Number(line.start.toFixed(2))}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) updateLine(id, { start: v, end: Math.max(line.end, v + 0.05) }, `start:${id}`);
            }}
          />
        </Row>
        <Row label="End (s)">
          <input
            type="number"
            step={0.01}
            min={0}
            className={num}
            value={Number(line.end.toFixed(2))}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > line.start) updateLine(id, { end: v }, `end:${id}`);
            }}
          />
        </Row>
      </div>
    </Card>
  );
}
