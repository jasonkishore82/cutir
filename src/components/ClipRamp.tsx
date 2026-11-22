import { rampCurve } from "../lib/retime";
import type { Clip } from "../model/types";

/** The speed ramp of a clip drawn along its bottom edge: the curve of the speed, with a line where normal speed falls. */
export default function ClipRamp({ clip, pps }: { clip: Clip; pps: number }) {
  if (!clip.ramp?.keys.length) return null;
  const width = Math.max(2, clip.duration * pps);
  const { points, base } = rampCurve(clip.ramp, clip.duration, Math.min(96, Math.max(8, Math.round(width / 4))));
  const h = 14;
  const d = points.map((p, i) => `${i ? "L" : "M"}${(p.x * width).toFixed(1)} ${(h - p.y * h).toFixed(1)}`).join(" ");
  return (
    <svg className="pointer-events-none absolute bottom-0 left-0" width={width} height={h} aria-hidden>
      <rect width={width} height={h} fill="rgba(0,0,0,0.25)" />
      <line x1={0} x2={width} y1={h - base * h} y2={h - base * h} stroke="rgba(255,255,255,0.35)" strokeDasharray="2 2" />
      <path d={d} fill="none" stroke="#fde047" strokeWidth={1.5} />
    </svg>
  );
}
