import { useRef, type ReactNode } from "react";
import { parseSubtitleFile } from "../lib/subtitles";
import AutoSync from "./AutoSync";
import {
  linesToText,
  useProject,
  type AnimationName,
  type Aspect,
  type Position,
} from "../store/project";

const FONTS = ["Permanent Marker", "Inter", "Arial", "Georgia", "Impact", "Courier New"];
const ANIMATIONS: AnimationName[] = ["fade", "pop", "slide-up", "typewriter", "word-highlight"];
const POSITIONS: Position[] = ["top", "center", "bottom"];
const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

const GRADIENT_PRESETS: { name: string; colors: string[]; angle: number }[] = [
  { name: "Sunset", colors: ["#1e2a6b", "#5b3a8c", "#d4687a", "#f0a070"], angle: 135 },
  { name: "Ocean", colors: ["#0b132b", "#1c2541", "#3a6ea5", "#6fffe9"], angle: 160 },
  { name: "Neon", colors: ["#12002b", "#6a00f4", "#f20089"], angle: 120 },
  { name: "Mono", colors: ["#111111", "#444444"], angle: 90 },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="p-3 border-b border-edge">
      <h3 className="text-xs font-semibold text-gray-300 mb-2">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <Row label={`${props.label}: ${props.value}`}>
      <input
        type="range"
        className="w-full accent-[#e0709a]"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </Row>
  );
}

function pickFile(accept: string, onFile: (f: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => input.files?.[0] && onFile(input.files[0]);
  input.click();
}

export default function LeftPanel() {
  const project = useProject((s) => s.project);
  const { style } = project;
  const setStyle = useProject((s) => s.setStyle);
  const setAspect = useProject((s) => s.setAspect);
  const setBackground = useProject((s) => s.setBackground);
  const setAudio = useProject((s) => s.setAudio);
  const setLinesFromText = useProject((s) => s.setLinesFromText);
  const lastAudioUrl = useRef<string>();

  const loadAudio = (f: File) => {
    if (lastAudioUrl.current) URL.revokeObjectURL(lastAudioUrl.current);
    lastAudioUrl.current = URL.createObjectURL(f);
    setAudio({ name: f.name, kind: "audio", url: lastAudioUrl.current });
  };

  const loadBackground = (f: File) => {
    const kind = f.type.startsWith("video") ? "video" : "image";
    setBackground({ type: "asset", asset: { name: f.name, kind, url: URL.createObjectURL(f) } });
  };

  const loadFont = async (f: File) => {
    const family = f.name.replace(/\.[^.]+$/, "");
    try {
      const face = new FontFace(family, await f.arrayBuffer());
      await face.load();
      document.fonts.add(face);
      setStyle({ fontFamily: family });
    } catch {
      alert("Could not load that font file.");
    }
  };

  const btn = "w-full px-2 py-1.5 text-xs rounded border border-edge hover:bg-edge text-left truncate";

  return (
    <div className="text-sm">
      <Section title="Audio">
        <button className={btn} onClick={() => pickFile("audio/*,.mp3,.wav,.m4a", loadAudio)}>
          {project.audio ? `♪ ${project.audio.name}` : "Upload audio (mp3/wav/m4a)"}
        </button>
      </Section>

      <Section title="Background">
        <button className={btn} onClick={() => pickFile("image/*,video/*", loadBackground)}>
          {project.background.type === "asset" && project.background.asset
            ? project.background.asset.name
            : "Upload image / video loop"}
        </button>
        <div className="grid grid-cols-4 gap-1">
          {GRADIENT_PRESETS.map((g) => (
            <button
              key={g.name}
              title={g.name}
              className="h-8 rounded border border-edge"
              style={{ background: `linear-gradient(${g.angle}deg, ${g.colors.join(",")})` }}
              onClick={() => setBackground({ type: "gradient", colors: g.colors, angle: g.angle, noise: true })}
            />
          ))}
        </div>
      </Section>

      <Section title="Lyrics">
        <textarea
          className="field h-32 resize-y font-mono text-xs"
          placeholder="One lyric line per row"
          value={linesToText(project.lines)}
          onChange={(e) => setLinesFromText(e.target.value)}
        />
        <button
          className={btn}
          onClick={() =>
            pickFile(".lrc,.srt,text/plain", async (f) => {
              const lines = parseSubtitleFile(f.name, await f.text());
              if (!lines.length) return alert("No timed lines found in that file.");
              useProject.getState().update((p) => ({ ...p, lines }));
            })
          }
        >
          Import .lrc / .srt
        </button>
        <AutoSync />
      </Section>

      <Section title="Aspect ratio">
        <div className="flex gap-1">
          {ASPECTS.map((a) => (
            <button
              key={a}
              onClick={() => setAspect(a)}
              className={`flex-1 py-1 text-xs rounded border ${
                project.aspect === a ? "border-accent text-accent" : "border-edge hover:bg-edge"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Text style">
        <Row label="Font">
          <select className="field" value={style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value })}>
            {[...new Set([style.fontFamily, ...FONTS])].map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Row>
        <button className={btn} onClick={() => pickFile(".ttf,.otf", loadFont)}>Upload font (.ttf/.otf)</button>

        <Slider label="Size" value={style.fontSize} min={24} max={240} onChange={(v) => setStyle({ fontSize: v })} />
        <div className="flex items-center gap-3">
          <Row label="Color">
            <input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value })} />
          </Row>
          <label className="flex items-center gap-1 text-xs mt-4">
            <input type="checkbox" checked={style.uppercase} onChange={(e) => setStyle({ uppercase: e.target.checked })} />
            Uppercase
          </label>
        </div>
        <Slider label="Letter spacing" value={style.letterSpacing} min={-5} max={30} onChange={(v) => setStyle({ letterSpacing: v })} />
        <Slider label="Line height" value={style.lineHeight} min={0.8} max={2} step={0.05} onChange={(v) => setStyle({ lineHeight: v })} />
        <Slider label="Max chars / line" value={style.maxCharsPerLine} min={8} max={60} onChange={(v) => setStyle({ maxCharsPerLine: v })} />
      </Section>

      <Section title="Shadow">
        <Slider label="Blur" value={style.shadow.blur} min={0} max={60} onChange={(v) => setStyle({ shadow: { ...style.shadow, blur: v } }, "shadow")} />
        <Slider label="Offset Y" value={style.shadow.offsetY} min={-40} max={40} onChange={(v) => setStyle({ shadow: { ...style.shadow, offsetY: v } }, "shadow")} />
        <Slider label="Opacity" value={style.shadow.opacity} min={0} max={1} step={0.05} onChange={(v) => setStyle({ shadow: { ...style.shadow, opacity: v } }, "shadow")} />
      </Section>

      <Section title="Outline">
        <Slider label="Width" value={style.outline.width} min={0} max={20} onChange={(v) => setStyle({ outline: { ...style.outline, width: v } }, "outline")} />
        <input type="color" value={style.outline.color} onChange={(e) => setStyle({ outline: { ...style.outline, color: e.target.value } }, "outline")} />
      </Section>

      <Section title="Position & animation">
        <Row label="Position">
          <select className="field" value={style.position} onChange={(e) => setStyle({ position: e.target.value as Position })}>
            {POSITIONS.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Row>
        <Row label="Animation">
          <select className="field" value={style.animation} onChange={(e) => setStyle({ animation: e.target.value as AnimationName })}>
            {ANIMATIONS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </Row>
        <Slider label="Duration (ms)" value={style.animationMs} min={0} max={1000} step={50} onChange={(v) => setStyle({ animationMs: v })} />
      </Section>
    </div>
  );
}
