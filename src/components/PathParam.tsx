import { useRef } from "react";
import { insidePolygon, nearestPoint, smoothSegments, type Pt } from "../lib/masks";

/** Edits a closed mask path on a small frame: click to add a point, drag to move one, double-click to remove it (three stay). */
export default function PathParam({ label, value, smooth, onChange }: { label: string; value: Pt[]; smooth: boolean; onChange: (v: Pt[]) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const W = 160;
  const H = 90;
  const at = (e: React.PointerEvent): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.min(1.5, Math.max(-0.5, (e.clientX - r.left) / r.width)), Math.min(1.5, Math.max(-0.5, (e.clientY - r.top) / r.height))];
  };
  const d = (() => {
    if (value.length < 3) return "";
    if (!smooth) return `M${value.map((p) => `${p[0] * W} ${p[1] * H}`).join(" L")} Z`;
    const s = smoothSegments(value, true)!;
    return `M${s.start[0] * W} ${s.start[1] * H} ` + s.segs.map((g) => `C${g.c1[0] * W} ${g.c1[1] * H} ${g.c2[0] * W} ${g.c2[1] * H} ${g.to[0] * W} ${g.to[1] * H}`).join(" ") + " Z";
  })();
  /** Where a new point goes: after the nearest point along the outline. */
  const insertAt = (p: Pt): Pt[] => {
    let best = 0;
    let bd = Infinity;
    value.forEach((a, i) => {
      const b = value[(i + 1) % value.length];
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      const dd = Math.hypot(mx - p[0], my - p[1]);
      if (dd < bd) (bd = dd), (best = i);
    });
    return [...value.slice(0, best + 1), p, ...value.slice(best + 1)];
  };
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <span className="text-[10px] text-gray-500">{value.length} points</span>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="aspect-video w-full max-w-[240px] touch-none rounded-md border border-edge bg-black/30"
        onPointerDown={(e) => {
          const p = at(e);
          const hit = nearestPoint(value, p[0], p[1], 0.05);
          if (hit >= 0) drag.current = hit;
          else {
            const next = insertAt(p);
            drag.current = next.findIndex((q) => q === p);
            onChange(next);
          }
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const p = at(e);
          onChange(value.map((q, i) => (i === drag.current ? p : q)));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        role="img"
        aria-label={`${label}: ${insidePolygon(value, 0.5, 0.5) ? "centre inside" : "centre outside"}`}
      >
        <path d={d} fill="#ffffff22" stroke="#9ca3af" strokeWidth={1.5} />
        {value.map((p, i) => (
          <circle key={i} cx={p[0] * W} cy={p[1] * H} r={4} fill="#0b0b0f" stroke="#facc15" strokeWidth={1.5} onDoubleClick={() => value.length > 3 && onChange(value.filter((_, j) => j !== i))} />
        ))}
      </svg>
    </div>
  );
}
