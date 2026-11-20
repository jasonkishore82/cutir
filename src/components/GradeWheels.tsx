import { useRef } from "react";
import { autoBalance, rgbToWheel, wheelToRgb } from "../lib/grade/auto";
import { scopeSource } from "../lib/scopes";
import type { Params } from "../lib/effects/types";

const WHEELS = [
  { key: "lift", label: "Lift" },
  { key: "gamma", label: "Gamma" },
  { key: "gain", label: "Gain" },
  { key: "offset", label: "Offset" },
] as const;

const num = (p: Params, k: string) => (typeof p[k] === "number" ? (p[k] as number) : 0);
const SIZE = 84;

function Wheel({ label, r, g, b, m, onPuck, onMaster, onReset }: { label: string; r: number; g: number; b: number; m: number; onPuck: (rgb: [number, number, number]) => void; onMaster: (v: number) => void; onReset: () => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [px, py] = rgbToWheel(r, g, b);
  const at = (ev: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * 2 - 1;
    const y = -(((ev.clientY - box.top) / box.height) * 2 - 1);
    onPuck(wheelToRgb(x, y));
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[11px] text-gray-400">{label}</span>
      <svg
        ref={ref}
        width={SIZE}
        height={SIZE}
        viewBox="-1.05 -1.05 2.1 2.1"
        className="touch-none cursor-crosshair"
        role="slider"
        aria-label={`${label} colour wheel`}
        aria-valuetext={`red ${r}, green ${g}, blue ${b}`}
        onPointerDown={(ev) => (ev.currentTarget.setPointerCapture(ev.pointerId), at(ev))}
        onPointerMove={(ev) => ev.buttons && at(ev)}
        onDoubleClick={onReset}
      >
        <defs>
          <radialGradient id={`wh-${label}`}>
            <stop offset="0" stopColor="#808080" />
            <stop offset="1" stopColor="#808080" stopOpacity="0" />
          </radialGradient>
        </defs>
        {Array.from({ length: 36 }, (_, i) => {
          const a0 = (i / 36) * Math.PI * 2;
          const a1 = ((i + 1.05) / 36) * Math.PI * 2;
          // hue angle matches wheelToRgb: red at 30 degrees, green at 150, blue at 270 (y is up, svg y is down)
          const theta = ((i + 0.5) / 36) * 360;
          const col = `hsl(${(theta - 30 + 360) % 360}, 70%, 45%)`;
          return <path key={i} d={`M0 0 L${Math.cos(a0)} ${-Math.sin(a0)} A1 1 0 0 0 ${Math.cos(a1)} ${-Math.sin(a1)} Z`} fill={col} />;
        })}
        <circle r="1" fill={`url(#wh-${label})`} />
        <circle r="1" fill="none" stroke="#000" strokeOpacity="0.5" strokeWidth="0.04" />
        <circle cx={px} cy={-py} r="0.09" fill="#fff" stroke="#000" strokeWidth="0.03" />
      </svg>
      <input type="range" min={-100} max={100} step={1} value={m} aria-label={`${label} master`} className="w-[84px]" onChange={(e) => onMaster(Number(e.target.value))} onDoubleClick={() => onMaster(0)} />
    </div>
  );
}

/** Round colour wheels for lift, gamma, gain and offset, plus an auto balance button (phase 20). */
export default function GradeWheels({ params, onChange }: { params: Params; onChange: (patch: Params) => void }) {
  const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-raised";
  const auto = () => {
    const src = scopeSource.canvas;
    if (!src || !src.width) return;
    const small = document.createElement("canvas");
    small.width = 192;
    small.height = Math.max(1, Math.round((192 * src.height) / src.width));
    const ctx = small.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(src, 0, 0, small.width, small.height);
    const a = autoBalance(ctx.getImageData(0, 0, small.width, small.height).data);
    const clampP = (v: number) => Math.max(-100, Math.min(100, v));
    onChange({
      gainR: clampP(num(params, "gainR") + a.gainR),
      gainG: clampP(num(params, "gainG") + a.gainG),
      gainB: clampP(num(params, "gainB") + a.gainB),
      gainM: clampP(num(params, "gainM") + a.gainM),
      offsetM: clampP(num(params, "offsetM") + a.offsetM),
    });
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 justify-items-center gap-2">
        {WHEELS.map(({ key, label }) => (
          <Wheel
            key={key}
            label={label}
            r={num(params, `${key}R`)}
            g={num(params, `${key}G`)}
            b={num(params, `${key}B`)}
            m={num(params, `${key}M`)}
            onPuck={([r, g, b]) => onChange({ [`${key}R`]: r, [`${key}G`]: g, [`${key}B`]: b })}
            onMaster={(v) => onChange({ [`${key}M`]: v })}
            onReset={() => onChange({ [`${key}R`]: 0, [`${key}G`]: 0, [`${key}B`]: 0, [`${key}M`]: 0 })}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button className={btn} onClick={auto} title="Balance the colours and stretch the levels from the frame in the viewer">Auto balance</button>
        <span className="text-[10px] text-gray-500">Drag a wheel. Double-click to reset it.</span>
      </div>
    </div>
  );
}
