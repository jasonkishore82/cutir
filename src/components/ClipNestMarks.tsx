import { useProject } from "../store/project";
import { nestedMarkers } from "../timeline/compound";
import type { Clip } from "../model/types";

/** Markers set inside a nested timeline, drawn as ticks along the top of the clip that plays it. */
export default function ClipNestMarks({ clip, pps }: { clip: Clip; pps: number }) {
  const doc = useProject((s) => s.doc);
  const marks = nestedMarkers(doc, clip);
  if (!marks.length) return null;
  return (
    <>
      {marks.map((m, i) => (
        <span key={i} title={m.name} className="pointer-events-none absolute top-0 h-2 w-[2px]" style={{ left: m.time * pps, background: m.color }} aria-hidden />
      ))}
    </>
  );
}
