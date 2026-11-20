import { useRef } from "react";
import { evalCurve, type CurvePoints } from "../lib/grade/math";

/**
 * A small curve editor for colour curves: click empty space to add a point, drag a point to move it, double-click a
 * point to remove it. `flat` curves (hue vs ...) have 0.5 as "no change" and are drawn with that centre line.
 */
export default function CurveParam({ label, value, onChange, flat = false, tint = "#9ca3af" }: { label: string; value: CurvePoints; onChange: (v: CurvePoints) => void; flat?: boolean; tint?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const S = 120;
  const pts = [...value].sort((a, b) => a[0] - b[0]) as CurvePoints;
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))] as [number, number];
  };
  const path = Array.from({ length: 61 }, (_, i) => `${i ? "L" : "M"}${(i / 60) * S} ${(1 - Math.min(1, Math.max(0, evalCurve(pts, i / 60)))) * S}`).join(" ");
  const reset = flat ? [[0, 0.5], [1, 0.5]] : [[0, 0], [1, 1]];
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <button className="text-[10px] text-gray-500 hover:text-gray-200" onClick={() => onChange(reset as CurvePoints)}>reset</button>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${S} ${S}`}
        className="aspect-square w-full max-w-[160px] touch-none rounded-md border border-edge bg-black/30"
        onPointerDown={(e) => {
          const [x, y] = at(e);
          const hit = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 0.07);
          if (hit >= 0) drag.current = hit;
          else {
            const next = [...pts, [x, y]].sort((a, b) => a[0] - b[0]) as CurvePoints;
            drag.current = next.findIndex((p) => p[0] === x && p[1] === y);
            onChange(next);
          }
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const [x, y] = at(e);
          const i = drag.current;
          const lo = i > 0 ? pts[i - 1][0] + 0.01 : 0;
          const hi = i < pts.length - 1 ? pts[i + 1][0] - 0.01 : 1;
          const next = pts.map((p, j) => (j === i ? ([i === 0 || i === pts.length - 1 ? p[0] : Math.min(hi, Math.max(lo, x)), y] as [number, number]) : p)) as CurvePoints;
          onChange(next);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        role="img"
        aria-label={`${label} curve`}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="#ffffff14">
            <line x1={g * S} y1={0} x2={g * S} y2={S} />
            <line x1={0} y1={g * S} x2={S} y2={g * S} />
          </g>
        ))}
        {!flat && <line x1={0} y1={S} x2={S} y2={0} stroke="#ffffff22" strokeDasharray="3 3" />}
        <path d={path} fill="none" stroke={tint} strokeWidth={1.8} />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p[0] * S}
            cy={(1 - p[1]) * S}
            r={4}
            fill="#0b0b0f"
            stroke={tint}
            strokeWidth={1.6}
            onDoubleClick={() => pts.length > 2 && onChange(pts.filter((_, j) => j !== i) as CurvePoints)}
          />
        ))}
      </svg>
    </div>
  );
}
