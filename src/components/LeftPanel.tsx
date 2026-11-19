import { useRef, useState } from "react";
import { ensureFont, markFontReady } from "../lib/fonts";
import { parseSubtitleFile } from "../lib/subtitles";
import AutoSync from "./AutoSync";
import MediaPool from "./MediaPool";
import { useMedia, type MediaItem } from "../store/media";
import { SECTIONS, type SectionId } from "./SectionTabs";
import { ActionButton, Card, Icon, Row, Segmented, Slider } from "./ui";
import { useLibrary } from "../store/library";
import {
  layerIdOf,
  linesOfLayer,
  linesToText,
  orderByLayers,
  useProject,
  type AnimationName,
  type Aspect,
  type Position,
} from "../store/project";

const FONTS = ["Permanent Marker", "Inter", "Arial", "Georgia", "Impact", "Courier New"];
const ANIMATIONS: AnimationName[] = ["fade", "pop", "slide-up", "typewriter", "word-highlight"];
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

export default function LeftPanel({ tab }: { tab: SectionId }) {
  const project = useProject((s) => s.project);
  const activeLayerId = useProject((s) => s.activeLayerId);
  const setActiveLayer = useProject((s) => s.setActiveLayer);
  const layer = project.layers.find((l) => l.id === activeLayerId) ?? project.layers[0];
  const layerLines = linesOfLayer(project, layer.id);
  const { style } = project;
  const setStyle = useProject((s) => s.setStyle);
  const setAspect = useProject((s) => s.setAspect);
  const setBackground = useProject((s) => s.setBackground);
  const setAudio = useProject((s) => s.setAudio);
  const setLinesFromText = useProject((s) => s.setLinesFromText);
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
      setStyle({ fontFamily: family });
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
      setStyle({ fontFamily: family });
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
          <Card title="Media pool">
            <MediaPool onUse={useFromPool} />
          </Card>

          <Card title="Canva">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f && (f.type.startsWith("image/") || f.type.startsWith("video/"))) void chooseBackground(f);
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
              <ActionButton icon="image" onClick={() => pickFile("image/*,video/*", chooseBackground)}>
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
            <ActionButton icon="music" active={!!project.audio} onClick={() => pickFile("audio/*,.mp3,.wav,.m4a", chooseAudio)}>
              {project.audio ? project.audio.name : "Choose audio file"}
            </ActionButton>
          </Card>

          <Card title="Background">
            <ActionButton
              icon="image"
              active={project.background.type === "asset"}
              onClick={() => pickFile("image/*,video/*", chooseBackground)}
            >
              {project.background.type === "asset" && project.background.asset ? project.background.asset.name : "Choose image or video"}
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

          <Card title="Sync">
            <AutoSync />
          </Card>
        </>
      )}

      {tab === "style" && (
        <>
          <Card title="Font">
            <Row label="Typeface">
              <select className="field" value={style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value })}>
                {[...new Set([style.fontFamily, ...FONTS])].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </Row>
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
            <Slider label="Size" value={style.fontSize} min={24} max={240} onChange={(v) => setStyle({ fontSize: v })} />
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2.5 text-[12px] text-gray-300">
                <input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value })} aria-label="Text colour" />
                Colour
              </label>
              <label className="flex items-center gap-2 text-[12px] text-gray-300">
                <input type="checkbox" checked={style.uppercase} onChange={(e) => setStyle({ uppercase: e.target.checked })} />
                ALL CAPS
              </label>
            </div>
            <Slider label="Letter spacing" value={style.letterSpacing} min={-5} max={30} onChange={(v) => setStyle({ letterSpacing: v })} />
            <Slider label="Line height" value={style.lineHeight} min={0.8} max={2} step={0.05} onChange={(v) => setStyle({ lineHeight: v })} />
            <Slider label="Characters per line" value={style.maxCharsPerLine} min={8} max={60} onChange={(v) => setStyle({ maxCharsPerLine: v })} />
          </Card>

          <Card title="Shadow">
            <Slider label="Blur" value={style.shadow.blur} min={0} max={60} onChange={(v) => setStyle({ shadow: { ...style.shadow, blur: v } }, "shadow")} />
            <Slider label="Distance" value={style.shadow.offsetY} min={-40} max={40} onChange={(v) => setStyle({ shadow: { ...style.shadow, offsetY: v } }, "shadow")} />
            <Slider label="Opacity" value={style.shadow.opacity} min={0} max={1} step={0.05} onChange={(v) => setStyle({ shadow: { ...style.shadow, opacity: v } }, "shadow")} />
          </Card>

          <Card title="Outline">
            <Slider label="Width" value={style.outline.width} min={0} max={20} onChange={(v) => setStyle({ outline: { ...style.outline, width: v } }, "outline")} />
            <label className="flex items-center gap-2.5 text-[12px] text-gray-300">
              <input type="color" value={style.outline.color} onChange={(e) => setStyle({ outline: { ...style.outline, color: e.target.value } }, "outline")} aria-label="Outline colour" />
              Colour
            </label>
          </Card>
        </>
      )}

      {tab === "motion" && (
        <>
          <Card title="Position">
            <Segmented label="Position" value={style.position} options={POSITIONS} onChange={(p) => setStyle({ position: p })} />
          </Card>

          <Card title="Entrance">
            <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Animation">
              {ANIMATIONS.map((a) => {
                const on = style.animation === a;
                return (
                  <button
                    key={a}
                    role="radio"
                    aria-checked={on}
                    onClick={() => setStyle({ animation: a })}
                    className={`rounded-lg border px-2.5 py-2 text-left text-[13px] capitalize ${
                      on ? "border-accent/50 bg-accent/10 text-white" : "border-edge bg-black/20 text-gray-300 hover:bg-raised"
                    }`}
                  >
                    {a.replace("-", " ")}
                  </button>
                );
              })}
            </div>
            <Slider label="Speed" value={style.animationMs} min={0} max={1000} step={50} unit=" ms" onChange={(v) => setStyle({ animationMs: v })} />
          </Card>
        </>
      )}
    </div>
  );
}
